// Module-level audio helpers relocated from lib/stt.js (pure move).
//
// Leaf module: depends on stt-log.js, ./remote.js (for backend detection
// only), and node builtins. Holds its own pluginKv/pluginOpts/override state
// with setters so stt.js can feed it during registerSTT.

import { execSync } from "node:child_process";
import fs from "node:fs";
import { sttLog } from "../stt-log.js";
import { getSttCaptureCmd } from "./remote.js";

let pluginKv = null;
let pluginOpts = null;
let audioSampleRateValue = 16000;

export function __setPluginKv(kv) {
  pluginKv = kv;
}
export function __setPluginOpts(opts) {
  pluginOpts = opts;
}
export function __setAudioSampleRate(rate) {
  const n = Number(rate);
  if (n > 0) audioSampleRateValue = n;
}

export function getAudioSampleRate() {
  if (process.env.AUDIO_SAMPLE_RATE) {
    const n = Number(process.env.AUDIO_SAMPLE_RATE);
    if (n > 0) return n;
  }
  if (pluginKv) {
    const v = pluginKv.get("audio.sampleRate") ?? pluginKv.get("audioSampleRate");
    if (Number(v) > 0) return Number(v);
  }
  if (Number(pluginOpts?.audioSampleRate) > 0) {
    return Number(pluginOpts.audioSampleRate);
  }
  return audioSampleRateValue;
}

export function detectAudioBackend() {
  // Mirror getSttCaptureCmd's main triggers without importing it (would
  // create a cycle with remote.js, which imports us for the sample rate).
  if (process.env.STT_CAPTURE_CMD) return "remote";
  if (pluginKv?.get?.("stt.mic") === "remote") return "remote";
  if (Array.isArray(pluginKv?.get?.("stt.remoteCaptureCmd"))) return "remote";
  if (Array.isArray(pluginOpts?.sttCaptureCmd) && pluginOpts.sttCaptureCmd.length) return "remote";
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

export function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}
