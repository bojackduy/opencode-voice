import test from "node:test";
import assert from "node:assert/strict";
import { createV2Preview } from "../lib/v2-preview.js";
import { adaptV2Context } from "../lib/v2-compat.js";
import { registerSTT } from "../lib/stt.js";

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function host() {
  const claims = [];
  const effects = [];
  const frames = [];
  const prompts = [];
  const disposes = [];
  let route = { type: "home" };
  const ctx = {
    client: {
      session: {
        create: async () => ({ id: "new-live-session" }),
        prompt: async (input) => {
          prompts.push(input);
        },
      },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (next) => {
          route = next;
        },
      },
      toast: { show() {} },
      dialog: { alert() {} },
      slot: (claim) => {
        claims.push(claim);
        return () => claims.splice(claims.indexOf(claim), 1);
      },
    },
    storage: { store: () => [{ values: {} }, () => {}] },
  };
  const runtime = {
    createSignal(initial) {
      let value = initial;
      return [
        () => value,
        (next) => {
          value = next;
          for (const effect of effects) effect();
        },
      ];
    },
    createElement: () => ({}),
    insertNode() {},
    insert(node, value) {
      node.content = value;
      frames.push(value);
      return value;
    },
    setProp(node, key, value) {
      node[key] = value;
      if (key === "content") frames.push(value);
    },
    createEffect(fn) {
      effects.push(fn);
      fn();
    },
  };
  const adapted = adaptV2Context(ctx);
  adapted.api.voicePreview = createV2Preview(ctx, async () => runtime);
  adapted.api.lifecycle.onDispose(() => adapted.api.voicePreview.clear());
  return { ctx, claims, frames, prompts, disposes, adapted };
}

test("v2 slot preview distinguishes stable/tentative, bounds display, clears claims", async () => {
  const h = host();
  const preview = h.adapted.api.voicePreview;
  await preview.begin();
  assert.deepEqual(
    h.claims.map((c) => c.after || c.before),
    ["prompt.footer"],
  );
  for (const c of h.claims) c.render();
  preview.applyPartial({ stableText: "confirmed words", tentativeText: "uncertain tail" });
  assert.match(h.frames.at(-1), /confirmed words \[uncertain tail\]/);
  preview.applyPartial({ stableText: "long ".repeat(800), tentativeText: "tail" });
  assert.ok(h.frames.at(-1).length <= 1600);
  assert.ok(preview.getTranscript().length > 1600, "full final text is never truncated");
  preview.cancel();
  assert.equal(h.claims.length, 0);
  const before = h.frames.length;
  preview.applyPartial({ stableText: "late" });
  assert.equal(h.frames.length, before);
  h.adapted.cleanup();
});

test("v2 preview cancelled during runtime import never mounts stale UI", async () => {
  const h = host();
  let loaded;
  const preview = createV2Preview(
    h.ctx,
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  const started = preview.begin();
  preview.clear();
  loaded({});
  assert.equal(await started, false);
  assert.equal(h.claims.length, 0);
  h.adapted.cleanup();
});

test("v2 real streaming controller previews partials on home, submits final once, cancels none", async () => {
  const h = host();
  const scheduled = new Map();
  let id = 0;
  const clock = {
    setTimeout(fn) {
      scheduled.set(++id, fn);
      return id;
    },
    clearTimeout(key) {
      scheduled.delete(key);
    },
  };
  const capture = {
    start() {},
    snapshot: () => ({ wav: Buffer.from("snapshot"), durationMs: 1000 }),
    stopFinal: async () => ({ wav: Buffer.from("final"), durationMs: 1000 }),
    cancel: async () => {},
    dispose: async () => {},
  };
  const script = ["hello tentative", "hello stable next", "final complete text"];
  const transcriber = {
    ensureReady: async () => ({ ready: true }),
    transcribe: async () => ({ text: script.shift() || "late cancelled words" }),
    dispose() {},
    describe: () => ({ modelPath: "fake", language: "en" }),
  };
  const stt = registerSTT(
    h.adapted.api,
    h.adapted.api.kv,
    async () => {
      throw new Error("No LLM in streaming");
    },
    {},
    {},
    { log() {} },
    {
      streamingControllerOpts: {
        captureFactory: () => capture,
        transcriberFactory: () => transcriber,
        clock,
      },
    },
  );
  assert.equal(await stt.controller.startStreaming(), true);
  await flush();
  for (const c of h.claims) c.render();
  const tick = async () => {
    const [key, fn] = scheduled.entries().next().value;
    scheduled.delete(key);
    fn();
    await flush();
  };
  await tick();
  assert.match(h.frames.at(-1), /hello tentative/);
  await tick();
  assert.match(h.frames.at(-1), /hello/);
  assert.equal(h.prompts.length, 0, "partials never submit");
  const first = stt.controller.finalizeStreaming();
  const second = stt.controller.finalizeStreaming();
  await Promise.all([first, second]);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].sessionID, "new-live-session");
  assert.match(h.prompts[0].text, /final complete text/);
  assert.equal(h.claims.length, 0);
  assert.equal(await stt.controller.startStreaming(), true);
  await flush();
  await tick();
  await stt.controller.cancelStreaming();
  assert.equal(h.claims.length, 0);
  assert.equal(h.prompts.length, 1);
  h.adapted.cleanup();
  await flush();
  assert.equal(scheduled.size, 0);
});

for (const dispose of [false, true]) {
  for (const waitingOn of ["stop-tail", "home-create"]) {
    test(`v2 streaming ${dispose ? "dispose" : "cancel"} while ${waitingOn} awaits never submits`, async () => {
      const h = host();
      let resolvePending;
      let released = 0;
      const capture = {
        start() {},
        snapshot: () => null,
        stopFinal: async () => ({ wav: Buffer.from("final"), durationMs: 1000 }),
        cancel: async () => {},
        dispose: async () => {},
      };
      const transcriber = {
        ensureReady: async () => ({ ready: true }),
        transcribe: () =>
          waitingOn === "stop-tail"
            ? new Promise((resolve) => {
                resolvePending = resolve;
              })
            : Promise.resolve({ text: "final race transcript" }),
        dispose() {
          released += 1;
        },
        describe: () => ({ modelPath: "fake", language: "en" }),
      };
      if (waitingOn === "home-create") {
        h.ctx.client.session.create = () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          });
      }
      const stt = registerSTT(
        h.adapted.api,
        h.adapted.api.kv,
        async () => ({}),
        {},
        {},
        { log() {} },
        {
          streamingControllerOpts: {
            captureFactory: () => capture,
            transcriberFactory: () => transcriber,
          },
        },
      );
      assert.equal(await stt.controller.startStreaming(), true);
      await flush();
      const final = stt.controller.finalizeStreaming();
      await flush();
      assert.equal(typeof resolvePending, "function");
      if (dispose) h.adapted.cleanup();
      else await stt.controller.cancelStreaming();
      resolvePending(
        waitingOn === "stop-tail"
          ? { text: "late final text" }
          : { id: "cancelled-created-session" },
      );
      await final;
      await flush();
      assert.equal(h.prompts.length, 0);
      assert.equal(h.claims.length, 0);
      assert.equal(stt.controller.isProcessing(), false);
      assert.ok(released > 0, "stale controller lease released");
      h.adapted.cleanup();
    });
  }
}
