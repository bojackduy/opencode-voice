import assert from "node:assert/strict";
import test from "node:test";
import { createSoxRollingCapture } from "../lib/streaming-stt.js";

test("remote capture spawns the configured command", () => {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  };
  const cap = createSoxRollingCapture({
    captureCmd: ["ssh", "host", "capture.sh", "16000"],
    spawnFn: spawn,
  });
  cap.start();
  assert.equal(calls[0].bin, "ssh");
  assert.deepEqual(calls[0].args, ["host", "capture.sh", "16000"]);
  assert.deepEqual(calls[0].opts, { stdio: ["ignore", "pipe", "pipe"] });
});

test("unset capture spawns sox with original argv", () => {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
  };
  const cap = createSoxRollingCapture({ spawnFn: spawn });
  cap.start();
  assert.equal(calls[0].bin, "sox");
});
