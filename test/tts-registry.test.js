import assert from "node:assert/strict";
import test from "node:test";

import { createEngineRegistry } from "../lib/tts-engines/registry.js";
import { chatterboxSupportsLang } from "../lib/sidecars/chatterbox-server.js";

function makeRegistry(opts = {}) {
  const kv = {
    get: (key, fallback) => (key === "tts.engine" ? opts.engine : fallback),
    set: () => {},
  };
  const logger = { log: () => {} };
  const toast = () => {};
  const deps = {
    chatterboxSupportsLang,
  };
  return createEngineRegistry({ opts, kv, logger, toast, deps });
}

test("registry: Piper is the default engine", () => {
  const reg = makeRegistry({});
  assert.equal(reg.resolve(undefined, "en").engine.id, "piper");
  assert.equal(reg.resolve(undefined, "en").reason, "default");
  assert.equal(reg.resolve("piper", "en").engine.id, "piper");
  assert.equal(reg.resolve("piper", "en").reason, "default");
});

test("registry: unset/empty resolves to piper with fallback false", () => {
  const reg = makeRegistry({});
  const r = reg.resolve("piper", "en");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.fallback, false);
  assert.equal(r.reason, "default");
});

test("registry: unknown engine warns and falls back to Piper", () => {
  const warns = [];
  const logger = { log: (s, m) => warns.push(m) };
  const reg = createEngineRegistry({
    opts: { ttsEngine: "elevenlabs" },
    kv: { get: () => "elevenlabs", set: () => {} },
    logger,
    toast: () => {},
    deps: {},
  });
  const r = reg.resolve("elevenlabs", "en");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.reason, "unknown-engine");
  assert.equal(r.fallback, true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Unknown ttsEngine "elevenlabs"/);
});

test("registry: chatterbox handles English", () => {
  const reg = makeRegistry({ ttsEngine: "chatterbox" });
  const r = reg.resolve("chatterbox", "en");
  assert.equal(r.engine.id, "chatterbox");
  assert.equal(r.reason, "ok");
  assert.equal(r.fallback, false);
});

test("registry: Vietnamese routes to Piper on chatterbox", () => {
  const reg = makeRegistry({ ttsEngine: "chatterbox", ttsChatterboxVariant: "multilingual" });
  const r = reg.resolve("chatterbox", "vi");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.reason, "unsupported-language");
  assert.equal(r.fallback, true);
});

test("registry: unknown variant warns and falls back to multilingual", () => {
  const warns = [];
  const logger = { log: (s, m) => warns.push(m) };
  const reg = createEngineRegistry({
    opts: { ttsEngine: "chatterbox", ttsChatterboxVariant: "ultra" },
    kv: { get: () => "chatterbox", set: () => {} },
    logger,
    toast: () => {},
    deps: {},
  });
  const r = reg.resolve("chatterbox", "en");
  assert.equal(r.engine.id, "chatterbox");
  assert.equal(r.reason, "ok");
  assert.ok(warns.some((w) => /Unknown ttsChatterboxVariant "ultra"/.test(w)));
});

test("registry: vieneu handles vi and en", () => {
  const reg = makeRegistry({ ttsEngine: "vieneu" });
  assert.equal(reg.resolve("vieneu", "vi").engine.id, "vieneu");
  assert.equal(reg.resolve("vieneu", "en").engine.id, "vieneu");
});

test("registry: vieneu unsupported lang falls back", () => {
  // vieneu supports vi/en only; test a lang it doesn't support
  const reg = makeRegistry({ ttsEngine: "vieneu" });
  const r = reg.resolve("vieneu", "fr");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.reason, "unsupported-language");
});

test("registry: unsupported language warns once and falls back to Piper", () => {
  const warns = [];
  const logger = { log: (s, m) => warns.push(m) };
  const reg = createEngineRegistry({
    opts: { ttsEngine: "chatterbox", ttsChatterboxVariant: "multilingual" },
    kv: { get: () => "chatterbox", set: () => {} },
    logger,
    toast: () => {},
    deps: {},
  });
  const r = reg.resolve("chatterbox", "vi");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.reason, "unsupported-language");
  assert.equal(r.fallback, true);
  assert.equal(warns.length, 1, "exactly one warning for the unsupported language");
  assert.match(warns[0], /cannot speak "vi"/);
});

