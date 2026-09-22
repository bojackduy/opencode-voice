// Voice conversation mode: hands-free talk loop with OpenCode.
//
// Press the conversation key to enter the mode, speak, press again to send.
// The turn is transcribed, normalized, submitted immediately, the reply is
// waited on, spoken aloud, and recording restarts automatically:
//
//   record -> transcribe -> normalize -> submit -> wait reply -> speak -> record ...
//
// Press the key while speaking to barge in (stop speech, record next turn).
// Press the key while waiting/processing to exit. Saying a stop phrase
// ("stop", "dừng lại", ...) ends the mode without submitting.

import { clearProcessingToast, showProcessingToast } from "./stt.js";

export const DEFAULT_STOP_PHRASES = [
  "stop",
  "exit",
  "quit",
  "stop conversation",
  "exit conversation",
  "end conversation",
  "goodbye",
  "bye",
  "dừng lại",
  "dừng",
  "kết thúc",
  "kết thúc hội thoại",
  "thoát",
  "tạm biệt",
];

export function normalizePhrase(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!…?]+$/u, "")
    .replace(/\s+/g, " ");
}

export function matchesStopPhrase(text, phrases = DEFAULT_STOP_PHRASES) {
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  return phrases.some((p) => normalizePhrase(p) === normalized);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerConversation(api, opts, logger, { stt, tts }) {
  const maxTurns = Number(opts?.conversationMaxTurns) > 0 ? Number(opts.conversationMaxTurns) : 50;
  const replyTimeoutMs =
    Number(opts?.conversationTimeoutMs) > 0 ? Number(opts.conversationTimeoutMs) : 300000;
  const restartDelayMs =
    Number(opts?.conversationRestartDelayMs) >= 0 ? Number(opts.conversationRestartDelayMs) : 350;
  const stopPhrases = Array.isArray(opts?.conversationStopPhrases)
    ? opts.conversationStopPhrases
    : DEFAULT_STOP_PHRASES;

  let active = false;
  let phase = "idle"; // idle | recording | processing | waiting | speaking
  let turn = 0;
  let consecErrors = 0;
  let generation = 0;
  let waitCancel = null;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function currentSessionID() {
    const route = api?.route?.current;
    return route?.name === "session" ? route?.params?.sessionID : null;
  }

  function isActive() {
    return active;
  }

  function beginTurn() {
    if (!active) return;
    if (turn >= maxTurns) {
      stop("done");
      toast(`Conversation off - reached ${maxTurns} turns`);
      return;
    }
    if (stt.isRecording() || stt.isProcessing()) return;
    turn += 1;
    phase = "recording";
    logger?.log("VOICE", `Conversation turn ${turn} listening`, "debug");
    if (!stt.start()) {
      phase = "idle";
      stop("busy");
      toast("STT busy, conversation off", "warning");
    }
  }

  function stop(reason) {
    if (!active) return;
    active = false;
    generation += 1;
    phase = "idle";
    if (waitCancel) {
      waitCancel("stopped");
      waitCancel = null;
    }
    if (stt.isRecording() || stt.isProcessing()) stt.cancel();
    clearProcessingToast();
    tts.stop();
    tts.setConversationActive(false);
    logger?.log("VOICE", `Conversation stopped reason=${reason}`, "debug");
  }

  // Wait for the submitted turn to finish: idle, a permission/question gate,
  // or timeout. Resolves early when stop() cancels the wait.

  function waitForReply(sessionID) {
    let settled = false;
    let unsubs = [];
    let timer = null;

    let cancelFn = null;
    const done = (outcome) => {
      if (settled) return null;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
      unsubs = [];
      if (waitCancel === cancelFn) waitCancel = null;
      return outcome;
    };

    const promise = new Promise((resolve) => {
      const finish = (outcome) => {
        const result = done(outcome);
        if (result !== null) resolve(result);
      };
      cancelFn = (outcome) => finish(outcome || "stopped");
      waitCancel = cancelFn;

      const forSession = (props) =>
        !sessionID || !props?.sessionID || props.sessionID === sessionID;

      unsubs = [
        api.event.on("session.idle", (event) => {
          if (forSession(event.properties)) finish("idle");
        }),
        api.event.on("session.status", (event) => {
          if (event.properties?.status?.type === "idle" && forSession(event.properties)) {
            finish("idle");
          }
        }),
        api.event.on("permission.asked", (event) => {
          if (forSession(event.properties)) finish("permission");
        }),
        api.event.on("question.asked", (event) => {
          if (forSession(event.properties)) finish("question");
        }),
      ];
      timer = setTimeout(() => finish("timeout"), replyTimeoutMs);
    });

    return promise;
  }

  async function finishTurnFlow() {
    if (!active || phase !== "recording") return;
    const myGen = generation;
    phase = "processing";

    const res = await stt.transcribeTurn();
    if (!active || myGen !== generation) return;

    if (res.error) {
      consecErrors += 1;
      logger?.log("VOICE", `Conversation turn error consec=${consecErrors}`, "warn");
      if (consecErrors >= 2) {
        stop("error");
        return;
      }
      beginTurn();
      return;
    }
    if (!res.text) {
      consecErrors = 0;
      beginTurn();
      return;
    }
    consecErrors = 0;

    if (matchesStopPhrase(res.text, stopPhrases)) {
      stt.discard();
      stop("stop phrase");
      toast("Conversation off");
      return;
    }

    const submitted = await stt.submitTurnText(res.text);
    if (!active || myGen !== generation) return;
    if (submitted.error) {
      stop("submit failed");
      return;
    }

    phase = "waiting";
    const sessionID = currentSessionID();
    showProcessingToast("Waiting for reply...");
    const outcome = await waitForReply(sessionID);
    if (!active || myGen !== generation) return;

    if (outcome === "timeout") {
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    if (outcome === "permission" || outcome === "question") {
      phase = "speaking";
      showProcessingToast("Speaking...");
      await tts.speak(
        outcome === "permission"
          ? "Permission requested. Please check your screen."
          : "A question needs your answer. Please check your screen.",
      );
      clearProcessingToast();
      if (!active || myGen !== generation || phase !== "speaking") return;
      beginTurn();
      return;
    }
    if (outcome === "stopped") return;

    phase = "speaking";
    const spoken = await tts.speakAssistantTurn();
    if (!active || myGen !== generation || phase !== "speaking") return;
    if (!spoken.spoken) {
      toast("No reply to speak, listening again", "warning");
    }
    await delay(restartDelayMs);
    if (!active || myGen !== generation || phase !== "speaking") return;
    beginTurn();
  }

  function bargeIn() {
    if (!active || phase !== "speaking") return;
    logger?.log("VOICE", "Conversation barge-in", "debug");
    tts.stop();
    beginTurn();
  }

  function onKey(source) {
    if (!active) {
      start();
      return;
    }
    if (phase === "recording") {
      finishTurnFlow();
      return;
    }
    if (phase === "speaking") {
      if (source === "toggle") {
        bargeIn();
      } else {
        toast("Speaking - press the conversation key to interrupt", "warning");
      }
      return;
    }
    // processing | waiting | idle
    if (source === "toggle") {
      stop("cancelled");
      toast("Conversation off");
    } else {
      toast("Conversation busy, please wait...", "warning");
    }
  }

  function start() {
    if (active) return;
    if (stt.isRecording() || stt.isProcessing()) {
      toast("STT busy, try again shortly", "warning");
      return;
    }
    active = true;
    generation += 1;
    turn = 0;
    consecErrors = 0;
    phase = "idle";
    tts.setConversationActive(true);
    logger?.log("VOICE", "Conversation started", "debug");
    toast("Conversation on - speak, press the key to send");
    beginTurn();
  }

  api.lifecycle?.onDispose?.(() => stop("dispose"));

  const DEFAULT_KEYBINDS = {
    "voice.conversation": "<leader>v",
  };
  function kb(value) {
    const overrides = opts?.keybinds;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      return DEFAULT_KEYBINDS[value];
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, value)) return DEFAULT_KEYBINDS[value];
    const v = overrides[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  const commands = [
    {
      title: "Voice: conversation mode",
      value: "voice.conversation",
      description:
        "Toggle hands-free voice conversation (record, auto-submit, speak reply, repeat)",
      ...(kb("voice.conversation") ? { keybind: kb("voice.conversation") } : {}),
      slash: { name: "voice-conversation" },
      onSelect() {
        onKey("toggle");
      },
    },
    {
      title: "Voice: stop conversation",
      value: "voice.conversation-stop",
      description: "Exit voice conversation mode",
      slash: { name: "voice-conversation-stop" },
      onSelect() {
        if (active) {
          stop("command");
          toast("Conversation off");
        }
      },
    },
  ];

  const controller = { isActive, onKey, start, stop };

  return { commands, controller };
}
