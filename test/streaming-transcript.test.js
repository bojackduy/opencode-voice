import assert from "node:assert/strict";
import test from "node:test";

import {
  commonWordPrefixLength,
  createStabilityTracker,
  overlapJoinLength,
  splitWords,
  stripStablePrefix,
} from "../lib/streaming-transcript.js";

test("word prefix comparison is case/punctuation-insensitive", () => {
  assert.equal(commonWordPrefixLength(splitWords("Hello, world"), splitWords("hello world")), 2);
  assert.equal(commonWordPrefixLength(splitWords("add tests"), splitWords("add logs")), 1);
  assert.equal(commonWordPrefixLength(splitWords("a b"), splitWords("c d")), 0);
});

test("overlap join finds the shared middle between windows", () => {
  assert.equal(overlapJoinLength(splitWords("a b c d e"), splitWords("c d e f g")), 3);
  assert.equal(overlapJoinLength(splitWords("hello world"), splitWords("hello world this is")), 2);
  assert.equal(overlapJoinLength(splitWords("a b"), splitWords("c d")), 0);
  assert.equal(overlapJoinLength(splitWords("is"), splitWords("hello")), 0);
});

test("first hypothesis is all tentative, second confirms the shared prefix", () => {
  const t = createStabilityTracker();
  let s = t.update("hello world");
  assert.equal(s.stableText, "");
  assert.equal(s.tentativeText, "hello world");

  s = t.update("hello world this is");
  assert.equal(s.stableText, "hello world");
  assert.equal(s.tentativeText, "this is");
});

test("successive windows grow stable monotonically without duplication", () => {
  const t = createStabilityTracker();
  t.update("hello world");
  t.update("hello world this is");
  const s = t.update("hello world this is a test");
  assert.equal(s.stableText, "hello world this is");
  assert.equal(s.tentativeText, "a test");
  // Stable + tentative reconstructs the latest hypothesis exactly once.
  assert.equal(`${s.stableText} ${s.tentativeText}`.trim(), "hello world this is a test");
});

test("rolling window that drops the historical prefix neither loses nor duplicates", () => {
  const t = createStabilityTracker();
  t.update("hello world this is");
  t.update("hello world this is a test");
  // Audio rolls forward: the new 10s window no longer contains "hello world".
  const s = t.update("this is a test of rolling windows");
  assert.equal(s.stableText, "hello world this is a test");
  assert.equal(s.tentativeText, "of rolling windows");
  assert.equal(
    `${s.stableText} ${s.tentativeText}`.trim(),
    "hello world this is a test of rolling windows",
  );
});

test("long dictation across many rolling windows assembles exactly", () => {
  const t = createStabilityTracker();
  const speech = splitWords(
    "hello world this is a test of rolling windows that keep moving forward as we speak",
  );
  // Simulate a 6-word window advancing 2 words per tick (changing starts).
  let s = null;
  for (let start = 0; start < speech.length; start += 2) {
    s = t.update(speech.slice(start, start + 6).join(" "));
  }
  s = t.commitTail();
  assert.equal(s.tentativeText, "");
  assert.equal(s.stableText, speech.join(" "));
});

test("long dictation with a wider window and bigger steps assembles exactly", () => {
  const t = createStabilityTracker();
  const speech = splitWords(
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
  );
  let s = null;
  for (let start = 0; start < speech.length; start += 3) {
    s = t.update(speech.slice(start, start + 10).join(" "));
  }
  s = t.commitTail();
  assert.equal(s.stableText, speech.join(" "));
});

test("long dictation with uneven window sizes assembles exactly", () => {
  const t = createStabilityTracker();
  const speech = splitWords("a b c d e f g h i j k l m n o p q r s t");
  const windows = [
    [0, 5],
    [2, 6],
    [5, 7],
    [8, 6],
    [11, 9],
  ];
  let s = null;
  for (const [start, len] of windows) {
    s = t.update(speech.slice(start, start + len).join(" "));
  }
  s = t.commitTail();
  assert.equal(s.stableText, speech.slice(0, 20).join(" "));
});

