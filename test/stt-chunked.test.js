import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseSilenceWindows,
  planChunkSpans,
  wavDurationSecFromBuffer,
  wrapPcmAsWav,
} from "../lib/stt/audio-chunker.js";
import { transcribeMaybeChunked } from "../lib/stt.js";

function sinePcm(seconds, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.floor(12000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  }
  return buf;
}

test("silence windows parse from ffmpeg stderr", () => {
  const err = [
    "[silencedetect @ x] silence_start: 12.5",
    "[silencedetect @ x] silence_end: 13.1 | silence_duration: 0.6",
    "[silencedetect @ x] silence_start: 40.0",
    "[silencedetect @ x] silence_end: 41.2 | silence_duration: 1.2",
  ].join("\n");
  assert.deepEqual(parseSilenceWindows(err), [
    { start: 12.5, end: 13.1 },
    { start: 40.0, end: 41.2 },
  ]);
  assert.deepEqual(parseSilenceWindows("nope"), []);
});

test("spans cut on silence middles and cap length", () => {
  const spans = planChunkSpans(71, [{ start: 12.5, end: 13.1 }, { start: 40, end: 41.2 }], 30);
  assert.ok(spans.length >= 2 && spans.length <= 4, JSON.stringify(spans));
  assert.ok(spans.slice(0, -1).every((s) => s.dur <= 30.01), JSON.stringify(spans));
  const last = spans[spans.length - 1];
  assert.ok(last.dur <= 35, "tail preservation may slightly exceed the cap");
  assert.equal(spans[0].start, 0);
  assert.ok(Math.abs(last.start + last.dur - 71) < 0.01);
  // no silences -> fixed windows
  const fixed = planChunkSpans(65, [], 30);
  assert.deepEqual(
    fixed.map((s) => Math.round(s.dur)),
    [30, 30, 5],
  );
});

test("short audio takes the single-call path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-"));
  const wav = path.join(dir, "short.wav");
  fs.writeFileSync(wav, wrapPcmAsWav(sinePcm(5), { sampleRate: 16000 }));
  let calls = 0;
  const r = await transcribeMaybeChunked(wav, "m", "en", null, async () => {
    calls += 1;
    return { text: "hello" };
  });
  assert.equal(calls, 1);
  assert.equal(r.text, "hello");
});

test("long audio is chunked; one bad chunk does not kill the turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunk-"));
  const wav = path.join(dir, "long.wav");
  fs.writeFileSync(wav, wrapPcmAsWav(sinePcm(50), { sampleRate: 16000 }));
  assert.ok(wavDurationSecFromBuffer(fs.readFileSync(wav)) > 45);
  let calls = 0;
  const r = await transcribeMaybeChunked(wav, "m", "en", null, async () => {
    calls += 1;
    // Second span hallucinates like the real 71s turn did.
    if (calls === 2) return { text: "thank you thank you thank you for watching subscribe now" };
    return { text: `part${calls}` };
  });
  assert.ok(calls >= 2, "split into spans");
  assert.match(r.text, /part1/);
  assert.doesNotMatch(r.text, /subscribe/);
});
