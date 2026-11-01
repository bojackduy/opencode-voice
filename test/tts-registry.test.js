import assert from "node:assert/strict";
import test from "node:test";

import { createEngineRegistry } from "../lib/tts-engines/registry.js";
import { chatterboxSupportsLang } from "../lib/chatterbox-server.js";

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