test("repeated real phrases do not collapse or duplicate", () => {
  const t = createStabilityTracker();
  t.update("test test test");
  let s = t.update("test test test again again");
  assert.equal(s.stableText, "test test test");
  assert.equal(s.tentativeText, "again again");
  s = t.update("test again again and again");
  assert.equal(`${s.stableText} ${s.tentativeText}`.trim(), "test test test again again and again");
  // No word appears more often than spoken: "again" x3 total.
  const agains = `${s.stableText} ${s.tentativeText}`
    .trim()
    .split(" ")
    .filter((w) => w === "again");
  assert.equal(agains.length, 3);
  s = t.commitTail();
  assert.equal(s.stableText, "test test test again again and again");
});

test("whisper revising committed words freezes stable instead of rewriting", () => {
  const t = createStabilityTracker();
  t.update("hello world");
  t.update("hello world this is");
  assert.equal(t.getState().stableText, "hello world");
  // "world" -> "word": hypothesis no longer carries the stable prefix.
  const s = t.update("hello word this is a test");
  assert.equal(s.stableText, "hello world");
  // Tail shows the hypothesis minus the shared stable head ("hello"), so the
  // shared word is never emitted twice. Stable itself is untouched.
  assert.equal(s.tentativeText, "word this is a test");
  const assembled = `${s.stableText} ${s.tentativeText}`.trim().split(" ");
  assert.equal(assembled.filter((w) => w.toLowerCase() === "hello").length, 1);
  // Next agreeing hypothesis resumes from the frozen stable.
  const s2 = t.update("hello world this is a test extended");
  assert.equal(s2.stableText, "hello world");
});

test("revision inside the tentative region rebases the tail without touching stable", () => {
  const t = createStabilityTracker();
  t.update("hello world");
  t.update("hello world this is");
  const s = t.update("hello world this was here");
  assert.equal(s.stableText, "hello world");
  assert.equal(s.tentativeText, "this was here");
  assert.equal(`${s.stableText} ${s.tentativeText}`.trim(), "hello world this was here");
});

test("empty hypothesis clears the tail but keeps stable", () => {
  const t = createStabilityTracker();
  t.update("hello world");
  t.update("hello world again");
  const s = t.update("   ");
  assert.equal(s.stableText, "hello world");
  assert.equal(s.tentativeText, "");
});

test("commitTail flushes the final window on stop", () => {
  const t = createStabilityTracker();
  t.update("hello world");
  t.update("hello world this is a test");
  const s = t.commitTail();
  assert.equal(s.stableText, "hello world this is a test");
  assert.equal(s.tentativeText, "");
});

test("final tail after rolled windows assembles the full dictation exactly", () => {
  const t = createStabilityTracker();
  t.update("the quick brown fox");
  t.update("the quick brown fox jumps over");
  t.update("brown fox jumps over the lazy dog");
  const s = t.commitTail();
  assert.equal(s.stableText, "the quick brown fox jumps over the lazy dog");
});

test("window hints are retained for coverage accounting", () => {
  const t = createStabilityTracker();
  t.update("hello world", { absoluteStartMs: 0, absoluteEndMs: 1000, seq: 1 });
  const s = t.getState();
  assert.deepEqual(s.lastWindow, { absoluteStartMs: 0, absoluteEndMs: 1000, seq: 1 });
});

test("stripStablePrefix rejects shorter or divergent hypotheses", () => {
  assert.deepEqual(stripStablePrefix(splitWords("a b c"), splitWords("a b")), null);
  assert.deepEqual(stripStablePrefix(splitWords("a b"), splitWords("a c d")), null);
  assert.deepEqual(stripStablePrefix([], splitWords("x y")), ["x", "y"]);
});
