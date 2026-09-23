import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STOP_PHRASES,
  matchesStopPhrase,
  normalizePhrase,
  registerConversation,
} from "../lib/conversation.js";

test("normalizes phrases for comparison", () => {
  assert.equal(normalizePhrase("  Stop... "), "stop");
  assert.equal(normalizePhrase("DỪNG LẠI!"), "dừng lại");
  assert.equal(normalizePhrase("Exit   Conversation "), "exit conversation");
});

test("matches exact stop phrases only", () => {
  assert.equal(matchesStopPhrase("stop"), true);
  assert.equal(matchesStopPhrase("Stop."), true);
  assert.equal(matchesStopPhrase("dừng lại"), true);
  assert.equal(matchesStopPhrase("KẾT THÚC"), true);
  assert.equal(matchesStopPhrase("goodbye!"), true);
});

test("matches stuttered and padded stop commands", () => {
  assert.equal(matchesStopPhrase("stop stop"), true);
  assert.equal(matchesStopPhrase("stop stop stopping"), true);
  assert.equal(matchesStopPhrase("please stop the conversation now"), true);
  assert.equal(matchesStopPhrase("dừng lại đi"), true);
  assert.equal(matchesStopPhrase("thôi"), true);
});

test("does not match speech containing stop words", () => {
  assert.equal(matchesStopPhrase("please stop the server"), false);
  assert.equal(matchesStopPhrase("do not stop"), false);
  assert.equal(matchesStopPhrase("stop the deployment right now please sir"), false);
  assert.equal(matchesStopPhrase(""), false);
  assert.equal(matchesStopPhrase(null), false);
});

test("supports custom phrase lists", () => {
  assert.equal(matchesStopPhrase("halt", ["halt"]), true);
  assert.equal(matchesStopPhrase("stop", ["halt"]), false);
});

test("default list covers both languages", () => {
  assert.ok(DEFAULT_STOP_PHRASES.includes("stop"));
  assert.ok(DEFAULT_STOP_PHRASES.includes("dừng lại"));
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeHarness({ transcribe = { text: "hello" } } = {}) {
  const toasts = [];
  const handlers = {};
  const api = {
    ui: { toast: (input) => toasts.push(input?.message ?? input) },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    event: {
      on: (type, handler) => {
        (handlers[type] ??= []).push(handler);
        return () => {};
      },
    },
    lifecycle: {},
  };
  const calls = { sttStart: 0, ttsStop: 0, speakTurn: 0, submitted: [] };
  let speakGate = null;
  const stt = {
    isRecording: () => false,
    isProcessing: () => false,
    start: () => {
      calls.sttStart += 1;
      return true;
    },
    setStopHint: () => {},
    cancel: () => {},
    discard: () => {},
    transcribeTurn: () =>
      transcribe && typeof transcribe.then === "function"
        ? transcribe
        : Promise.resolve({ ...transcribe }),
    submitTurnText: async (text) => {
      calls.submitted.push(text);
      return { text };
    },
  };
  const tts = {
    speak: async () => {},
    speakAssistantTurn: async () => {
      calls.speakTurn += 1;
      if (speakGate) await speakGate;
      return { spoken: true };
    },
    stop: () => {
      calls.ttsStop += 1;
      return true;
    },
    isSpeaking: () => false,
    setConversationActive: () => {},
  };
  const { controller } = registerConversation(
    api,
    { conversationTimeoutMs: 60, conversationRestartDelayMs: 5 },
    null,
    { stt, tts },
  );
  return {
    api,
    toasts,
    handlers,
    calls,
    controller,
    setSpeakGate: (p) => {
      speakGate = p;
    },
  };
}

function fireIdle(h, sessionID = "s1") {
  for (const handler of h["session.idle"] || []) {
    handler({ properties: { sessionID } });
  }
}

test("full turn loops back to recording", async () => {
  const h = makeHarness();
  h.controller.onKey("toggle");
  assert.equal(h.calls.sttStart, 1);
  h.controller.onKey("toggle");
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  fireIdle(h.handlers);
  await tick(30);
  assert.equal(h.calls.speakTurn, 1);
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("speaking + key pauses, next key records again", async () => {
  const h = makeHarness();
  let release;
  h.setSpeakGate(new Promise((r) => (release = r)));
  h.controller.onKey("toggle");
  h.controller.onKey("toggle");
  await tick(30);
  fireIdle(h.handlers);
  await tick(20);
  assert.equal(h.calls.speakTurn, 1);
  h.controller.onKey("toggle");
  assert.equal(h.calls.ttsStop, 1);
  assert.ok(h.toasts.some((t) => t.includes("Paused")));
  release();
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
  h.controller.onKey("toggle");
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("empty turn pauses instead of re-recording", async () => {
  const h = makeHarness({ transcribe: { text: null, empty: true } });
  h.controller.onKey("toggle");
  h.controller.onKey("toggle");
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
  assert.ok(h.toasts.some((t) => t.includes("No speech")));
  h.controller.onKey("toggle");
  assert.equal(h.calls.sttStart, 2);
  h.controller.stop("test");
});

test("toggle while waiting exits and drops the late reply", async () => {
  const h = makeHarness();
  h.controller.onKey("toggle");
  h.controller.onKey("toggle");
  await tick(30);
  assert.deepEqual(h.calls.submitted, ["hello"]);
  h.controller.onKey("toggle");
  assert.ok(h.toasts.includes("Conversation off"));
  fireIdle(h.handlers);
  await tick(30);
  assert.equal(h.calls.speakTurn, 0);
});

test("exit during processing cancels the turn", async () => {
  let resolveTranscribe;
  const pending = new Promise((r) => (resolveTranscribe = r));
  const h = makeHarness({ transcribe: pending });
  h.controller.onKey("toggle");
  h.controller.onKey("toggle");
  await tick(10);
  h.controller.onKey("toggle");
  assert.ok(h.toasts.includes("Conversation off"));
  resolveTranscribe({ text: "late hello" });
  await tick(20);
  assert.deepEqual(h.calls.submitted, []);
});

test("tts stop key pauses speaking, ignored when inactive", async () => {
  const h = makeHarness();
  assert.equal(h.controller.onTtsStop(), false);
  let release;
  h.setSpeakGate(new Promise((r) => (release = r)));
  h.controller.onKey("toggle");
  h.controller.onKey("toggle");
  await tick(30);
  fireIdle(h.handlers);
  await tick(20);
  assert.equal(h.controller.onTtsStop(), true);
  assert.equal(h.calls.ttsStop, 1);
  release();
  await tick(20);
  assert.equal(h.calls.sttStart, 1);
  h.controller.stop("test");
});
