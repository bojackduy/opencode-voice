import test from "node:test";
import assert from "node:assert/strict";
import {
  __setLastInsertedTextForTests,
  beginCorrection,
  isCorrecting,
  normalizeCorrection,
  readComposerText,
  tryReplaceComposerText,
} from "../lib/stt.js";

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
  const res = await normalizeCorrection(complete, "fit this bug please", "I mean fix not fit", null, null);
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
