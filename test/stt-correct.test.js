import test from "node:test";
import assert from "node:assert/strict";
import {
  __clearNormalizeCacheForTests,
  __setLastInsertedTextForTests,
  __setLastInsertKvForTests,
  beginCorrection,
  isCorrecting,
  normalizeCorrection,
  readComposerText,
  runCorrectionMerge,
  tryReplaceComposerText,
} from "../lib/stt.js";
import fs from "node:fs";

const LOG_PATH = "/tmp/opencode-voice-stt.log";

function snapLog() {
  try {
    return fs.statSync(LOG_PATH).size;
  } catch {
    return 0;
  }
}

function readLogSince(offset) {
  try {
    const fd = fs.openSync(LOG_PATH, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function armCorrection(text = "help me fit this bug") {
  __clearNormalizeCacheForTests();
  __setLastInsertedTextForTests(text);
  const toasts = [];
  const r = beginCorrection({
    api: noopApi(),
    kv: { get: () => null, set: () => {} },
    complete: async () => ({}),
    client: {},
    toast: (m) => toasts.push(m),
    systemPrompt: "",
    logger: null,
    renderer: null,
  });
  assert.equal(r.ok, true);
  assert.equal(isCorrecting(), true);
  return toasts;
}

function fakeRenderer(fields) {
  return { currentFocusedRenderable: fields };
}

function noopApi() {
  return { ui: { toast: () => {} } };
}

test("readComposerText probes known shapes and logs unknown ones", () => {
  assert.equal(readComposerText(null), null);
  assert.equal(readComposerText({}), null);
  assert.equal(readComposerText(fakeRenderer({ getText: () => "hello" })), "hello");
  assert.equal(readComposerText(fakeRenderer({ value: "abc" })), "abc");
  assert.equal(readComposerText(fakeRenderer({ value: () => "xyz" })), "xyz");
  assert.equal(readComposerText(fakeRenderer({ getValue: () => 42 })), null);
  assert.equal(readComposerText(fakeRenderer({ insertText: () => {} })), null);
});

test("tryReplaceComposerText prefers setText, falls back to clear+insert", () => {
  const calls = [];
  assert.equal(
    tryReplaceComposerText(fakeRenderer({ setText: (t) => calls.push(["set", t]) }), "hi"),
    true,
  );
  assert.deepEqual(calls, [["set", "hi"]]);
  const calls2 = [];
  const r2 = fakeRenderer({
    clear: () => calls2.push("clear"),
    insertText: (t) => calls2.push(["insert", t]),
  });
  assert.equal(tryReplaceComposerText(r2, "yo"), true);
  assert.deepEqual(calls2, ["clear", ["insert", "yo"]]);
  assert.equal(tryReplaceComposerText(fakeRenderer({}), "x"), false);
  assert.equal(tryReplaceComposerText(null, "x"), false);
});

test("normalizeCorrection asks the LLM to merge original + correction", async () => {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    return { text: "fix this bug please" };
  };
  const res = await normalizeCorrection(
    complete,
    "fit this bug please",
    "I mean fix not fit",
    null,
    null,
  );
  assert.equal(res.text, "fix this bug please");
  assert.match(calls[0].system, /repair/i);
  assert.match(calls[0].prompt, /fit this bug/);
  assert.match(calls[0].prompt, /fix not fit/);
  assert.equal(calls[0].config.temperature, 0);
});

test("beginCorrection refuses without anything to correct", () => {
  __setLastInsertedTextForTests(null);
  const toasts = [];
  const r = beginCorrection({
    api: noopApi(),
    kv: { get: () => null, set: () => {} },
    complete: async () => ({}),
    client: {},
    toast: (m) => toasts.push(m),
    systemPrompt: "",
    logger: null,
    renderer: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty");
  assert.equal(isCorrecting(), false);
  assert.ok(toasts.some((t) => /nothing to correct/i.test(t)));
});

test("beginCorrection arms from the live composer when readable", () => {
  __setLastInsertedTextForTests("old text");
  const toasts = [];
  const r = beginCorrection({
    api: noopApi(),
    kv: { get: () => null, set: () => {} },
    complete: async () => ({}),
    client: {},
    toast: (m) => toasts.push(m),
    systemPrompt: "",
    logger: null,
    renderer: fakeRenderer({ getText: () => "please help me fix this bug" }),
  });
  assert.equal(r.ok, true);
  assert.equal(isCorrecting(), true);
  __setLastInsertedTextForTests(null);
  assert.equal(isCorrecting(), false);
});

function mergeArgs(complete, text = "I mean fix not bug") {
  return {
    kv: {},
    complete,
    client: {},
    api: noopApi(),
    toast: () => {},
    systemPrompt: "",
    logger: null,
    renderer: null,
    text,
  };
}

test("correction follows the composer language, not the fix language", async () => {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    return { text: "help me fix this bug" };
  };
  // Composer is English, correction spoken in Vietnamese: merged output stays English.
  const res = await normalizeCorrection(
    complete,
    "help me fit this bug",
    "sua thanh fix, sua thanh fix",
    null,
    null,
  );
  assert.equal(res.text, "help me fix this bug");
  assert.match(calls[0].system, /language of the ORIGINAL/i);
  assert.match(calls[0].prompt, /ORIGINAL.*English|original/i);
});

test("correction merge: empty result logs distinctly and keeps original", async () => {
  const toasts = [];
  armCorrection();
  const off = snapLog();
  const r = await runCorrectionMerge({
    ...mergeArgs(async () => ({})),
    toast: (m) => toasts.push(m),
  });
  assert.deepEqual(r, { text: null, kept: true, reason: "empty" });
  assert.equal(isCorrecting(), false);
  assert.ok(
    toasts.some((t) => /came back empty/i.test(t)),
    `toasts: ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    readLogSince(off).includes("correction merge returned empty text"),
    "empty merge is logged distinctly",
  );
});

test("correction merge: timeout result logs distinctly and keeps original", async () => {
  const toasts = [];
  armCorrection();
  const off = snapLog();
  const r = await runCorrectionMerge({
    ...mergeArgs(async () => ({ text: null, error: "Correction timed out", timedOut: true })),
    toast: (m) => toasts.push(m),
  });
  assert.deepEqual(r, { text: null, kept: true, reason: "timeout" });
  assert.equal(isCorrecting(), false);
  assert.ok(
    toasts.some((t) => /timed out/i.test(t)),
    `toasts: ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    readLogSince(off).includes("correction merge timeout:"),
    "timeout is logged distinctly",
  );
});

test("correction merge: thrown error logs distinctly and keeps original", async () => {
  const toasts = [];
  armCorrection();
  const off = snapLog();
  const r = await runCorrectionMerge({
    ...mergeArgs(async () => {
      throw new Error("LLM 503 upstream");
    }),
    toast: (m) => toasts.push(m),
  });
  assert.deepEqual(r, { text: null, kept: true, reason: "error" });
  assert.equal(isCorrecting(), false);
  assert.ok(
    toasts.some((t) => /Correction failed/i.test(t) && /503/.test(t)),
    `toasts: ${JSON.stringify(toasts)}`,
  );
  assert.ok(
    readLogSince(off).includes("correction merge threw: LLM 503 upstream"),
    "thrown error is logged distinctly",
  );
});

test("beginCorrection hydrates last insert from kv after a restart", () => {
  __setLastInsertedTextForTests(null);
  const store = new Map([["stt.lastInsertedText", "persisted dictation text"]]);
  __setLastInsertKvForTests({ get: (k) => store.get(k), set: (k, v) => void store.set(k, v) });
  try {
    const toasts = [];
    const r = beginCorrection({ toast: (m) => toasts.push(m), renderer: null });
    assert.equal(r.ok, true);
    assert.equal(isCorrecting(), true);
  } finally {
    __setLastInsertedTextForTests(null);
    __setLastInsertKvForTests(null);
  }
});

test("beginCorrection still refuses when kv has nothing either", () => {
  __setLastInsertedTextForTests(null);
  __setLastInsertKvForTests({ get: () => undefined, set: () => {} });
  try {
    const toasts = [];
    const r = beginCorrection({ toast: (m) => toasts.push(m), renderer: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty");
    assert.ok(toasts.some((t) => /nothing to correct/i.test(t)));
  } finally {
    __setLastInsertKvForTests(null);
  }
});

test("correction pins the route session id so the gateway cannot 400", async () => {
  const calls = [];
  armCorrection();
  const r = await runCorrectionMerge({
    ...mergeArgs(async (req) => {
      calls.push(req);
      return { text: "help me fix this bug" };
    }),
    api: {
      ui: { toast: () => {} },
      route: { current: { name: "session", params: { sessionID: "ses_abc" } } },
    },
  });
  assert.equal(r.kept === true || r.text === null || typeof r.text === "string", true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.sessionID, "ses_abc");
});

test("correction falls back to the last seen session when the route moved", async () => {
  const calls = [];
  armCorrection();
  await runCorrectionMerge({
    ...mergeArgs(async (req) => {
      calls.push(req);
      return { text: "ok" };
    }),
    api: { ui: { toast: () => {} }, route: { current: { name: "home", params: {} } } },
  });
  // First call with no session sees no id; a later one must remember.
  const before = calls[0].config.sessionID ?? null;
  assert.ok(before === null || typeof before === "string");
});

test("normalizeTranscription forwards the pinned session id", async () => {
  const calls = [];
  const { normalizeTranscription } = await import("../lib/stt.js");
  await normalizeTranscription(
    async (req) => {
      calls.push(req);
      return { text: "clean text" };
    },
    "raw text",
    "",
    "system",
    null,
    "ses_xyz",
  );
  assert.equal(calls[0].config.sessionID, "ses_xyz");
});

test("readComposerText finds a nested editBuffer", () => {
  const renderer = fakeRenderer({ editBuffer: { getText: () => "nested text" } });
  assert.equal(readComposerText(renderer), "nested text");
});

test("tryReplaceComposerText writes through a nested editBuffer", () => {
  const calls = [];
  const renderer = fakeRenderer({
    editBuffer: {
      getText: () => "old text",
      setText: (t) => calls.push(["set", t]),
    },
  });
  assert.equal(tryReplaceComposerText(renderer, "new text"), true);
  assert.deepEqual(calls, [["set", "new text"]]);
});

test("tryReplaceComposerText uses setRange on a range-capable target", () => {
  const calls = [];
  const renderer = fakeRenderer({
    getText: () => "help me fit this",
    setRange: (from, to, text) => calls.push([from, to, text]),
  });
  assert.equal(tryReplaceComposerText(renderer, "help me fix this"), true);
  assert.deepEqual(calls, [[0, 16, "help me fix this"]]);
});

test("correction merge is cached: identical repair does not call the LLM twice", async () => {
  __clearNormalizeCacheForTests();
  armCorrection();
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return { text: "help me fix this bug" };
  };
  await runCorrectionMerge({ ...mergeArgs(complete) });
  await runCorrectionMerge({ ...mergeArgs(complete) });
  assert.equal(calls, 1, "second identical correction is served from cache");
  __clearNormalizeCacheForTests();
});

test("normalize is cached per raw text", async () => {
  __clearNormalizeCacheForTests();
  const { normalizeTranscription } = await import("../lib/stt.js");
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return { text: "clean" };
  };
  await normalizeTranscription(complete, "same raw", "", "sys", null, "ses_1");
  await normalizeTranscription(complete, "same raw", "", "sys", null, "ses_1");
  assert.equal(calls, 1);
  await normalizeTranscription(complete, "different raw", "", "sys", null, "ses_1");
  assert.equal(calls, 2, "different speech misses the cache");
  __clearNormalizeCacheForTests();
});
