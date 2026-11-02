import test from "node:test";
import assert from "node:assert/strict";

import { adaptV2Context } from "../lib/host/v2-compat.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

// Two plugin instances sharing one storage backend, like two TUI sessions.
function makeCtx(shared) {
  return {
    storage: {
      store: () => {
        const update = async (mut) => void mut(shared);
        return [shared, update];
      },
    },
    ui: {
      toast: { show: () => {} },
      dialog: {},
      router: { current: () => ({ type: "home" }) },
    },
    renderer: null,
    client: { session: {} },
    theme: {},
    event: { on: () => () => {} },
    keymap: { layer: () => {} },
  };
}

test("a toggle in one session is visible in the other", async () => {
  const shared = { values: {} };
  const a = adaptV2Context(makeCtx(shared));
  const b = adaptV2Context(makeCtx(shared));
  a.api.kv.set("stt.autoSubmit", true);
  await tick();
  assert.equal(b.api.kv.get("stt.autoSubmit"), true, "sibling session sees the toggle");
  b.api.kv.set("stt.autoSubmit", false);
  await tick();
  assert.equal(a.api.kv.get("stt.autoSubmit"), false, "and back again");
});