test("registry: list/get/disposeAll", () => {
  const reg = makeRegistry({});
  const ids = reg.list().map((e) => e.id);
  assert.deepEqual(ids, ["piper", "chatterbox", "vieneu", "kokoro"]);
  assert.equal(reg.get("piper").id, "piper");
  assert.equal(reg.get("nope"), null);
  // disposeAll should not throw
  reg.disposeAll();
});

test("registry: resolve via kv when no configuredId", () => {
  const reg = makeRegistry({ engine: "vieneu" });
  // opts.ttsEngine unset, kv returns vieneu
  const r = reg.resolve(undefined, "vi");
  assert.equal(r.engine.id, "vieneu");
});

test("registry: Kokoro handles English", () => {
  const reg = makeRegistry({ ttsEngine: "kokoro" });
  const r = reg.resolve("kokoro", "en");
  assert.equal(r.engine.id, "kokoro");
  assert.equal(r.reason, "ok");
  assert.equal(r.fallback, false);
});

test("registry: Vietnamese routes to Piper on Kokoro", () => {
  const reg = makeRegistry({ ttsEngine: "kokoro" });
  const r = reg.resolve("kokoro", "vi");
  assert.equal(r.engine.id, "piper");
  assert.equal(r.reason, "unsupported-language");
  assert.equal(r.fallback, true);
});

test("kokoro /health 503 with a failed phase fails fast instead of polling", async () => {
  const { createKokoroClient } = await import("../lib/sidecars/kokoro-server.js");
  let healthCalls = 0;
  const client = createKokoroClient({
    python: "/fake/python",
    readyTimeoutMs: 60000,
    readyPollMs: 10,
    deps: {
      spawn: () => ({ pid: 1, stderr: { on() {} }, kill() {}, on() {} }),
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/health") {
          healthCalls += 1;
          return {
            ok: false,
            status: 503,
            json: async () => ({ ok: false, status: "failed", error: "no module named kokoro" }),
          };
        }
        return { ok: false, status: 503, json: async () => ({}) };
      },
    },
  });
  const started = Date.now();
  assert.equal(await client.start(), false);
  assert.ok(Date.now() - started < 5000, "must not poll for the full ready timeout");
  assert.equal(client.getLastError()?.code, "MODEL_LOAD_FAILED");
  assert.match(client.getLastError()?.message || "", /no module named kokoro/);
  assert.ok(healthCalls < 10, `polled ${healthCalls} times`);
});

test("vieneu: 429 busy retries once after reset, then succeeds", async () => {
  const { createVieneuEngine } = await import("../lib/tts-engines/vieneu.js");
  const calls = { synthesize: 0, dispose: 0, reset: 0, ensure: 0 };
  const busy = () => ({
    ok: false,
    code: "BAD_STATUS",
    message: '{"message":"server busy: timed out waiting for a stream slot","code":429}',
  });
  const engine = createVieneuEngine({
    opts: {},
    kv: { get: (k, f) => f, set: () => {} },
    logger: { log: () => {} },
    toast: () => {},
    deps: {
      ensureVieneuReady: async () => {
        calls.ensure += 1;
        return true;
      },
      getVieneuClient: () => ({
        synthesize: async () => {
          calls.synthesize += 1;
          return calls.synthesize === 1 ? busy() : { ok: true, wav: Buffer.from("RIFFwav") };
        },
      }),
      disposeVieneu: () => {
        calls.dispose += 1;
      },
      resetVieneuClient: () => {
        calls.reset += 1;
      },
    },
  });
  const result = await engine.synthesize("xin chào", { lang: "vi" });
  assert.equal(result.ok, true);
  assert.equal(calls.synthesize, 2, "one retry after the busy response");
  assert.equal(calls.reset, 1);
});

test("vieneu: persistent 429 fails over instead of retrying forever", async () => {
  const { createVieneuEngine } = await import("../lib/tts-engines/vieneu.js");
  let n = 0;
  const engine = createVieneuEngine({
    opts: {},
    kv: { get: (k, f) => f, set: () => {} },
    logger: { log: () => {} },
    toast: () => {},
    deps: {
      ensureVieneuReady: async () => true,
      getVieneuClient: () => ({
        synthesize: async () => {
          n += 1;
          return { ok: false, code: "BAD_STATUS", message: "server busy: stream slot 429" };
        },
      }),
      disposeVieneu: () => {},
      resetVieneuClient: () => {},
    },
  });
  const result = await engine.synthesize("xin chào", { lang: "vi" });
  assert.equal(result.ok, false);
  assert.equal(n, 2, "exactly one retry, then give up to the fallback");
});
