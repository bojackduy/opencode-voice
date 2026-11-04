// USB (adb) forward for phone-over-USB remote capture.
//
// The phone's tailnet address is unreachable while gnirehtet owns the VPN
// slot, so SSH goes through a local adb forward instead. This module only
// ever establishes the USB forward; tailnet/CachyOS paths are untouched.
//
// All execution is argv-based (spawnSync, no shell) and bounded (10s).
// Device selection is explicit: a configured serial wins, a single attached
// device is used, multiple devices without a configured serial refuse rather
// than guess.

import { spawnSync } from "node:child_process";

export const USB_SSH_HOST = "u0_a368@127.0.0.1";
export const USB_SSH_PORT = 8022;
export const USB_FORWARD_SPEC = "tcp:8022";
export const USB_FORWARD_TIMEOUT_MS = 10000;

/**
 * Profile applied after a successful forward. Keeps the VERIFIED Android
 * login (user@127.0.0.1), never bare localhost.
 * @param {{key: string, rate: number}} cur
 */
export function usbRemoteProfile(cur) {
  return { host: USB_SSH_HOST, port: USB_SSH_PORT, key: cur.key, rate: cur.rate };
}

/**
 * Parse `adb devices` output into attached device-state serials. Pure.
 * @param {string} output
 * @returns {string[]}
 */
export function parseAdbDevices(output) {
  const serials = [];
  for (const line of String(output || "").split("\n")) {
    const m = line.trim().match(/^(\S+)\s+device$/);
    if (m) serials.push(m[1]);
  }
  return serials;
}

/**
 * argv (after the adb binary) for the forward. Pure, no shell.
 * @param {string|null} serial
 */
export function buildAdbForwardArgs(serial) {
  const fwd = ["forward", USB_FORWARD_SPEC, USB_FORWARD_SPEC];
  return serial ? ["-s", serial, ...fwd] : fwd;
}

/**
 * Ensure `adb forward tcp:8022 tcp:8022` exists. Never guesses a device.
 * @param {{run?: Function, serial?: string|null, timeoutMs?: number}} [opts]
 *   run(bin, args, opts) defaults to spawnSync; inject a fake in tests.
 * @returns {{ok: boolean, serial?: string, error?: string}}
 */
export function ensureUsbForward(opts = {}) {
  const run =
    opts.run || ((bin, args, runOpts) => spawnSync(bin, args, { encoding: "utf-8", ...runOpts }));
  const timeout = opts.timeoutMs ?? USB_FORWARD_TIMEOUT_MS;
  let devicesOut;
  try {
    const probed = run("adb", ["devices"], { timeout });
    if (probed?.error) throw probed.error;
    if (probed?.status !== 0) {
      return {
        ok: false,
        error: `adb devices failed: ${probed?.stderr?.trim() || "exit " + probed?.status}`,
      };
    }
    devicesOut = probed?.stdout ?? "";
  } catch (err) {
    if (err?.code === "ENOENT" || /ENOENT/.test(err?.message || "")) {
      return { ok: false, error: "adb not found on PATH - install Android platform-tools" };
    }
    return { ok: false, error: `adb devices failed: ${err?.message || err}` };
  }
  const devices = parseAdbDevices(devicesOut);
  let serial = opts.serial || null;
  if (!serial) {
    if (devices.length === 0)
      return { ok: false, error: "no Android device attached (adb devices is empty)" };
    if (devices.length > 1) {
      return {
        ok: false,
        error: `multiple devices attached (${devices.join(", ")}) - set stt.usbSerial to pick one`,
      };
    }
    serial = devices[0];
  } else if (!devices.includes(serial) && devices.length > 0) {
    return {
      ok: false,
      error: `configured device ${serial} not attached (seen: ${devices.join(", ")})`,
    };
  }
  try {
    const done = run("adb", buildAdbForwardArgs(serial), { timeout });
    if (done?.error) throw done.error;
    if (done?.status !== 0) {
      return {
        ok: false,
        error: `adb forward failed: ${done?.stderr?.trim() || "exit " + done?.status}`,
      };
    }
  } catch (err) {
    if (err?.code === "ENOENT" || /ENOENT/.test(err?.message || "")) {
      return { ok: false, error: "adb not found on PATH - install Android platform-tools" };
    }
    return { ok: false, error: `adb forward failed: ${err?.message || err}` };
  }
  return { ok: true, serial };
}
