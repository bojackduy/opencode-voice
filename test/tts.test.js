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
  const disposes = [];
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
    lifecycle: { onDispose: (fn) => disposes.push(fn) },
  };
  const kv = {
    get: (key, fallback) => (key === "tts.mode" ? "on" : fallback),
    set: () => {},
  };
  const logger = { log: (scope, message, level) => logs.push({ scope, message, level }) };
  return { api, kv, logger, toasts, logs, disposes };
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

// ---- Chatterbox engine: routing, playback, per-utterance Piper fallback ----
// Both branches are observable WITHOUT audio, thanks to an empty PATH:
// - "Piper binary not found on PATH" proves the Piper branch ran (it bails in
//   resolveVoiceOrWarn, before spawning anything).
// - a "play error" log proves a sox `play` process WAS spawned and failed to
//   launch, i.e. the shared playback path really received something. With PATH
//   empty the spawn can never hang, so these tests never touch real audio.

function fakeChatterbox({ startOk = true, synthesize } = {}) {
  const calls = { start: 0, synthesize: [], stop: 0 };
  return {
    calls,
    client: {
      start: async () => {
        calls.start += 1;
        return startOk;
      },
      isRunning: () => startOk,
      getLastError: () => ({
        code: "MODEL_LOAD_FAILED",
        message: "chatterbox-tts not installed",
      }),
      synthesize:
        synthesize ??
        (async (text, lang) => {
          calls.synthesize.push({ text, lang });
          return { ok: true, wav: Buffer.from("RIFF0000WAVEfmt-data") };
        }),
      stop: () => {
        calls.stop += 1;
      },
    },
  };
}

// Default synthesize records the call; the default one above already does, so a
// failing fake just returns an error.
function failingChatterbox(message = "synthesis exploded") {
  const calls = { start: 0, synthesize: [], stop: 0 };
  return {
    calls,
    client: {
      start: async () => {
        calls.start += 1;
        return true;
      },
      isRunning: () => true,
      getLastError: () => ({ code: "SYNTH_TIMEOUT", message }),
      synthesize: async (text, lang) => {
        calls.synthesize.push({ text, lang });
        return { ok: false, code: "SYNTH_TIMEOUT", message };
      },
      stop: () => {
        calls.stop += 1;
      },
    },
  };
}

// speak() with PATH emptied, so neither branch can make noise.
// speak() with PATH emptied, so neither branch can make noise. Registers the
// plugin ONCE and returns its controller: the outage toast latch is per-session
// state, so a fresh registerTTS per utterance would reset it and hide the very
// behaviour under test.
function chatterboxHost(host, opts, chatterbox) {
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    opts,
    host.logger,
    { createChatterboxClient: () => chatterbox.client },
  );
  return controller;
}

async function speakWithPathCleared(host, text, opts, chatterbox) {
  const controller = chatterboxHost(host, opts, chatterbox);
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    return await controller.speak(text);
  } finally {
    process.env.PATH = realPath;
  }
}

const piperMissed = (host) => host.toasts.filter((t) => /Piper binary not found/.test(t.message));
const playSpawned = (host) => host.logs.filter((l) => /play error/.test(l.message));

test("an English utterance plays through the Chatterbox path, not Piper", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.start, 1, "the sidecar is started lazily, on first use");
  assert.deepEqual(cb.calls.synthesize, [{ text: "Deploying now.", lang: "en" }]);
  // A sox play process was spawned for the WAV: the existing playback path.
  assert.equal(playSpawned(host).length, 1);
  assert.equal(piperMissed(host).length, 0, "Piper must not be consulted on success");
});

test("a Vietnamese utterance never reaches Chatterbox", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();

  await speakWithPathCleared(host, "Xin chào, triển khai ngay.", { ttsEngine: "chatterbox" }, cb);

  // Chatterbox does not speak Vietnamese; Piper's real vi voice must.
  assert.equal(cb.calls.start, 0, "the sidecar must not load for a vi-only session");
  assert.equal(cb.calls.synthesize.length, 0);
  assert.equal(piperMissed(host).length, 1);
  assert.ok(
    host.logs.some((l) => l.level === "warn" && /cannot speak "vi"/.test(l.message)),
    "the skipped utterance is explained in the log, not toasted",
  );
  assert.equal(
    host.toasts.filter((t) => /cannot speak/i.test(t.message)).length,
    0,
    "no toast spam for a language Piper already handles",
  );
});

test("a sidecar that cannot start falls back to Piper for that utterance", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox({ startOk: false });

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.start, 1);
  assert.equal(cb.calls.synthesize.length, 0, "nothing is synthesized without a sidecar");
  assert.equal(piperMissed(host).length, 1, "speech continues on Piper");
  assert.ok(host.toasts.some((t) => /Chatterbox unavailable.*using Piper/.test(t.message)));
});

