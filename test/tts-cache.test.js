import test from "node:test";
import assert from "node:assert/strict";

import {
  createAudioCache,
  cacheKey,
  hashText,
  audioBytes,
} from "../lib/tts/cache.js";

const wav = (n) => Buffer.concat([Buffer.from("RIFFxxxxWAVE"), Buffer.alloc(n)]);

test("cache key is stable per text and sensitive to engine/lang/voice", () => {
  const base = { engineId: "piper", lang: "en", voiceKey: "v1", text: "hello" };
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, text: "hello!" }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, engineId: "kokoro" }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, lang: "vi" }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, voiceKey: "v2" }));
  assert.match(hashText("x"), /^[0-9a-f]+$/);
});

test("get/set round-trips and refreshes LRU order", () => {
  const c = createAudioCache({ maxEntries: 2 });
  assert.equal(c.get("a"), null);
  assert.equal(c.set("a", { audio: { wav: wav(10) }, totalSec: 1 }), true);
  assert.equal(c.set("b", { audio: { wav: wav(10) }, totalSec: 1 }), true);
  c.get("a"); // a is now newest; b is oldest
  c.set("c", { audio: { wav: wav(10) }, totalSec: 1 });
  assert.ok(c.get("a"), "recently used entry survives");
  assert.equal(c.get("b"), null, "oldest entry evicted");
  assert.deepEqual(c.stats(), { entries: 2, bytes: 44 });
});

test("oversized and empty assets are never stored", () => {
  const c = createAudioCache({ maxEntries: 10, maxBytes: 100 });
  assert.equal(c.set("big", { audio: { wav: wav(200) }, totalSec: 5 }), false);
  assert.equal(c.set("empty", { audio: { wav: Buffer.alloc(0) }, totalSec: 0 }), false);
  assert.equal(c.set("zero", { audio: null, totalSec: 1 }), false);
  assert.deepEqual(c.stats(), { entries: 0, bytes: 0 });
});

test("audioBytes measures both audio shapes", () => {
  assert.equal(audioBytes({ wav: wav(12) }), 24);
  assert.equal(audioBytes({ pcm: Buffer.alloc(7) }), 7);
  assert.equal(audioBytes(null), 0);
});
