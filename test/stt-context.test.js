import test from "node:test";
import assert from "node:assert/strict";

import { registerSTT } from "../lib/stt.js";

function makeStubApi() {
  const kvStore = new Map();
  const kv = {
    get: (key, fallback) => (kvStore.has(key) ? kvStore.get(key) : fallback),
    set: (key, value) => kvStore.set(key, value),
  };
  const toasts = [];
  const api = {
    client: {},
    kv,
    renderer: null,
    ui: { toast: (t) => toasts.push(t) },
    voicePreview: null,
    lifecycle: { onDispose: () => {} },
    route: { current: null },
    event: { on: () => () => {} },
  };
  return { api, kv, toasts, kvStore };
}

test("stt context: registerSTT exposes startTurn on the controller", () => {
  const { api, kv } = makeStubApi();
  const { controller } = registerSTT(api, kv, async () => ({}), {}, {}, { log: () => {} });
  assert.equal(typeof controller.startTurn, "function");
  assert.equal(typeof controller.setAutoEnd, "function");
  assert.equal(typeof controller.endTurn, "function");
  assert.equal(typeof controller.cancelTurnCleanup, "function");
  assert.equal(typeof controller.isRecording, "function");
  assert.equal(typeof controller.isProcessing, "function");
  assert.equal(typeof controller.isStreaming, "function");
});

test("stt context: startTurn returns {ok, streaming} and is batch by default", async () => {
  // Route the capture command at /bin/true: a real startTurn spawns the
  // capture process, and the default remote-ssh fallback would hang the
  // test file on a dead connection. `true` exits instantly with no audio.
  const prev = process.env.STT_CAPTURE_CMD;
  process.env.STT_CAPTURE_CMD = JSON.stringify(["true"]);
  try {
    const { api, kv } = makeStubApi();
    const { controller } = registerSTT(api, kv, async () => ({}), {}, {}, { log: () => {} });
    const r = controller.startTurn({ streaming: false, autoEnd: false, source: "dictation" });
    assert.ok(r && typeof r.ok === "boolean");
    assert.equal(r.streaming, false);
    try {
      controller.cancel();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    if (prev === undefined) delete process.env.STT_CAPTURE_CMD;
    else process.env.STT_CAPTURE_CMD = prev;
  }
});

test("stt context: setAutoEnd / endTurn / cancelTurnCleanup do not throw", () => {
  const { api, kv } = makeStubApi();
  const { controller } = registerSTT(api, kv, async () => ({}), {}, {}, { log: () => {} });
  controller.setAutoEnd(true, () => {});
  controller.setAutoEnd(false, null);
  controller.endTurn();
  controller.cancelTurnCleanup();
  // no throw = pass
});

test("stt context: context object is attached to the returned value", () => {
  const { api, kv } = makeStubApi();
  const result = registerSTT(api, kv, async () => ({}), {}, {}, { log: () => {} });
  assert.ok(result.context, "registerSTT must attach a context");
  assert.equal(result.context.api, api);
  assert.equal(result.context.kv, kv);
  assert.ok(result.context.controller === result.controller);
});