test("a failed synthesis falls back to Piper instead of going silent", async () => {
  const host = fakeTtsHost();
  const cb = failingChatterbox();

  await speakWithPathCleared(host, "Deploying now.", { ttsEngine: "chatterbox" }, cb);

  assert.equal(cb.calls.synthesize.length, 1);
  assert.equal(piperMissed(host).length, 1, "the utterance is still spoken");
  assert.ok(host.toasts.some((t) => /Chatterbox synthesis failed.*using Piper/.test(t.message)));
});

test("one toast per outage, not one per utterance, and recovery re-arms it", async () => {
  const host = fakeTtsHost();
  const cb = failingChatterbox();
  const opts = { ttsEngine: "chatterbox" };
  // One registered session across all four utterances, so its latch is what is
  // being measured.
  const controller = chatterboxHost(host, opts, cb);

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("First one.");
    await controller.speak("Second one.");
    await controller.speak("Third one.");

    const outageToasts = host.toasts.filter((t) => /Chatterbox synthesis failed/.test(t.message));
    assert.equal(outageToasts.length, 1, "three failed utterances must not toast three times");
    // Every utterance still retried the sidecar - no permanent latch.
    assert.equal(cb.calls.synthesize.length, 3);

    // A working engine re-arms the notice, so a LATER outage is reported again.
    // Swap the fake to success: without this "Recovered." would fail synthesis
    // exactly like the first three and never log the Chatterbox path.
    cb.client.synthesize = async (text, lang) => {
      cb.calls.synthesize.push({ text, lang });
      return { ok: true, wav: Buffer.from("RIFF0000WAVEfmt-data") };
    };
    await controller.speak("Recovered.");
    assert.equal(host.logs.filter((l) => /Speak via Chatterbox/.test(l.message)).length, 1);
    cb.calls.synthesize.length = 0;
    cb.client.synthesize = async (text, lang) => {
      cb.calls.synthesize.push({ text, lang });
      return { ok: false, code: "SYNTH_TIMEOUT", message: "synthesis exploded" };
    };
    await controller.speak("Fails again.");
    assert.equal(
      host.toasts.filter((t) => /Chatterbox synthesis failed/.test(t.message)).length,
      2,
    );
  } finally {
    process.env.PATH = realPath;
  }
});

test("a cancel during synthesis prevents playback entirely", async () => {
  const host = fakeTtsHost();
  const calls = { synthesize: [] };
  let release;
  const cb = {
    client: {
      start: async () => true,
      isRunning: () => true,
      getLastError: () => null,
      synthesize: (text, lang) => {
        calls.synthesize.push({ text, lang });
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, wav: Buffer.from("RIFF0000WAVEfmt-data") });
        });
      },
      stop: () => {},
    },
  };
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    { ttsEngine: "chatterbox" },
    host.logger,
    { createChatterboxClient: () => cb.client },
  );
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const speaking = controller.speak("Deploying now.");
    // A waiting synthesis still counts as speaking, so stop() acts on it.
    assert.equal(controller.isSpeaking(), true);
    // speak() awaits sidecar startup before synthesizing, so stop/release must
    // wait until the utterance is actually in-flight - otherwise this tests a
    // cancel-before-synthesis, not the mid-synthesis cancel under test.
    const deadline = Date.now() + 2000;
    while (calls.synthesize.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(calls.synthesize.length, 1, "synthesis must be in-flight before the cancel");
    controller.stop();
    assert.equal(controller.isSpeaking(), false);
    // The sidecar answers only after the cancel landed.
    release();
    await speaking;
  } finally {
    process.env.PATH = realPath;
  }

  assert.equal(calls.synthesize.length, 1);
  assert.equal(
    playSpawned(host).length,
    0,
    "no sox play process may be spawned for a cancelled utterance",
  );
  assert.equal(piperMissed(host).length, 0, "a cancel must not turn into Piper speech");
});

test("the sidecar is stopped when the plugin is disposed", async () => {
  const host = fakeTtsHost();
  const cb = fakeChatterbox();
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    { ttsEngine: "chatterbox" },
    host.logger,
    { createChatterboxClient: () => cb.client },
  );

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("Deploying now.");
  } finally {
    process.env.PATH = realPath;
  }
  assert.equal(cb.calls.stop, 0, "a running sidecar outlives individual utterances");

  for (const fn of host.disposes) fn();
  assert.equal(cb.calls.stop, 1, "dispose releases the model, it does not strand it in RAM");
});

test("the default engine never constructs a Chatterbox client", async () => {
  const host = fakeTtsHost();
  let constructed = 0;
  const { controller } = registerTTS(
    host.api,
    host.kv,
    async () => ({}),
    undefined,
    {},
    host.logger,
    {
      createChatterboxClient: () => {
        constructed += 1;
        return fakeChatterbox().client;
      },
    },
  );

  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await controller.speak("Run the build and check logs");
  } finally {
    process.env.PATH = realPath;
  }

  assert.equal(constructed, 0, "Piper is the default: no sidecar, no model, no ports");
  assert.equal(piperMissed(host).length, 1);
});
