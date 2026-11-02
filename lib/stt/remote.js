// Remote (phone-over-SSH) audio helpers, relocated from lib/stt.js (pure move).
//
// Leaf module: depends only on stt-log.js and node builtins. Holds its own
// module-level state (pluginKv/pluginOpts/sttCaptureCmdOverride) with setters
// so stt.js can feed it during registerSTT without a cycle.

import { sttLog } from "../stt-log.js";

let pluginKv = null;
let pluginOpts = null;
let sttCaptureCmdOverride = null;
let audioSampleRateValue = 16000;

export function __setPluginKv(kv) {
  pluginKv = kv;
}
export function __setPluginOpts(opts) {
  pluginOpts = opts;
}
export function __setSttCaptureCmd(cmd) {
  sttCaptureCmdOverride = Array.isArray(cmd) && cmd.length ? cmd : null;
}
export function __setAudioSampleRate(rate) {
  const n = Number(rate);
  if (n > 0) audioSampleRateValue = n;
}

export function getRemoteConfig() {
  const kv = pluginKv;
  const host = kv?.get("stt.remoteHost") || process.env.STT_REMOTE_HOST || "u0_a368@100.107.124.2";
  const port = Number(kv?.get("stt.remotePort") || process.env.STT_REMOTE_PORT || 8022);
  const key = kv?.get("stt.remoteKey") || process.env.STT_REMOTE_KEY || "~/.ssh/phone_bridge";
  // Mirror of lib/stt/audio.js getAudioSampleRate - duplicated here so this
  // leaf never imports audio.js (which imports us for backend detection).
  let rate = audioSampleRateValue;
  if (process.env.AUDIO_SAMPLE_RATE) {
    const n = Number(process.env.AUDIO_SAMPLE_RATE);
    if (n > 0) rate = n;
  }
  if (pluginKv) {
    const v = pluginKv.get("audio.sampleRate") ?? pluginKv.get("audioSampleRate");
    if (Number(v) > 0) rate = Number(v);
  }
  if (Number(pluginOpts?.audioSampleRate) > 0) rate = Number(pluginOpts.audioSampleRate);
  return { host, port, key, rate };
}

export function buildRemoteCaptureCmd(cfg) {
  if (!cfg?.host) return null;
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-i",
    cfg.key,
    "-p",
    String(cfg.port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    cfg.host,
    "$HOME/bin/capture.sh",
    String(cfg.rate),
    "10",
  ];
}

export function buildRemotePlayCmd(cfg) {
  if (!cfg?.host) return null;
  return [
    "ssh",
    "-i",
    cfg.key,
    "-p",
    String(cfg.port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    cfg.host,
    "$HOME/bin/playback.sh",
    String(cfg.rate),
  ];
}

export function getSttCaptureCmd() {
  if (process.env.STT_CAPTURE_CMD) {
    try {
      const p = JSON.parse(process.env.STT_CAPTURE_CMD);
      if (Array.isArray(p) && p.length) return p;
    } catch {}
    return process.env.STT_CAPTURE_CMD.split(/\s+/);
  }
  if (pluginKv) {
    const direct = pluginKv.get("stt.remoteCaptureCmd") ?? pluginKv.get("sttCaptureCmd");
    if (Array.isArray(direct) && direct.length) return direct;
    if (pluginKv.get("stt.mic") === "remote") {
      const cmd = buildRemoteCaptureCmd(getRemoteConfig());
      if (cmd) return cmd;
    }
  }
  if (Array.isArray(pluginOpts?.sttCaptureCmd) && pluginOpts.sttCaptureCmd.length) {
    return pluginOpts.sttCaptureCmd;
  }
  return sttCaptureCmdOverride;
}
