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
import { createConvContext } from "./conversation/context.js";
import { createConversationLoop } from "./conversation/loop.js";
import { createCommands } from "./conversation/commands.js";

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
  const stopPhrases = Array.isArray(opts?.conversationStopPhrases)
    ? opts.conversationStopPhrases
    : undefined;

  const ctx = createConvContext({
    api,
    opts,
    logger,
    stt,
    tts,
    isLiveNotesActive: isLiveNotesActive || (() => false),
    maxTurns,
    replyTimeoutMs,
    restartDelayMs,
    stopPhrases,
    state: {},
  });

  const loop = createConversationLoop(ctx);
  ctx.loop = loop;

  const commands = createCommands(ctx, loop);

  const controller = {
    isActive: loop.isActive,
    onKey: (source) => loop.onKey(source),
    onTtsStop: loop.onTtsStop,
    start: loop.start,
    stop: (reason) => loop.stop(reason),
    getPhase: loop.getPhase,
  };

  api.lifecycle?.onDispose?.(() => loop.stop("dispose"));

  return { commands, controller };
}
