import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLang,
  isSpeakableSentence,
  localSpeechCleanup,
  splitSpokenSentences,
} from "../lib/tts.js";

test("cleans markdown for speech", () => {
  assert.equal(localSpeechCleanup("Hello **world**!"), "Hello world!");
  assert.equal(
    localSpeechCleanup("See parseConfig in src/utils/helpers.ts"),
    "See parse Config in helpers dot ts",
  );
  assert.equal(localSpeechCleanup("Run `npm test` now"), "Run npm test now");
  assert.equal(localSpeechCleanup("```js\nconst x = 1;\n```\nDone."), "code snippet Done.");
  assert.equal(
    localSpeechCleanup("Details at https://example.com/docs?q=1"),
    "Details at example dot com",
  );
});

test("splits streamed text into complete sentences", () => {
  assert.deepEqual(splitSpokenSentences("Hello world. How are"), {
    sentences: ["Hello world."],
    rest: "How are",
  });
  assert.deepEqual(splitSpokenSentences("Done. Next."), {
    sentences: ["Done.", "Next."],
    rest: "",
  });
  assert.deepEqual(splitSpokenSentences("Partial no punctuation"), {
    sentences: [],
    rest: "Partial no punctuation",
  });
  assert.deepEqual(splitSpokenSentences(""), { sentences: [], rest: "" });
});

test("decides one language for a whole utterance by word majority", () => {
  // Vietnamese-dominant instruction with English tech loanwords -> vi voice
  // reads the whole thing (was the original mixed-voice request).
  assert.equal(detectLang("Tìm symbol, search text, đọc file cụ thể"), "vi");
  // Pure English.
  assert.equal(detectLang("Run the build and check logs"), "en");
  // A single stray Vietnamese word must NOT flip an English-dominant reply -
  // this was the root cause of "speaks English with the Vietnamese voice".
  assert.equal(detectLang("Please check with Nguyễn about the API before you deploy it"), "en");
  // Pure Vietnamese greeting.
  assert.equal(detectLang("Xin chào, bạn khỏe không?"), "vi");
  assert.equal(detectLang(""), "en");
  assert.equal(detectLang(null), "en");
});

test("skips code-like sentences", () => {
  assert.equal(isSpeakableSentence("Hello there."), true);
  assert.equal(isSpeakableSentence("Use `npm test`."), false);
  assert.equal(isSpeakableSentence(`x${"y".repeat(500)}`), false);
  assert.equal(isSpeakableSentence(""), false);
});
