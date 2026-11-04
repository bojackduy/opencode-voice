import test from "node:test";
import assert from "node:assert/strict";
import {
  USB_SSH_HOST,
  USB_SSH_PORT,
  parseAdbDevices,
  buildAdbForwardArgs,
  ensureUsbForward,
  usbRemoteProfile,
} from "../lib/stt/usb-forward.js";
import { classifyRemotePcm } from "../lib/stt.js";

test("USB preset keeps the verified Android login, not bare localhost", () => {
  assert.equal(USB_SSH_HOST, "u0_a368@127.0.0.1");
  assert.equal(USB_SSH_PORT, 8022);
  const profile = usbRemoteProfile({ key: "k", rate: 16000 });
  assert.equal(profile.host, "u0_a368@127.0.0.1");
  assert.equal(profile.port, 8022);
  assert.equal(profile.key, "k");
  assert.equal(profile.rate, 16000);
});

test("parseAdbDevices lists only state=device serials", () => {
  const out = "List of devices attached\nQV710TEC3E\tdevice\nemulator-5554\toffline\n\n";
  assert.deepEqual(parseAdbDevices(out), ["QV710TEC3E"]);
  assert.deepEqual(parseAdbDevices("List of devices attached\n\n"), []);
  assert.deepEqual(parseAdbDevices(""), []);
});

test("forward argv is bounded, no shell, optional serial selection", () => {
  assert.deepEqual(buildAdbForwardArgs(null), ["forward", "tcp:8022", "tcp:8022"]);
  assert.deepEqual(buildAdbForwardArgs("QV710TEC3E"), [
    "-s",
    "QV710TEC3E",
    "forward",
    "tcp:8022",
    "tcp:8022",
  ]);
});

test("ensureUsbForward reports missing adb distinctly", () => {
  const r = ensureUsbForward({
    run: () => {
      const err = new Error("spawnSync adb ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /adb not found/i);
});

test("ensureUsbForward reports no device distinctly", () => {
  const r = ensureUsbForward({
    run: (bin, args) =>
      args[0] === "devices"
        ? { status: 0, stdout: "List of devices attached\n\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no Android device/i);
});

test("ensureUsbForward refuses ambiguous devices without explicit serial", () => {
  const r = ensureUsbForward({
    run: (bin, args) =>
      args[0] === "devices"
        ? { status: 0, stdout: "List of devices attached\nAAA\tdevice\nBBB\tdevice\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /multiple devices/i);
});

test("ensureUsbForward succeeds with explicit serial, argv only", () => {
  const seen = [];
  const r = ensureUsbForward({
    serial: "QV710TEC3E",
    run: (bin, args, opts) => {
      seen.push([bin, args, opts?.timeout]);
      if (args[0] === "devices") {
        return { status: 0, stdout: "List of devices attached\nQV710TEC3E\tdevice\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.serial, "QV710TEC3E");
  const fwd = seen.find(([, a]) => a[0] === "-s" || a[0] === "forward");
  assert.deepEqual(fwd[1], ["-s", "QV710TEC3E", "forward", "tcp:8022", "tcp:8022"]);
  assert.ok(seen.every(([, , t]) => t === 10000));
});

test("ensureUsbForward surfaces forward failure output", () => {
  const r = ensureUsbForward({
    run: (bin, args) =>
      args[0] === "devices"
        ? { status: 0, stdout: "List of devices attached\nQV710TEC3E\tdevice\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "error: device not found" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /device not found/);
});

test("classifyRemotePcm distinguishes failure from real silence", () => {
  assert.equal(classifyRemotePcm(null).kind, "missing");
  assert.equal(classifyRemotePcm(Buffer.alloc(0)).kind, "empty");
  const zeros = Buffer.alloc(69632, 0);
  const zero = classifyRemotePcm(zeros);
  assert.equal(zero.kind, "zero");
  assert.equal(zero.bytes, 69632);
  assert.equal(zero.rms, 0);
  // Nonzero but silent room tone stays silence, not failure.
  const quiet = Buffer.alloc(32000, 0);
  for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(10, i);
  const silent = classifyRemotePcm(quiet);
  assert.equal(silent.kind, "silent");
  assert.ok(silent.rms > 0 && silent.rms < 0.005);
  // Real speech passes.
  const speech = Buffer.alloc(32000, 0);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(5000, i);
  assert.equal(classifyRemotePcm(speech).kind, "ok");
});

test("short captures stay silence, not failure", () => {
  assert.equal(classifyRemotePcm(Buffer.alloc(1000, 0)).kind, "short");
});
