import assert from "node:assert/strict";
import test from "node:test";

import { getVoiceProviderSelection, resolveVoiceProviderModel } from "../lib/shared/voice-model.js";

function makeKv(store = {}) {
  return {
    get: (key, fallback = null) => (key in store ? store[key] : fallback),
    set: (key, value) => {
      store[key] = value;
    },
  };
}

const api = {
  state: {
    provider: [
      {
        id: "p1",
        name: "Provider One",
        env: ["P1_KEY"],
        options: {},
        models: {
          m1: { id: "m1", name: "Model One", api: { url: "https://p1.test/v1" } },
        },
      },
    ],
  },
};

test("reads the voice provider selection from kv", () => {
  assert.deepEqual(getVoiceProviderSelection(makeKv({})), null);
  assert.deepEqual(
    getVoiceProviderSelection(makeKv({ "voice.providerID": "p1", "voice.modelID": "m1" })),
    { providerID: "p1", modelID: "m1" },
  );
});

test("resolves the selection against live providers", () => {
  const kv = makeKv({ "voice.providerID": "p1", "voice.modelID": "m1" });
  const resolved = resolveVoiceProviderModel(api, kv);
  assert.equal(resolved.provider.id, "p1");
  assert.equal(resolved.model.id, "m1");
});

test("returns null for stale selections", () => {
  assert.equal(
    resolveVoiceProviderModel(api, makeKv({ "voice.providerID": "nope", "voice.modelID": "m1" })),
    null,
  );
  assert.equal(
    resolveVoiceProviderModel(api, makeKv({ "voice.providerID": "p1", "voice.modelID": "nope" })),
    null,
  );
});

test("no explicit pick follows the session's running model", () => {
  const running = {
    ...api,
    state: {
      ...api.state,
      model: { current: () => ({ providerID: "p1", modelID: "m1" }) },
    },
  };
  const resolved = resolveVoiceProviderModel(running, makeKv({}));
  assert.equal(resolved.provider.id, "p1");
  assert.equal(resolved.model.id, "m1");
});

test("explicit /voice-model pick still wins over the running model", () => {
  const running = {
    ...api,
    state: {
      ...api.state,
      model: { current: () => ({ providerID: "p1", modelID: "other" }) },
    },
  };
  const kv = makeKv({ "voice.providerID": "p1", "voice.modelID": "m1" });
  const resolved = resolveVoiceProviderModel(running, kv);
  assert.equal(resolved.model.id, "m1");
});

test("no selection and no running model returns null", () => {
  const bare = { ...api, state: { ...api.state, model: { current: () => null } } };
  assert.equal(resolveVoiceProviderModel(bare, makeKv({})), null);
});
