// Voice conversation mode: push-to-talk turns with barge-in.
//
// One key drives the whole loop and its meaning is always the same: the user
// wants the floor. What the key actually does depends on the state shown in
// the toast:
//
//   press -> record -> press -> transcribe -> normalize -> submit
//         -> wait reply -> speak -> press -> record ...
//
// - paused + key: open the mic (the resting state is the user's turn)
// - recording + key: finish the turn and submit
// - speaking/waiting + key: barge in - cut the audio, drop the pending reply,
//   open the mic (one press, never a stop-then-record dance)
// - processing + key: transcription is too short to interrupt, report busy
//
// The loop never reopens the mic by itself: after a reply is spoken the mode
// rests paused, so it can never record the room while nobody is talking. That
// auto-record is also why a question/permission gate used to eat the answer -
// the mic opened, the user's muttering was submitted, and the real reply was
// already torn down. Gates now announce and wait instead.
//
// Exit paths: a stop phrase ("stop", "dừng lại", ...), /voice-conversation-stop,
// or the global /voice-cancel. Empty or failed turns pause instead of
// auto-recording, so the key never surprises.
//
// Latency vs. honesty: the turn is voiced only after the whole execution
// (tool calls included) completes, so what is read aloud is the answer and
// never mid-turn commentary.

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

// Small vocabulary so stuttered/short stop commands ("stop stop", "please stop
// the conversation now", "dừng lại đi") still match, while real sentences
// ("stop the server", "do not stop") fall through and get submitted.

const STOP_VOCAB = new Set(
  (
    "stop stops stopping please now exit quit quits quitting end ends ending finish " +
    "conversation voice chat goodbye bye good the this that it turn off mode " +
    "dừng lại kết thúc hội thoại thoát tạm biệt đi ra ngừng ngưng thôi"
  ).split(" "),
);
const MAX_STOP_WORDS = 5;

