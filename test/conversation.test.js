import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STOP_PHRASES, matchesStopPhrase, normalizePhrase } from "../lib/conversation.js";

test("normalizes phrases for comparison", () => {
  assert.equal(normalizePhrase("  Stop... "), "stop");
  assert.equal(normalizePhrase("DỪNG LẠI!"), "dừng lại");
  assert.equal(normalizePhrase("Exit   Conversation "), "exit conversation");
});

test("matches exact stop phrases only", () => {
  assert.equal(matchesStopPhrase("stop"), true);
  assert.equal(matchesStopPhrase("Stop."), true);
  assert.equal(matchesStopPhrase("dừng lại"), true);
  assert.equal(matchesStopPhrase("KẾT THÚC"), true);
  assert.equal(matchesStopPhrase("goodbye!"), true);
});

test("matches stuttered and padded stop commands", () => {
  assert.equal(matchesStopPhrase("stop stop"), true);
  assert.equal(matchesStopPhrase("stop stop stopping"), true);
  assert.equal(matchesStopPhrase("please stop the conversation now"), true);
  assert.equal(matchesStopPhrase("dừng lại đi"), true);
  assert.equal(matchesStopPhrase("thôi"), true);
});

test("does not match speech containing stop words", () => {
  assert.equal(matchesStopPhrase("please stop the server"), false);
  assert.equal(matchesStopPhrase("do not stop"), false);
  assert.equal(matchesStopPhrase("stop the deployment right now please sir"), false);
  assert.equal(matchesStopPhrase(""), false);
  assert.equal(matchesStopPhrase(null), false);
});

test("supports custom phrase lists", () => {
  assert.equal(matchesStopPhrase("halt", ["halt"]), true);
  assert.equal(matchesStopPhrase("stop", ["halt"]), false);
});

test("default list covers both languages", () => {
  assert.ok(DEFAULT_STOP_PHRASES.includes("stop"));
  assert.ok(DEFAULT_STOP_PHRASES.includes("dừng lại"));
});
