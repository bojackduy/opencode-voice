// Lifecycle regression: plugin re-registration must not leak event handlers.
// Repro for the TTS auto-handler leak: registerTTS subscribes to 4 session
// events and the dispose hook never unsubscribed them, so a second registration
// (resumed session / reload) doubled auto-TTS speech and fired stale handlers
// cross-session.
import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../index.js";
import { registerTTS } from "../lib/tts.js";

const CONFIGURED_OPTIONS = {
  endpoint: "https://opencode.ai/zen/v1",
  model: "space-bunny-free",
  apiKeyEnv: "OPENCODE_GO_KEY",
  useResponsesApi: true,
  sttAutoSubmit: true,
  sttMode: "streaming",
  ttsEngine: "chatterbox",
  ttsChatterboxPython: "/Users/duytrinh/.local/share/opencode-voice/chatterbox-venv/bin/python",
};

function makeHost() {
  const handlers = new Map();
  const disposes = [];
  const store = new Map();
  const api = {
    client: {},
    route: { current: { name: "session", params: { sessionID: "ses_A" } } },
    state: { session: { messages: () => [] }, path: { directory: "/tmp" } },
    event: {
      on: (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
        return () => {
          const arr = handlers.get(name) || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    ui: { toast: () => {}, dialog: {} },
    lifecycle: { onDispose: (fn) => disposes.push(fn) },
    command: { register: () => {} },
  };
  const kv = {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => store.set(k, v),
  };
  api.kv = kv;
  const logger = { log: () => {} };
  const count = () => {
    let n = 0;
    for (const arr of handlers.values()) n += arr.length;
    return n;
  };
  return { api, kv, logger, handlers, disposes, count };
}

test("registerTTS removes its event handlers on dispose", async () => {
  const host = makeHost();
  const complete = async () => ({ text: null, error: "unavailable" });
  registerTTS(host.api, host.kv, complete, undefined, {}, host.logger);
  assert.ok(host.count() > 0, "expected TTS to subscribe to session events");
  for (const fn of host.disposes) await fn();
  assert.equal(host.count(), 0, "TTS handlers survive dispose");
});

test("full plugin re-registration leaves no stale handlers behind", async () => {
  const first = makeHost();
  await plugin.tui(first.api, CONFIGURED_OPTIONS);
  const initCount = first.count();
  assert.ok(initCount > 0, "expected plugin to subscribe to session events");
  for (const fn of first.disposes) await fn();
  assert.equal(first.count(), 0, "first registration handlers survive dispose");

  const second = makeHost();
  await plugin.tui(second.api, CONFIGURED_OPTIONS);
  assert.equal(second.count(), initCount, "re-registration changed handler count");
  for (const fn of second.disposes) await fn();
  assert.equal(second.count(), 0, "second registration handlers survive dispose");
});