export function matchesStopPhrase(text, phrases) {
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  if ((phrases ?? DEFAULT_STOP_PHRASES).some((p) => normalizePhrase(p) === normalized)) return true;
  // Lenient vocab match only applies to the default list; a custom list takes
  // full control with exact matching.
  if (phrases !== undefined) return false;
  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 && words.length <= MAX_STOP_WORDS && words.every((w) => STOP_VOCAB.has(w))
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerConversation(api, opts, logger, { stt, tts, isLiveNotesActive }) {
  const maxTurns = Number(opts?.conversationMaxTurns) > 0 ? Number(opts.conversationMaxTurns) : 50;
  const replyTimeoutMs =
    Number(opts?.conversationTimeoutMs) > 0 ? Number(opts.conversationTimeoutMs) : 300000;
  const restartDelayMs =
    Number(opts?.conversationRestartDelayMs) >= 0 ? Number(opts.conversationRestartDelayMs) : 350;
  // Keep undefined when the user supplied nothing so matchesStopPhrase
  // takes the lenient default-vocabulary path ("stop stop", "dừng lại đi").
  // Passing DEFAULT_STOP_PHRASES explicitly would disable it.
  const stopPhrases = Array.isArray(opts?.conversationStopPhrases)
    ? opts.conversationStopPhrases
    : undefined;

  let active = false;
  let phase = "idle"; // idle | recording | processing | waiting | speaking | paused

  // Event subscriptions owned by the current wait/probe set. Nothing is
  // spoken from live deltas: the agent's commentary during tool calls is not
  // the answer, so only the completed turn is voiced (see speakReply).
  let streamUnsubs = [];
  let speakGen = 0;

  let turn = 0;
  let consecErrors = 0;
  let generation = 0;
  let waitCancel = null;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // v2 persistent status line: phase-aware buttons. v1 has no surface, so
  // these are no-ops there (api.conversationStatus is undefined).
  const convStatus = api.conversationStatus || null;
  const clog = (m) => {
    try {
      stt.log?.(m);
    } catch {}
  };
  const setConvPhase = api.setConvPhase || (() => {});
  const setConvActions = api.setConvActions || (() => {});
  function convBegin() {
    try {
      const p = convStatus?.begin?.();
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch {}
  }
  function convUpdate() {
    try {
      convStatus?.update?.();
    } catch {}
  }
  function convClear() {
    try {
      convStatus?.clear?.();
    } catch {}
  }
  function convSetPhase(p) {
    try {
      setConvPhase(p);
      convUpdate();
    } catch {}
  }
  function convSetActions(actions) {
    try {
      setConvActions(actions);
    } catch {}
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
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) return;
    turn += 1;
    phase = "recording";
    clog(`Conversation turn ${turn} listening`);
    const streamingMode = (api?.kv?.get?.("stt.mode") ?? opts?.sttMode) === "streaming";
    // Allow streaming STT during conversation for waveform + live transcript.
    try {
      stt.setConversationStreamingEnabled?.(true);
    } catch {}
    const autoEnd = api?.kv?.get?.("stt.autoEndOfSpeech") === true;
    if (streamingMode) {
      // Register the stop callback even when auto-end is off: the preview
      // toggle can turn auto-end on mid-recording, and the STT timer must
      // then finish this turn through the conversation loop instead of
      // submitting the text as plain dictation (which skips the reply wait,
      // the speech, and leaves the UI on "Listening").
      const onStreamAutoStop = () => {
        clog(`Conversation streaming auto-finalize callback active=${active} phase=${phase}`);
        if (active && phase === "recording") {
          clog("Conversation auto-finalize on silence (streaming)");
          void finishTurnFlow();
        }
      };
      stt.setConversationStreamingFinalize?.(autoEnd ? 2.5 : null, onStreamAutoStop);
      const started = stt.startStreaming?.();
      if (!started) {
        // Fallback to batch recording.
        stt.setConversationStreamingFinalize?.(null, null);
        if (autoEnd) {
          stt.setSilenceAutoFinalize?.(2.5, () => {
            if (active && phase === "recording") {
              clog("Conversation auto-finalize on silence");
              finishTurnFlow();
            }
          });
        } else {
          stt.setSilenceAutoFinalize?.(null, null);
        }
        if (!stt.start()) {
          phase = "idle";
          stop("busy");
          toast("STT busy, conversation off", "warning");
          return;
        }
      }
    } else {
      if (autoEnd) {
        stt.setSilenceAutoFinalize?.(2.5, () => {
          if (active && phase === "recording") {
            clog("Conversation auto-finalize on silence");
            finishTurnFlow();
          }
        });
      } else {
        stt.setSilenceAutoFinalize?.(null, null);
      }
      if (!stt.start()) {
        phase = "idle";
        stop("busy");
        toast("STT busy, conversation off", "warning");
        return;
      }
    }
    convSetActions({
      cancel: () => {
        if (phase === "recording") {
          try {
            stt.cancelStreaming?.();
          } catch {}
          stt.cancel();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      send: () => {
        if (phase === "recording") finishTurnFlow();
      },
    });
    convSetPhase("recording");
    toast(
      autoEnd
        ? `Listening - speak, then pause 2.5s to send (or press ${keyLabel()})`
        : `Listening - press ${keyLabel()} to send`,
    );
  }

  // The resting state: mic closed, one press to talk. Entered by start() and
  // after a reply is spoken, never by the loop auto-recording.

  function enterPaused() {
    phase = "paused";
    convSetActions({
      talk: () => {
        if (phase === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    toast(`Press ${keyLabel()} to talk`);
  }

  // One press takes the floor: cut whatever audio is queued or playing, drop
  // the pending reply, and open the mic. The mode stays on - a press always
  // means "I want to talk now", so it must never exit silently.

  function bargeIn() {
    clog("Conversation barge-in");
    stt.setSilenceAutoFinalize?.(null, null);
    stt.setConversationStreamingFinalize?.(null, null);
    try {
      stt.cancelStreaming?.();
    } catch {}
    discardStreamAudio();
    clearProcessingToast();
    // Settle the pending reply wait as "stopped" so the abandoned answer is
    // never flushed into the mic we are about to open.
    if (waitCancel) {
      waitCancel("stopped");
      waitCancel = null;
    }
    beginTurn();
  }

  function endReplyStream() {
    for (const unsub of streamUnsubs) {
      try {
        unsub();
      } catch {}
    }
    streamUnsubs = [];
  }

  // Kill streamed audio without touching the loop state. Queued sentences
  // are invalidated so they never resume after a stop. The caller decides
  // what happens next (legacy speak, notification, or exit).

  function discardStreamAudio() {
    endReplyStream();
    speakGen += 1;
    tts.stop();
  }

  function stop(reason) {
    if (!active) return;
    active = false;
    generation += 1;
    phase = "idle";
    stt.setSilenceAutoFinalize?.(null, null);
    stt.setConversationStreamingFinalize?.(null, null);
    try {
      stt.setConversationStreamingEnabled?.(false);
    } catch {}
    if (waitCancel) {
      waitCancel("stopped");
      waitCancel = null;
    }
    endReplyStream();
    speakGen += 1;
    stt.setStopHint(null);
    try {
      stt.cancelStreaming?.();
    } catch {}
    if (stt.isRecording() || stt.isProcessing()) stt.cancel();
    clearProcessingToast();
    tts.stop();
    tts.setConversationActive(false);
    convClear();
    clog(`Conversation stopped reason=${reason}`);
  }

  // Wait for the submitted turn to finish: idle, a permission/question gate,
  // or timeout. Resolves early when stop() cancels the wait. gates:false drops
  // the permission/question subscriptions, so a second wait survives the gate
  // the user is answering on screen and only ends on idle/timeout/stop.
  //
  // Completion is a host fact, not a guess: v2 emits
  // `session.execution.succeeded|failed|interrupted` only when the whole
  // execution - tool calls included - ends. The message list is the fallback
  // signal, and BOTH paths are gated on `baseline` (the message count taken
  // before submit), so a finished assistant message from an earlier turn can
  // never be mistaken for this turn's reply. That gate is the fix for the
  // reply being read ~800ms early with zero assistant messages in it.

  function waitForReply(sessionID, { gates = true, baseline = 0 } = {}) {
    let settled = false;
    let unsubs = [];
    let timer = null;
    let pollTimer = null;
    let settleTimer = null;
    let currentExecutionID = null;
    let sawExecutionStart = false;

    const resolveSessionID = () => (typeof sessionID === "function" ? sessionID() : sessionID);
    const baselineFor = (sid) => (typeof baseline === "function" ? baseline(sid) : baseline);

    // Assistant messages that arrived AFTER submit, oldest first.
    const newAssistants = () => {
      try {
        const sid = resolveSessionID();
        const msgs = api?.state?.session?.messages?.(sid) || [];
        return msgs.slice(baselineFor(sid)).filter((m) => m?.role === "assistant");
      } catch {
        return [];
      }
    };
    const isTerminal = (finish) => !!finish && finish !== "tool-calls" && finish !== "tool_calls";
    const lastFinish = () => {
      const list = newAssistants();
      return list.length ? list[list.length - 1]?.finish : null;
    };
    const turnFinished = () => isTerminal(lastFinish());

    let cancelFn = null;
    const done = (outcome) => {
      if (settled) return null;
      settled = true;
      if (timer) clearTimeout(timer);
      if (settleTimer) clearInterval(settleTimer);
      if (pollTimer) clearInterval(pollTimer);
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

      // The host event can land a beat before the message cache does. Give the
      // message at most 2s to appear, then settle anyway: the execution is
      // over, and "no reply to speak" is a truthful outcome.
      const settle = (outcome) => {
        if (settled) return;
        if (turnFinished()) {
          finish(outcome);
          return;
        }
        if (settleTimer) return;
        const startedAt = Date.now();
        settleTimer = setInterval(() => {
          if (settled) return;
          if (turnFinished() || Date.now() - startedAt > 2000) {
            clog(`Conversation settled outcome=${outcome} finish=${lastFinish() ?? "none"}`);
            finish(outcome);
          }
        }, 100);
        if (typeof settleTimer.unref === "function") settleTimer.unref();
      };

      const forSession = (props) => {
        const sid = props?.sessionID ?? props?.id ?? props?.session?.id;
        const expectedID = resolveSessionID();
        if (typeof sessionID === "function" && !expectedID) return true;
        if (!expectedID) return true;
        if (!sid) return true;
        return sid === expectedID;
      };

      const executionIDOf = (props) =>
        props?.executionID ?? props?.executionId ?? props?.id ?? props?.execution?.id;

      const onExecutionEnd = (outcome) => (event) => {
        const props = event?.properties || event?.data || {};
        if (!forSession(props)) return;
        const eid = executionIDOf(props);
        if (currentExecutionID && eid && eid !== currentExecutionID) {
          clog(
            `Conversation execution ${outcome} ignored stale id=${eid} current=${currentExecutionID}`,
          );
          return;
        }
        // The host's execution events carry no execution id, so the guard is
        // structural: a terminal event is only trusted once this wait has seen
        // execution.started, or once this turn's own assistant message is
        // there with a terminal finish. Otherwise it is a late event from the
        // turn that barge-in interrupted.
        if (!sawExecutionStart && !turnFinished()) {
          clog(`Conversation execution ${outcome} ignored (no start, no new assistant)`);
          return;
        }
        clog(`Conversation execution ${outcome} id=${eid ?? "none"}`);
        settle(outcome);
      };

      unsubs = [
        api.event.on("session.execution.started", (event) => {
          const props = event?.properties || event?.data || {};
          if (!forSession(props)) return;
          const eid = executionIDOf(props);
          if (eid) currentExecutionID = eid;
          sawExecutionStart = true;
          clog(`Conversation execution.started id=${eid ?? "none"}`);
        }),
        api.event.on("session.execution.succeeded", onExecutionEnd("idle")),
        api.event.on("session.execution.failed", onExecutionEnd("idle")),
        api.event.on("session.execution.interrupted", onExecutionEnd("stopped")),
        // Legacy fallbacks, only trusted once this turn's assistant message
        // actually exists with a terminal finish.
        api.event.on("session.idle", (event) => {
          const props = event?.properties || event?.data || {};
          if (!forSession(props)) return;
          if (!turnFinished()) {
            clog(`Conversation session.idle ignored finish=${lastFinish() ?? "none"}`);
            return;
          }
          finish("idle");
        }),
        api.event.on("session.status", (event) => {
          const props = event?.properties || event?.data || {};
          if (props?.status?.type !== "idle" || !forSession(props)) return;
          if (!turnFinished()) {
            clog(`Conversation session.status idle ignored finish=${lastFinish() ?? "none"}`);
            return;
          }
          finish("idle");
        }),
        ...(gates
          ? [
              api.event.on("permission.asked", (event) => {
                if (forSession(event.properties)) finish("permission");
              }),
              api.event.on("question.asked", (event) => {
                if (forSession(event.properties)) finish("question");
              }),
            ]
          : []),
      ];
      timer = setTimeout(() => finish("timeout"), replyTimeoutMs);
      // Last resort when the host emits no execution event at all.
      pollTimer = setInterval(() => {
        if (settled) return;
        try {
          const fr = lastFinish();
          clog(`Conversation poll new=${newAssistants().length} finish=${fr ?? "none"}`);
          if (isTerminal(fr)) settle("idle");
        } catch {}
      }, 700);
      if (typeof pollTimer.unref === "function") pollTimer.unref();
    });

    return promise;
  }

  async function finishTurnFlow() {
    clog(
      `Conversation finishTurnFlow called active=${active} phase=${phase} streaming=${stt.isStreaming?.()}`,
    );
    if (!active || phase !== "recording") return;
    stt.setSilenceAutoFinalize?.(null, null);
    stt.setConversationStreamingFinalize?.(null, null);
    const myGen = generation;
    phase = "processing";
    convSetActions({
      cancel: () => {
        // Processing is too short to cancel safely; report busy.
      },
    });
    convSetPhase("processing");
    showProcessingToast("Transcribing...");

    let res = null;
    if (stt.isStreaming?.()) {
      try {
        res = await stt.finalizeStreaming?.({ submit: false, insert: false });
      } catch (e) {
        res = { error: e };
      }
    } else {
      res = await stt.transcribeTurn();
    }
    if (!active || myGen !== generation) return;

    if (!res) {
      pauseForRetry(`Paused - press ${keyLabel()} to retry`);
      return;
    }
    if (res.error) {
      consecErrors += 1;
      clog(`Conversation turn error consec=${consecErrors}`);
      if (consecErrors >= 2) {
        stop("error");
        return;
      }
      pauseForRetry(`Paused - press ${keyLabel()} to retry`);
      return;
    }
    if (!res.text || res.text.trim().length < 3) {
      consecErrors = 0;
      pauseForRetry(`No speech heard - press ${keyLabel()} to try again`);
      return;
    }
    consecErrors = 0;

    if (matchesStopPhrase(res.text, stopPhrases)) {
      stt.discard();
      stop("stop phrase");
      toast("Conversation off");
      return;
    }

    // Baseline: how many messages the session already holds BEFORE submit.
    // Only messages after this index belong to this turn. A session created by
    // the submit itself did not exist yet, so its baseline is 0.
    const baselineSessionID = currentSessionID();
    let baselineCount = 0;
    if (baselineSessionID) {
      try {
        baselineCount = (api?.state?.session?.messages?.(baselineSessionID) || []).length;
      } catch {
        baselineCount = 0;
      }
    }
    const baselineFor = (sid) => (sid && sid === baselineSessionID ? baselineCount : 0);
    clog(`Conversation baseline sid=${baselineSessionID ?? "new"} count=${baselineCount}`);

    // v2 prompt dispatch may emit the entire reply before its promise returns.
    // Home creation navigates before prompting, so resolve the ID at event time.
    let earlyWait = null;
    if (api.client?.tui?.v2) {
      phase = "waiting";
      convSetActions({
        cancel: () => {},
        barge: () => bargeIn(),
      });
      convSetPhase("waiting");
      earlyWait = waitForReply(currentSessionID, { baseline: baselineFor });
    }
    const submitted = await stt.submitTurnText(res.text);
    if (!active || myGen !== generation) return;
    if (submitted.error) {
      stop("submit failed");
      return;
    }

    phase = "waiting";
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    const sessionID = currentSessionID();
    showProcessingToast(`Working - press ${keyLabel()} to talk`);
    const tWait = Date.now();
    const outcome = await (earlyWait || waitForReply(sessionID, { baseline: baselineFor }));
    const waitMs = Date.now() - tWait;
    endReplyStream();
    logger?.log("VOICE", `Conversation wait outcome=${outcome} waitMs=${waitMs}`, "debug");
    if (!active || myGen !== generation) return;

    if (outcome === "timeout") {
      discardStreamAudio();
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    if (outcome === "permission" || outcome === "question") {
      await answerGateThenSpeak(myGen, sessionID, baselineFor, outcome);
      return;
    }
    if (outcome === "stopped") return;

    await speakReply(myGen);
  }

  // A permission/question gate is answered ON SCREEN, so the mic must stay
  // shut. Announce the gate, then re-arm the reply stream and wait for the
  // agent to resume so its post-answer reply is spoken aloud - before this,
  // endReplyStream() had already run and the answer was dropped in silence.

  async function answerGateThenSpeak(myGen, sessionID, baseline, outcome) {
    discardStreamAudio();
    phase = "speaking";
    convSetActions({
      stop: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
    });
    convSetPhase("speaking");
    showProcessingToast("Speaking...");
    await tts.speak(
      outcome === "permission"
        ? "Permission requested. Please check your screen."
        : "A question needs your answer. Please check your screen.",
    );
    clearProcessingToast();
    if (!active || myGen !== generation || phase !== "speaking") return;

    // Still "waiting": the user answers on screen, and a press here is an
    // ordinary barge-in (drop the pending reply, open the mic).
    phase = "waiting";
    convSetActions({
      cancel: () => {},
      barge: () => bargeIn(),
    });
    convSetPhase("waiting");
    showProcessingToast(`Answer on screen - press ${keyLabel()} to talk`);
    const resumed = await waitForReply(sessionID, { gates: false, baseline });
    if (!active || myGen !== generation) return;
    if (resumed === "stopped") return;
    endReplyStream();
    if (resumed === "timeout") {
      discardStreamAudio();
      stop("timeout");
      toast("No reply in time, conversation off", "warning");
      return;
    }
    await speakReply(myGen);
  }

  // Speak whatever this turn produced, then rest paused with the mic OFF.
  // Only the completed turn is voiced: live deltas during tool calls are
  // commentary, not the answer, and speaking them reads half a thought aloud.
  // Returns early on any generation/phase change (barge-in, stop).

  async function speakReply(myGen) {
    clog(`Conversation speakReply entry myGen=${myGen} gen=${generation} phase=${phase}`);
    phase = "speaking";
    convSetActions({
      stop: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
      barge: () => bargeIn(),
      pauseTts: () => {
        if (phase === "speaking") {
          tts.stop();
          phase = "paused";
          convSetPhase("paused");
        }
      },
    });
    convSetPhase("speaking");
    showProcessingToast(`Speaking - press ${keyLabel()} to interrupt`);
    clog("Conversation: calling tts.speakAssistantTurn");
    const spoken = await tts.speakAssistantTurn();
    clog(`Conversation: speakAssistantTurn returned spoken=${spoken?.spoken}`);
    if (!active || myGen !== generation || phase !== "speaking") return;
    // Drop the sticky speaking status before the paused toast, or it keeps
    // re-announcing "interrupt" once the mic is closed again.
    clearProcessingToast();
    if (!spoken.spoken) {
      toast("No reply to speak", "warning");
    }
    await delay(restartDelayMs);
    if (!active || myGen !== generation || phase !== "speaking") return;
    enterPaused();
    if (!spoken.spoken) return;
    // Hands-free: auto-listen after a successful reply.
    await delay(500);
    if (!active || myGen !== generation || phase !== "paused") return;
    beginTurn();
  }

  // Pause instead of auto-recording so an empty or failed turn never feels
  // like the keypress was ignored.

  function pauseForRetry(message) {
    if (!active) return;
    phase = "paused";
    if (message) toast(message, "warning");
  }

  // Stop speech and hold the mode, mic still closed. The next keypress records
  // again. Only the TTS stop key lands here; the conversation key barges in.

  function pauseSpeech() {
    if (!active || phase !== "speaking") return;
    clog("Conversation speech paused");
    tts.stop();
    phase = "paused";
    toast(`Speech paused - press ${keyLabel()} to talk`);
  }

  // Called by the TTS stop command while the mode is on. Returns true when the
  // keypress was consumed (speech paused), so TTS skips its own handling.

  function onTtsStop() {
    if (!active) return false;
    if (phase === "speaking") {
      pauseSpeech();
      return true;
    }
    // Mid-stream the agent is still working and cannot pause, so the stop key
    // exits the mode instead of leaving a half-heard reply behind.
    if (phase === "waiting" && tts.isSpeaking?.()) {
      stop("cancelled");
      toast("Conversation off");
      return true;
    }
    return false;
  }

  // One press, one meaning: "I want the floor". The source key (record,
  // submit, toggle) no longer changes the outcome, and a press never exits.

  function onKey() {
    if (!active) {
      start();
      return;
    }
    if (phase === "recording") {
      finishTurnFlow();
      return;
    }
    if (phase === "speaking" || phase === "waiting") {
      bargeIn();
      return;
    }
    if (phase === "paused") {
      beginTurn();
      return;
    }
    // processing | idle: the transcription in flight is too short to interrupt.
    toast("Conversation busy, please wait...", "warning");
  }

  function start() {
    if (active) return;
    if (isLiveNotesActive?.()) {
      toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
      return;
    }
    if (stt.isRecording() || stt.isProcessing() || stt.isStreaming?.()) {
      toast("STT busy, try again shortly", "warning");
      return;
    }
    active = true;
    generation += 1;
    turn = 0;
    consecErrors = 0;
    phase = "paused";
    tts.setConversationActive(true);
    convBegin();
    convSetActions({
      talk: () => {
        if (phase === "paused") beginTurn();
      },
      end: () => stop("user"),
    });
    convSetPhase("paused");
    // Recording toasts must name the key the user actually has bound.
    stt.setStopHint(kb("voice.conversation"));
    clog("Conversation started");
    toast(`Conversation on - press ${keyLabel()} to talk`);
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

  // Every toast names the key that acts, resolved from the user's keybinds
  // instead of the default literal - a rebound key must never be announced as
  // something the user does not have.
  function keyLabel() {
    return kb("voice.conversation") || "the key";
  }

  const commands = [
    {
      title: "Voice: conversation mode",
      value: "voice.conversation",
      category: "opencode-voice",
      description:
        "Toggle voice conversation (push-to-talk: press to record, press again to send, press while it speaks to interrupt)",
      ...(kb("voice.conversation") ? { keybind: kb("voice.conversation") } : {}),
      slash: { name: "voice-conversation" },
      onSelect() {
        onKey();
      },
    },
    {
      title: "Voice: stop conversation",
      value: "voice.conversation-stop",
      category: "opencode-voice",
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

  const controller = { isActive, onKey, onTtsStop, start, stop };

  return { commands, controller };
}
