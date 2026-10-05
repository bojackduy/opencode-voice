import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLang,
  isSpeakableSentence,
  localSpeechCleanup,
  registerTTS,
  resolveSpeechText,
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

test("speech text survives an unavailable narrator", () => {
  // Narrator ok -> passthrough, no fallback flag.
  assert.deepEqual(resolveSpeechText("raw text", { text: "Narrated text." }), {
    text: "Narrated text.",
  });
  // Narrator out of quota -> local cleanup, error preserved, fallback flagged.
  assert.deepEqual(
    resolveSpeechText("Done. See parseConfig in `helpers.ts`", {
      text: null,
      error: "LLM request failed (429)",
    }),
    {
      text: "Done. See parse Config in helpers dot ts",
      error: "LLM request failed (429)",
      fellBack: true,
    },
  );
  // Narrator failed AND the cleanup left nothing speakable (image-only reply)
  // -> empty text, still a fallback, no throw.
  assert.deepEqual(
    resolveSpeechText("![](screenshot.png)", { text: null, error: "quota exceeded" }),
    {
      text: "",
      error: "quota exceeded",
      fellBack: true,
    },
  );
});

// ---- registerTTS-level: TTS must not depend on model availability ----

function fakeTtsHost(assistantText = "Done. See parseConfig in helpers.ts") {
  const toasts = [];
  const logs = [];
  const api = {
    client: {
      session: {
        list: async () => ({ data: [] }),
        message: async () => ({ data: { parts: [{ type: "text", text: assistantText }] } }),
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    state: {
      session: {
        messages: () => [{ role: "user" }, { role: "assistant", id: "msg_1" }],
      },
    },
    event: { on: () => {} },
    ui: { toast: (t) => toasts.push(t), dialog: {} },
  };
  const kv = {
    get: (key, fallback) => (key === "tts.mode" ? "on" : fallback),
    set: () => {},
  };
  const logger = { log: (scope, message, level) => logs.push({ scope, message, level }) };
  return { api, kv, logger, toasts, logs };
}

// speakAssistantTurn with an empty PATH: piperOnPath() reads process.env.PATH,
// so playback bails before spawning rather than making the test suite talk.
async function speakTurnWithoutPlayback(host) {
  const complete = async () => host.llmResult;
  const { controller } = registerTTS(host.api, host.kv, complete, undefined, {}, host.logger);
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    return await controller.speakAssistantTurn();
  } finally {
    process.env.PATH = realPath;
  }
}

test("an out-of-quota narrator still speaks the local cleanup", async () => {
  const host = fakeTtsHost();
  host.llmResult = { text: null, error: "quota exceeded" };

  const outcome = await speakTurnWithoutPlayback(host);

  // Reached speak instead of returning early with the normalization error.
  assert.deepEqual(outcome, { spoken: true });
  const messages = host.toasts.map((t) => t.message);
  assert.ok(messages.includes("Model unavailable - speaking text as-is"));
  assert.equal(messages.filter((m) => /normalization failed/i.test(m)).length, 0);
  assert.ok(
    host.logs.some((l) => l.level === "warn" && l.message.includes("speaking local cleanup")),
  );
});

test("a working narrator is untouched by the fallback", async () => {
  const host = fakeTtsHost();
  host.llmResult = { text: "Narrated text." };

  const outcome = await speakTurnWithoutPlayback(host);

  assert.deepEqual(outcome, { spoken: true });
  assert.equal(host.toasts.filter((t) => /Model unavailable/i.test(t.message)).length, 0);
  assert.equal(host.logs.filter((l) => /speaking local cleanup/.test(l.message)).length, 0);
});

test("nothing to read after the fallback stays quiet", async () => {
  const host = fakeTtsHost("![](screenshot.png)");
  host.llmResult = { text: null, error: "quota exceeded" };

  const outcome = await speakTurnWithoutPlayback(host);

  assert.deepEqual(outcome, { spoken: false });
  const messages = host.toasts.map((t) => t.message);
  assert.equal(messages.filter((m) => /normalization failed/i.test(m)).length, 0);
  assert.ok(!messages.some((m) => /Model unavailable/i.test(m)));
  assert.ok(host.logs.some((l) => l.level === "debug" && /nothing speakable/.test(l.message)));
});
