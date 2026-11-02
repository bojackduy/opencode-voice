import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceActions } from "../lib/voice/voice-actions.js";

function makeCtx() {
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(t) } };
  const kv = { get: () => undefined, set: () => {} };
  return { api, kv, toasts };
}

function makeStt() {
  const calls = [];
  return {
    isRecording: () => false,
    isProcessing: () => false,
    isStreaming: () => false,
    cancel: () => calls.push("cancel"),
    cancelStreaming: async () => calls.push("cancelStreaming"),
    _calls: calls,
  };
}

function makeTts() {
  const calls = [];
  return {
    isSpeaking: () => false,
    stop: () => calls.push("stop"),
    pause: () => true,
    resume: () => true,
    getState: () => ({ status: "idle" }),
    _calls: calls,
  };
}

test("mode() reports conversation when active", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = {
    isActive: () => true,
    getPhase: () => "paused",
    onKey: () => {},
    onTtsStop: () => false,
    stop: () => {},
  };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "conversation");
});

test("mode() reports notes when live notes active", () => {
  const { api, kv } = makeCtx();
  const conv = { isActive: () => false };
  const notes = { isActive: () => true };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: notes,
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "notes");
});

test("mode() reports idle otherwise", () => {
  const { api, kv } = makeCtx();
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  assert.equal(actions.mode(), "idle");
});

test("toggleSpeak in idle calls recordCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { recordCmd: () => calls.push("record") },
  });
  actions.toggleSpeak();
  assert.deepEqual(calls, ["record"]);
});

test("toggleSpeak in conversation delegates to onKey(record)", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const conv = { isActive: () => true, onKey: (s) => calls.push(s) };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.toggleSpeak();
  assert.deepEqual(calls, ["record"]);
});

test("toggleSpeak in notes toasts stop-notes", () => {
  const { api, kv, toasts } = makeCtx();
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => true },
    kv,
    api,
    cmds: {},
  });
  actions.toggleSpeak();
  assert.ok(toasts.some((t) => /stop live notes/i.test(t.message)));
});

test("speakReply in conversation paused calls speakLastCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("speakLast") },
  });
  actions.speakReply();
  assert.deepEqual(calls, ["speakLast"]);
});

test("speakReply in conversation speaking toasts agent-holds-floor", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "speaking" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.speakReply();
  assert.ok(toasts.some((t) => /agent holds the floor/i.test(t.message)));
});

test("speakReply in conversation recording toasts mic-is-yours", () => {
  const { api, kv, toasts } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "recording" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  actions.speakReply();
  assert.ok(toasts.some((t) => /mic is yours/i.test(t.message)));
});

test("speakReply in idle calls speakLastCmd", () => {
  const { api, kv } = makeCtx();
  const calls = [];
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: { isActive: () => false },
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("speakLast") },
  });
  actions.speakReply();
  assert.deepEqual(calls, ["speakLast"]);
});

test("stopAll cancels TTS and conversation when active", async () => {
  const { api, kv, toasts } = makeCtx();
  const tts = makeTts();
  tts.isSpeaking = () => true;
  const conv = { isActive: () => true, stop: () => {} };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts,
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  const cancelled = await actions.stopAll();
  assert.ok(cancelled.includes("TTS"));
  assert.ok(cancelled.includes("conversation"));
  assert.ok(toasts.some((t) => /Cancelled/.test(t.message)));
});

test("getPhase is exposed on conversation controller", () => {
  // Smoke: the controller shape check is covered by conversation tests;
  // here we just assert the dispatcher reads it.
  const { api, kv } = makeCtx();
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const actions = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: {},
  });
  // speakReply paused path requires getPhase
  const calls = [];
  const a2 = createVoiceActions({
    stt: makeStt(),
    tts: makeTts(),
    conversation: conv,
    liveNotes: { isActive: () => false },
    kv,
    api,
    cmds: { speakLastCmd: () => calls.push("x") },
  });
  a2.speakReply();
  assert.deepEqual(calls, ["x"]);
});

test("toggleAutoSubmit flips the stt.autoSubmit kv the reader checks", async () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(t) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  const { toggleAutoSubmit, isAutoSubmit } = createVoiceActions({ kv, api });
  assert.equal(isAutoSubmit(), false);
  toggleAutoSubmit();
  assert.equal(store.get("stt.autoSubmit"), true);
  // Writer and reader must agree on the key (a past bug wrote stt.ctx.autoSubmit).
  const { resolveSttAutoSubmit } = await import("../lib/stt.js");
  assert.equal(resolveSttAutoSubmit({}, kv), true);
  toggleAutoSubmit();
  assert.equal(isAutoSubmit(), false);
});

test("toggleAutoSubmit warns it does not apply in conversation mode", () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(typeof t === "string" ? t : t?.message) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  const conv = { isActive: () => true, getPhase: () => "paused" };
  const { toggleAutoSubmit } = createVoiceActions({ kv, api, conversation: conv });
  toggleAutoSubmit();
  assert.equal(store.get("stt.autoSubmit"), true, "stored value still flips for later");
  assert.ok(toasts.some((t) => /conversation/i.test(t)), "warned it only affects dictation");
});

test("correct routes to the command in idle, refuses in conversation", () => {
  const store = new Map();
  const toasts = [];
  const api = { ui: { toast: (t) => toasts.push(typeof t === "string" ? t : t?.message) } };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
  let corrected = 0;
  const idle = createVoiceActions({ kv, api, cmds: { correctCmd: () => void corrected++ } });
  idle.correct();
  assert.equal(corrected, 1);
  const conv = createVoiceActions({
    kv,
    api,
    conversation: { isActive: () => true, getPhase: () => "paused" },
    cmds: { correctCmd: () => void corrected++ },
  });
  conv.correct();
  assert.equal(corrected, 1, "conversation mode must not trigger correction");
  assert.ok(toasts.some((t) => /dictation/i.test(t)));
});
