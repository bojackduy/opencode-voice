// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { wrapPcmAsWav } from "./audio-chunker.js";

import { getActiveSessionTitle, getRecentConversationContext } from "./session.js";
import { sttLog } from "./stt-log.js";

// ---- Remote audio backend (optional) ----
let sttCaptureCmdOverride = null;
let audioSampleRateValue = 16000;
let remotePcmFile = null;
let remoteBatchCapture = null;
let pluginKv = null;
let pluginOpts = null;
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
  const rate = getAudioSampleRate();
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
    "1",
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

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;

const WAV_FILENAME = "opencode-stt.wav";
let tmpDir = "/tmp";

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;
// Bounds for the recent-turns knowledge block sent with normalization.
let sttContextMessages = 8;
let sttContextChars = 3000;
// interpretive (default): fix misheard words using context; strict: transcribe exactly.
let sttNormalizeMode = "interpretive";
// Worst-case budget for one normalize call; on timeout the raw transcript is
// used so a stalled LLM never blocks the turn.
let sttNormalizeTimeoutMs = 15000;

// Pronouns, demonstratives, and capitalized words signal that the transcript
// may reference the conversation (he/she/Cristina/...). Without them the
// knowledge block only adds input tokens, so it is skipped.

const CONTEXT_SIGNALS =
  /\b(he|him|his|she|her|hers|they|them|their|it|its|this|that|these|those|anh|chị|em|cô|chú|bác|ông|bà|nó|họ|này|kia|đó|ấy)\b|[A-ZÀ-ỴĐ][a-zà-ỹ]{1,}/u;

export function needsContext(rawText) {
  if (!rawText || rawText.length < 3) return false;
  return CONTEXT_SIGNALS.test(rawText);
}

// Prefetched conversation context, kicked off while the user is still
// speaking so the fetch usually finishes before the turn ends.

let prefetchedContext = null; // { at, sessionID, promise }

function currentRouteSessionID(api) {
  const route = api?.route?.current;
  return route?.name === "session" ? route?.params?.sessionID || null : null;
}

async function fetchContextParts(client, api) {
  const [sessionTitle, recent] = await Promise.all([
    getActiveSessionTitle(client),
    getRecentConversationContext(client, api, {
      maxMessages: sttContextMessages,
      maxChars: sttContextChars,
    }),
  ]);
  return { sessionTitle, recent };
}

function prefetchContextParts(client, api) {
  try {
    prefetchedContext = {
      at: Date.now(),
      sessionID: currentRouteSessionID(api),
      promise: fetchContextParts(client, api),
    };
  } catch {
    prefetchedContext = null;
  }
}

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

function buildMultipartTranscriptionRequest(model, audioBuffer, apiKey) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

export function detectAudioBackend() {
  if (getSttCaptureCmd()) return "remote";
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Input device descriptors: name is the value passed to sox, label is shown in the UI.
export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name,
      label: s.description ? `${s.description} (${s.name})` : s.name,
    }));
}

export function parsePactlSourcesShort(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Recording state and control ----

let soxProc = null;
let soxStderr = "";
let recording = false;
let processing = false;
// Invalidated by cancelRecording/discardTurn: a cancel landing between
// LLM normalization and transcript-insert must prevent the stale text from
// landing afterwards. Checked in doTranscribePipeline before any append.
let pipelineGeneration = 0;

// ---- Conversation-mode hooks (wired by index.js) ----
// When voice conversation is active, the plain record/submit keys defer to the
// conversation loop instead of running the one-shot pipeline.

let conversationHooks = { isActive: null, onKey: null };
let conversationStreamingEnabled = false;
let conversationStreamingStopSec = null;
let conversationStreamingOnStopped = null;

export function __setConversationHooks(hooks) {
  conversationHooks = { ...conversationHooks, ...hooks };
}

function conversationActive() {
  try {
    return conversationHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// Live notes owns the microphone continuously while recording; one-shot and
// conversation-mode STT must stay out of the way while it is active.

let liveNotesHooks = { isActive: null };

export function __setLiveNotesHooks(hooks) {
  liveNotesHooks = { ...liveNotesHooks, ...hooks };
}

function liveNotesActive() {
  try {
    return liveNotesHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// Read-only guards for other modes (live notes) to check before starting,
// and for one-shot/conversation to refuse while live notes owns the mic.

export function isSttBusy() {
  return recording || processing;
}

// ---- Streaming dictation mode (stage 2) ----
// `sttMode: "batch"` (default) preserves the one-shot pipeline exactly.
// `sttMode: "streaming"` selects live local dictation (no LLM, zero quota).

let streamingDictationActive = false;

export function isStreamingActive() {
  return streamingDictationActive;
}

export function __setStreamingActive(v) {
  streamingDictationActive = !!v;
}

export const STREAMING_MODE_DEFAULTS = {
  windowMs: 10000,
  cadenceMs: 1000,
};

export function resolveSttMode(opts, kv = null) {
  // kv wins when set: the v2 host has been observed delivering only a
  // subset of file-plugin options, so a persisted choice must override.
  try {
    const saved = kv?.get("stt.mode");
    if (saved === "streaming" || saved === "batch") return saved;
  } catch {}
  return opts?.sttMode === "streaming" ? "streaming" : "batch";
}

export function resolveSttAutoSubmit(opts, kv = null) {
  try {
    const saved = kv?.get("stt.autoSubmit");
    if (saved === true || saved === false) return saved;
  } catch {}
  return opts?.sttAutoSubmit === true;
}

export function resolveStreamTimings(opts) {
  const windowMs =
    Number(opts?.sttStreamWindowMs) > 0
      ? Math.floor(Number(opts.sttStreamWindowMs))
      : STREAMING_MODE_DEFAULTS.windowMs;
  const cadenceMs =
    Number(opts?.sttStreamStepMs) > 0
      ? Math.floor(Number(opts.sttStreamStepMs))
      : STREAMING_MODE_DEFAULTS.cadenceMs;
  return { windowMs, cadenceMs };
}

// Warm-lease policy for streaming dictation (stage-2 follow-up): the shared
// whisper-server lease stays loaded across finalize/cancel and is released
// only when the server itself is at fault, on model/language change, or on
// plugin unload. Per-dictation failures (capture/mic) preserve the lease.

// Error codes where the mic/capture failed but the server is healthy.
const STREAMING_PER_DICTATION_CODES = new Set([
  "CAPTURE_FAILED",
  "CAPTURE_SPAWN_ENOENT",
  "CAPTURE_SPAWN_FAILED",
  "CAPTURE_SPAWN_ERROR",
  "CAPTURE_EXITED",
  "AUDIO_SPOOL_OVERFLOW",
]);

export function isStreamingServerFault(err) {
  if (!err) return false;
  const code = typeof err === "string" ? null : err?.code || null;
  if (code && STREAMING_PER_DICTATION_CODES.has(code)) return false;
  const message = typeof err === "string" ? err : err?.message || "";
  if (/^capture|^sox|^mic/i.test(message || "")) return false;
  // Any explicit error object/string beyond per-dictation capture faults is
  // treated as server-side (NOT_READY, START_TIMEOUT, PORT_IN_USE,
  // SERVER_BINARY_MISSING, BAD_STATUS, REQUEST_FAILED, STOP_NOT_READY,
  // STOP_FINAL_TIMEOUT, TRANSCRIBE_*). Absence of error means healthy.
  return true;
}

export function streamModelKey(modelPath, language, port) {
  const base = `${modelPath || ""}::${language || "auto"}`;
  // The bound whisper-server port is part of the warm-lease identity: two
  // TUIs are separate processes (no shared state), but within one process
  // leases on different ports must not be mistaken for each other. Omitted
  // port keeps the legacy "model::language" form.
  return port === undefined || port === null ? base : `${base}::${port}`;
}

export function getSttApiConfig() {
  return sttApiEndpoint && sttApiModel
    ? { endpoint: sttApiEndpoint, model: sttApiModel, apiKeyEnv: sttApiKeyEnv }
    : null;
}

export function getTmpDir() {
  return tmpDir;
}

// ---- Sticky recording toast (Option A: polling to simulate persistence) ----
// ---- Sticky processing toast (Transcribing... / Normalizing...) ----
// Single-shot toasts (duration 3000ms) expire long before whisper/LLM finish,
// leaving a silent gap where the user thinks STT died. Poll like the recording
// toast so the stage stays visible until it completes.

let processingToastTimer = null;
let processingToastFn = null;
let processingMessage = "";
const PROCESSING_TOAST_DURATION = 3000;
const PROCESSING_TOAST_INTERVAL = 2500;

let recordingToastTimer = null;
let recordingToastFn = null;
const RECORDING_TOAST_BASE = "● Recording";
const RECORDING_TOAST_DURATION = 3000;
const RECORDING_TOAST_INTERVAL = 2500;
// Live wave + timer config (PR2)
let recordingStartMs = null;
let prevWaveLevels = [];
let noiseFloorRms = null;
let calibrationEndMs = null;
const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_LEN = 16;
const WAVE_INTERVAL = 35;
const WAVE_DURATION = 70;
let useWave = true;
// v2's toast API has no update/replace: every call stacks as a new
// notification, so the v1 polling pattern becomes a toast storm. v2 shows
// live state in the slot preview instead and uses one-shot toasts.
let toastPolling = true;

export function __setToastPolling(v) {
  toastPolling = !!v;
}

export function __setRecordingToastFn(fn) {
  recordingToastFn = fn;
}

export function __clearRecordingToastState() {
  if (recordingToastTimer) {
    clearInterval(recordingToastTimer);
    recordingToastTimer = null;
  }
  recordingToastFn = null;
  recordingStartMs = null;
  prevWaveLevels = [];
  noiseFloorRms = null;
  calibrationEndMs = null;
}

export function __setUseWave(v) {
  useWave = !!v;
}

export function isRecordingToastActive() {
  return recordingToastTimer !== null;
}

export function __setProcessingToastFn(fn) {
  processingToastFn = fn;
}

export function __clearProcessingToastState() {
  if (processingToastTimer) {
    clearInterval(processingToastTimer);
    processingToastTimer = null;
  }
  processingToastFn = null;
  processingMessage = "";
}

export function isProcessingToastActive() {
  return processingToastTimer !== null;
}

export function showProcessingToast(message) {
  clearProcessingToast();
  processingMessage = message;
  if (!processingToastFn) return;
  processingToastFn({
    message: processingMessage,
    variant: "info",
    duration: PROCESSING_TOAST_DURATION,
  });
  if (!toastPolling) return;
  processingToastTimer = setInterval(() => {
    if (processingToastFn) {
      processingToastFn({
        message: processingMessage,
        variant: "info",
        duration: PROCESSING_TOAST_DURATION,
      });
    }
  }, PROCESSING_TOAST_INTERVAL);
}

export function updateProcessingToast(message) {
  if (!isProcessingToastActive()) {
    showProcessingToast(message);
    return;
  }
  processingMessage = message;
  if (processingToastFn) {
    processingToastFn({
      message: processingMessage,
      variant: "info",
      duration: PROCESSING_TOAST_DURATION,
    });
  }
}

export function clearProcessingToast() {
  if (processingToastTimer) {
    clearInterval(processingToastTimer);
    processingToastTimer = null;
  }
}

// ---- Sticky streaming status (never-silent dictation) ----
// Streaming dictation previously showed one 3s toast on start, then silence
// until the next partial/finalize - long cold loads and slow ticks read as
// crashes. This reuses the polling-toast pattern above: one sticky status,
// re-emitted before the single-shot duration expires, with an elapsed timer
// so every state (loading / live / finalizing) stays visibly alive.
// Partial preview toasts (🎙 ...) continue alongside, not instead.
// Privacy-safe: elapsed time + state words only, never audio paths/secrets.

let streamingToastTimer = null;
let streamingToastFn = null;
let streamingToastBase = "";
let streamingToastStartMs = null;
let streamingLastPartialMs = null;
let lastPartialText = null;
let lastAudioActiveMs = null;
let streamingSlowAfterMs = 2000;
const STREAMING_TOAST_DURATION = 3000;
const STREAMING_TOAST_INTERVAL = 2500;

export function __setStreamingToastFn(fn) {
  streamingToastFn = fn;
}

export function __clearStreamingToastState() {
  if (streamingToastTimer) {
    clearInterval(streamingToastTimer);
    streamingToastTimer = null;
  }
  streamingToastFn = null;
  streamingToastBase = "";
  streamingToastStartMs = null;
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
  lastPartialText = null;
}

export function isStreamingToastActive() {
  return streamingToastTimer !== null;
}

function buildStreamingMessage() {
  const elapsed =
    streamingToastStartMs === null ? "00:00" : formatElapsed(Date.now() - streamingToastStartMs);
  let message = `${streamingToastBase} · ${elapsed}`;
  // Slow-tick note: no partial for ~2x cadence while live - the mic is fine,
  // the inference is just slow. Trivially detectable via last-partial time.
  if (
    streamingLastPartialMs !== null &&
    Date.now() - streamingLastPartialMs > streamingSlowAfterMs
  ) {
    message += " (listening…)";
  }
  return message;
}

function emitStreamingToast() {
  if (!streamingToastFn) return;
  streamingToastFn({
    message: buildStreamingMessage(),
    variant: "info",
    duration: STREAMING_TOAST_DURATION,
  });
}

export function showStreamingToast(message, { slowAfterMs } = {}) {
  clearStreamingToast();
  streamingToastBase = message;
  streamingToastStartMs = Date.now();
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
  lastPartialText = null;
  if (Number(slowAfterMs) > 0) streamingSlowAfterMs = Math.floor(Number(slowAfterMs));
  if (!streamingToastFn) return;
  sttLog("toast.streaming", `base=${streamingToastBase} polling=${toastPolling}`);
  emitStreamingToast();
  if (!toastPolling) return;
  streamingToastTimer = setInterval(() => {
    emitStreamingToast();
  }, STREAMING_TOAST_INTERVAL);
}

export function updateStreamingToast(message) {
  if (!isStreamingToastActive()) {
    showStreamingToast(message);
    return;
  }
  streamingToastBase = message;
  emitStreamingToast();
}

export function noteStreamingPartial(partial) {
  // Don't reset the silence timer if the partial is identical to the
  // previous one - whisper hallucinating on silence (repeating the same
  // phrase) must not keep the auto-end timer alive.
  const text = partial ? `${partial.stableText || ""} ${partial.tentativeText || ""}`.trim() : "";
  if (text && text === lastPartialText) return;
  lastPartialText = text;
  streamingLastPartialMs = Date.now();
}

export function clearStreamingToast() {
  if (streamingToastTimer) {
    clearInterval(streamingToastTimer);
    streamingToastTimer = null;
  }
  streamingToastBase = "";
  streamingToastStartMs = null;
  streamingLastPartialMs = null;
  lastAudioActiveMs = null;
}

export function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function rmsToChar(rms) {
  if (rms < 0.008) return WAVE_CHARS[0];
  if (rms < 0.018) return WAVE_CHARS[1];
  if (rms < 0.035) return WAVE_CHARS[2];
  if (rms < 0.06) return WAVE_CHARS[3];
  if (rms < 0.1) return WAVE_CHARS[4];
  if (rms < 0.16) return WAVE_CHARS[5];
  if (rms < 0.24) return WAVE_CHARS[6];
  return WAVE_CHARS[7];
}

export function rmsToLevel(rms) {
  if (rms < 0.008) return 0;
  if (rms < 0.018) return 1;
  if (rms < 0.035) return 2;
  if (rms < 0.06) return 3;
  if (rms < 0.1) return 4;
  if (rms < 0.16) return 5;
  if (rms < 0.24) return 6;
  return 7;
}

export function computeWaveChar() {
  // kept for tests / fallback single-char
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  try {
    const data = fs.readFileSync(wavFile);
    if (data.length <= 44) return WAVE_CHARS[0];
    const windowSize = 2560;
    const start = Math.max(44, data.length - windowSize);
    const slice = data.subarray(start);
    const samples = Math.floor(slice.length / 2);
    if (samples === 0) return WAVE_CHARS[0];
    let sum = 0;
    for (let i = 0; i < slice.length - 1; i += 2) {
      const s = slice.readInt16LE(i);
      const n = s / 32768;
      sum += n * n;
    }
    const rms = Math.sqrt(sum / samples);
    if (rms < 0.003) return WAVE_CHARS[0];
    return rmsToChar(rms);
  } catch {
    return WAVE_CHARS[0];
  }
}

export function getWaveString() {
  // Fixed-column snapshot: each column = noise-gated RMS of sub-slice of last ~0.08s window
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  try {
    let slice;
    try {
      const fd = fs.openSync(wavFile, "r");
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize <= 44) {
        fs.closeSync(fd);
        prevWaveLevels = Array(WAVE_LEN).fill(0);
        return WAVE_CHARS[0].repeat(WAVE_LEN);
      }
      const windowSize = 1024; // ~0.032s — ultra instant for toast
      const readSize = Math.min(windowSize, fileSize - 44);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
      fs.closeSync(fd);
      slice = buf;
    } catch {
      const data = fs.readFileSync(wavFile);
      if (data.length <= 44) {
        prevWaveLevels = Array(WAVE_LEN).fill(0);
        return WAVE_CHARS[0].repeat(WAVE_LEN);
      }
      const windowSize = 1024;
      const start = Math.max(44, data.length - windowSize);
      slice = data.subarray(start);
    }
    const chunkBytes = Math.max(2, Math.floor(slice.length / WAVE_LEN));
    const rawRms = [];
    const levels = [];
    for (let c = 0; c < WAVE_LEN; c++) {
      const off = c * chunkBytes;
      const chunk = slice.subarray(off, Math.min(off + chunkBytes, slice.length));
      const samples = Math.floor(chunk.length / 2);
      if (samples === 0) {
        rawRms.push(0);
        continue;
      }
      let sum = 0;
      for (let i = 0; i < chunk.length - 1; i += 2) {
        const s = chunk.readInt16LE(i);
        const n = s / 32768;
        sum += n * n;
      }
      const rms = Math.sqrt(sum / samples);
      rawRms.push(rms);
    }
    // calibration: first 120ms estimates fan noise floor, but still show live wave
    const now = Date.now();
    if (calibrationEndMs && now < calibrationEndMs) {
      const minRms = Math.min(...rawRms);
      if (noiseFloorRms === null || minRms < noiseFloorRms) noiseFloorRms = minRms;
    }
    if (noiseFloorRms === null) noiseFloorRms = Math.min(...rawRms);
    else {
      // slowly adapt noise floor down (fan may vary) but never jump up quickly
      const minRms = Math.min(...rawRms);
      // if we see a consistently lower min for 500ms, drift down 5%
      noiseFloorRms = Math.min(noiseFloorRms, minRms);
      noiseFloorRms = noiseFloorRms * 0.995 + minRms * 0.005;
    }
    // console.log(`[wave] noiseFloor=${noiseFloorRms?.toFixed(4)} rawMin=${Math.min(...rawRms).toFixed(4)} rawMax=${Math.max(...rawRms).toFixed(4)}`);
    for (const rms of rawRms) {
      const effective = Math.max(0, rms - noiseFloorRms * 1.15);
      // gate: very small effective still flat — fan residue
      if (effective < 0.005) levels.push(0);
      else levels.push(rmsToLevel(effective * 1.6)); // 1.6x gain makes voice pop higher
    }
    // instant attack, very fast decay (0.2) → fan doesn't linger, voice explicit
    if (prevWaveLevels.length !== WAVE_LEN) prevWaveLevels = Array(WAVE_LEN).fill(0);
    const smoothed = levels.map((lvl, i) => {
      const prev = prevWaveLevels[i] || 0;
      if (lvl > prev) return lvl; // instant rise
      const decayed = Math.floor(prev * 0.2);
      return lvl > decayed ? lvl : decayed;
    });
    prevWaveLevels = smoothed.slice();
    return smoothed.map((l) => WAVE_CHARS[l]).join("");
  } catch {
    prevWaveLevels = Array(WAVE_LEN).fill(0);
    return WAVE_CHARS[0].repeat(WAVE_LEN);
  }
}

// ---- Streaming waveform (live transcript + wave) ----
// The batch meter samples a WAV file on disk; streaming keeps PCM in memory,
// so the controller exposes its newest tail instead. Same thresholds and
// noise-floor gating as the batch meter, with slightly slower decay because
// this samples at ~80 ms rather than ~35 ms.

const STREAM_WAVE_BYTES = 2560; // ~80 ms of 16 kHz mono 16-bit PCM
let streamWavePrev = [];
let streamNoiseFloor = null;

export function __resetStreamWave() {
  streamWavePrev = [];
  streamNoiseFloor = null;
}

export function waveLevelsFromPcm(pcm) {
  if (!pcm || pcm.length < 2) return Array(WAVE_LEN).fill(0);
  const chunkBytes = Math.max(2, Math.floor(pcm.length / WAVE_LEN));
  const raw = [];
  for (let column = 0; column < WAVE_LEN; column++) {
    const offset = column * chunkBytes;
    if (offset >= pcm.length) {
      raw.push(0);
      continue;
    }
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    const samples = Math.floor(chunk.length / 2);
    if (samples === 0) {
      raw.push(0);
      continue;
    }
    let sum = 0;
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    raw.push(Math.sqrt(sum / samples));
  }
  const floor = Math.min(...raw);
  if (streamNoiseFloor === null) streamNoiseFloor = floor;
  else streamNoiseFloor = Math.min(streamNoiseFloor, floor) * 0.995 + floor * 0.005;
  const levels = raw.map((rms) => {
    const effective = Math.max(0, rms - streamNoiseFloor * 1.15);
    if (effective < 0.005) return 0;
    return rmsToLevel(effective * 1.6);
  });
  if (streamWavePrev.length !== WAVE_LEN) streamWavePrev = Array(WAVE_LEN).fill(0);
  const smoothed = levels.map((level, index) => {
    const prev = streamWavePrev[index] || 0;
    if (level > prev) return level;
    const decayed = Math.floor(prev * 0.35);
    return level > decayed ? level : decayed;
  });
  streamWavePrev = smoothed;
  return smoothed;
}

let currentRecordKeybind = "<leader>[";
export function __setRecordKeybind(kb) {
  if (kb) currentRecordKeybind = kb.replace(/^<leader>/, "leader+");
}

// Temporary stop-hint override for voice conversation mode, whose key differs
// from stt.record. Pass null to restore the previous hint.

let savedRecordKeybind = null;
export function __setStopHint(hint) {
  if (hint) {
    if (savedRecordKeybind === null) savedRecordKeybind = currentRecordKeybind;
    __setRecordKeybind(hint);
  } else if (savedRecordKeybind !== null) {
    currentRecordKeybind = savedRecordKeybind;
    savedRecordKeybind = null;
  }
}
function recordingModeSuffix() {
  // When the conversation loop overrides the stop hint, the toast says so
  // explicitly - otherwise users wonder why it names a key they did not press.
  return savedRecordKeybind !== null ? " (conversation)" : "";
}

export function buildRecordingMessage() {
  const mode = recordingModeSuffix();
  if (!useWave || recordingStartMs === null)
    return `${RECORDING_TOAST_BASE}${mode} · ${currentRecordKeybind} to stop`;
  const elapsed = formatElapsed(Date.now() - recordingStartMs);
  const wave = getWaveString();
  return `${RECORDING_TOAST_BASE}${mode}  ${wave}  ${elapsed} · ${currentRecordKeybind} to stop`;
}

export function showRecordingToast() {
  clearRecordingToast();
  if (!recordingToastFn) return;
  sttLog("toast.recording", `polling=${toastPolling} wave=${useWave}`);
  recordingStartMs = Date.now();
  prevWaveLevels = Array(WAVE_LEN).fill(0);
  noiseFloorRms = null;
  calibrationEndMs = Date.now() + 120;
  if (!toastPolling) {
    recordingToastFn({
      message: `${RECORDING_TOAST_BASE}${recordingModeSuffix()} · ${currentRecordKeybind} to stop`,
      variant: "info",
      duration: RECORDING_TOAST_DURATION,
    });
    return;
  }
  const interval = useWave ? WAVE_INTERVAL : RECORDING_TOAST_INTERVAL;
  const duration = useWave ? WAVE_DURATION : RECORDING_TOAST_DURATION;
  recordingToastFn({
    message: buildRecordingMessage(),
    variant: "info",
    duration,
  });
  recordingToastTimer = setInterval(() => {
    if (recordingToastFn) {
      recordingToastFn({
        message: buildRecordingMessage(),
        variant: "info",
        duration,
      });
    }
  }, interval);
}

export function clearRecordingToast() {
  if (recordingToastTimer) {
    clearInterval(recordingToastTimer);
    recordingToastTimer = null;
  }
  recordingStartMs = null;
  noiseFloorRms = null;
  calibrationEndMs = null;
}

export function createRemoteBatchCapture(child, writer) {
  let bytes = 0;
  let stderr = "";
  let failure = null;
  let stopped = false;
  let closed = false;
  let flushed = false;
  let exitCode = null;
  let exitSignal = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function settle() {
    if (!closed || !flushed) return;
    let error = failure;
    if (!error && exitCode === 255) error = "Remote audio transport failed (SSH exit 255)";
    if (!error && exitCode !== null && exitCode !== 0) {
      error = `Remote phone capture failed (exit ${exitCode})`;
    }
    if (!error && exitSignal && !stopped) error = `Remote capture interrupted (${exitSignal})`;
    if (!error && bytes === 0) error = "Remote capture received no PCM audio; check phone recorder";
    if (!error && bytes % 2 !== 0) error = "Remote capture received incomplete 16-bit PCM audio";
    resolveDone({ error, bytes, stderr, code: exitCode, signal: exitSignal });
  }
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
  });
  child.stdout.on("error", (err) => {
    failure = `Remote audio read failed: ${err.message}`;
    child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.on("error", (err) => {
    failure = `Remote capture failed to start: ${err.message}`;
  });
  writer.on("error", (err) => {
    failure = `Remote audio write failed: ${err.message}`;
    flushed = true;
    child.kill("SIGTERM");
    settle();
  });
  writer.on("finish", () => {
    flushed = true;
    settle();
  });
  // 'exit' can precede trailing stdout. Only 'close' guarantees child pipes
  // have drained; writer 'finish' separately guarantees all PCM reached disk.
  child.on("close", (code, signal) => {
    closed = true;
    exitCode = code;
    exitSignal = signal;
    if (!writer.writableEnded && !writer.destroyed) writer.end();
    settle();
  });
  child.stdout.pipe(writer);
  return {
    done,
    stop(signal = "SIGINT") {
      stopped = true;
      child.kill(signal);
    },
  };
}

function forceKillSox(logger) {
  if (remoteBatchCapture) {
    try {
      remoteBatchCapture.stop("SIGKILL");
    } catch {}
    remoteBatchCapture = null;
  }
  if (soxProc) {
    try {
      process.kill(soxProc.pid, "SIGKILL");
      logger?.log("STT", `Killed sox pid=${soxProc.pid}`, "debug");
    } catch {}
    soxProc = null;
  }
}

function startRecording(
  kv,
  backend,
  toast,
  logger,
  trimSilence = true,
  silenceStopSec = null,
  onStopped = null,
) {
  if (soxProc) {
    logger?.log("STT", "Start recording skipped: sox already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillSox(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  soxStderr = "";
  const captureCmd = getSttCaptureCmd();
  const sampleRate = getAudioSampleRate();
  if (captureCmd) {
    const pcmFile = path.join(tmpDir, `opencode-stt-${process.pid}-${Date.now()}.pcm`);
    try {
      fs.unlinkSync(pcmFile);
    } catch {}
    soxStderr = "";
    const spawnT0 = Date.now();
    sttLog("STT", "Starting remote batch capture");
    const ws = fs.createWriteStream(pcmFile, { flags: "a" });
    soxProc = spawn(captureCmd[0], captureCmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = soxProc;
    const capture = createRemoteBatchCapture(child, ws);
    remoteBatchCapture = capture;
    capture.done.then((result) => {
      sttLog(
        "STT",
        `remote capture drained code=${result.code} signal=${result.signal} totalBytes=${result.bytes} elapsedMs=${Date.now() - spawnT0}`,
      );
      if (soxProc !== child) {
        // A newer capture took ownership; leave its state untouched.
        return;
      }
      soxProc = null;
      remoteBatchCapture = null;
      soxStderr = result.stderr;
      if (result.error) {
        sttLog(
          "STT",
          `remote capture failed: ${result.error} stderr=${(result.stderr || "").trim().slice(-200)}`,
          "warn",
        );
      }
      if (recording && !processing) {
        recording = false;
        clearRecordingToast();
        toast(
          result.error || "Remote recording stopped unexpectedly",
          result.error ? "error" : "warning",
        );
      }
    });
    // track pcm file for conversion in transcribeTurn via module var
    remotePcmFile = pcmFile;
    logger?.log(
      "STT",
      `remote capture spawned pid=${soxProc?.pid} after ${Date.now() - spawnT0}ms`,
      "debug",
    );
    recording = true;
    return;
  }

  const mic = kv.get("stt.mic", "") || null;
  const inputArgs = buildRecordArgs(backend, mic);
  const spawnT0 = Date.now();
  logger?.log(
    "STT",
    `Starting recording backend=${backend} mic=${mic || "system default"} silenceStop=${silenceStopSec ?? "off"}`,
    "debug",
  );

  // Trim leading silence, then (optionally) auto-stop after N seconds of
  // silence so hands-free modes (conversation) can finalize without a keypress.
  const silenceArgs = trimSilence ? ["silence", "1", "0.05", "1%"] : [];
  if (silenceStopSec && silenceStopSec > 0) {
    silenceArgs.push("1", String(silenceStopSec), "1%");
  }
  soxProc = spawn(
    "sox",
    [...inputArgs, "-r", String(sampleRate), "-c", "1", "-b", "16", wavFile, ...silenceArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );
  logger?.log("STT", `sox spawned pid=${soxProc?.pid} after ${Date.now() - spawnT0}ms`, "debug");

  let firstStderrLogged = false;
  soxProc.stderr.on("data", (chunk) => {
    if (!firstStderrLogged) {
      firstStderrLogged = true;
      logger?.log("STT", `sox first output after ${Date.now() - spawnT0}ms`, "debug");
    }
    soxStderr += chunk.toString();
  });

  soxProc.on("error", (err) => {
    soxProc = null;
    logger?.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      clearRecordingToast();
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    logger?.log(
      "STT",
      `sox exited code=${code} stderr=${soxStderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && !processing) {
      recording = false;
      clearRecordingToast();
      if (code !== 0 && code !== null) {
        const errLine = soxStderr.trim().split("\n").pop();
        toast(
          `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
          "error",
        );
      } else {
        // Normal exit (including silence auto-stop): fire the onStopped
        // callback if registered, otherwise show the generic toast.
        if (typeof onStopped === "function") {
          try {
            onStopped();
          } catch {}
        } else {
          toast("Recording stopped unexpectedly", "warning");
        }
      }
    }
  });

  recording = true;
}

function stopRecording(logger) {
  logger?.log("STT", "Stopping recording", "debug");
  if (remoteBatchCapture && soxProc) remoteBatchCapture.stop();
  else if (soxProc) soxProc.kill("SIGINT");
}

async function waitForSoxExit(logger, timeoutMs = 2000) {
  if (remoteBatchCapture) {
    const capture = remoteBatchCapture;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        capture.stop("SIGKILL");
        resolve({ error: "Remote capture shutdown timed out before PCM drain" });
      }, timeoutMs);
    });
    const result = await Promise.race([capture.done, timeout]);
    clearTimeout(timer);
    if (remoteBatchCapture === capture) remoteBatchCapture = null;
    return result;
  }
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) {
    logger?.log("STT", "sox did not stop before timeout", "warn");
    forceKillSox(logger);
  }
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

export function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

export function getLanguage(kv) {
  return kv.get("stt.language") || sttDefaultLanguage;
}

export function buildWhisperArgs(modelPath, wavFile, language) {
  return ["-m", modelPath, "-f", wavFile, "-l", language || DEFAULT_LANGUAGE, "-np", "-nt"];
}

// Transcribe an arbitrary WAV file with local whisper-cli. Generalized out of
// the one-shot `transcribe()` path so live notes can transcribe its own
// per-chunk WAV files with the same model/language resolution and error
// handling, without depending on the one-shot recording's tmpDir/state.

export function transcribeFileLocal(wavFile, modelPath, language, logger) {
  logger?.log(
    "STT",
    `Local transcription requested model=${modelPath} language=${language}`,
    "debug",
  );
  if (!fs.existsSync(modelPath)) {
    logger?.log("STT", `Whisper model missing: ${modelPath}`, "error");
    return Promise.resolve({
      error: `Model not found: ${modelPath}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", buildWhisperArgs(modelPath, wavFile, language), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

function transcribe(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  return transcribeFileLocal(wavFile, getModelPath(kv), getLanguage(kv), logger);
}

export const STT_SYSTEM_PROMPT = `You are a DETERMINISTIC speech-to-text normalizer for a coding assistant CLI. You are NOT a chatbot. You NEVER answer, explain, greet back, or introduce yourself.

Task: Return ONLY what the user meant to say, cleaned up for use as their message. Fix what the speech recognizer misheard, not just punctuation. No reply. No extra sentences.

Strict rules:
- Output is the user's utterance, cleaned. It is NOT a response to the user.
- Fix punctuation, capitalization, grammar.
- Remove filler words (um, uh, like, you know, etc.).
- Keep technical terms, file names, and code references exact.
- If the user is dictating code, format it appropriately.
- INTERPRET misheard words: speech recognition often produces acoustically-close-but-wrong words ("they face" for "database", "bait" for "page"). Replace a word or short phrase ONLY when ALL of these hold: (1) it sounds similar to the replacement, (2) the <knowledge> conversation context or the domain lists below support the replacement, (3) the sentence makes clearly more sense with it. Otherwise leave the original words untouched.
- Use the <knowledge> conversation context to resolve ambiguous names, pronouns, references, AND misheard content words (that function, the file, it; e.g. Cristina uses he/him if the conversation says so) - never copy unrelated facts from the context into the output.
- Output ONLY the cleaned text, nothing else. No quotes, no prefixes, no suffixes.
- Do NOT add greetings, introductions, offers to help, questions, or commentary.
- Do NOT expand short inputs. Keep output length close to input length (within ~30%); do not add paragraphs or new requests the user did not make.
- If input is a short greeting/noise like "hey", "hello", "hi", "hey there", output exactly that greeting capitalized with a period (e.g., "hey" -> "Hey.") — DO NOT expand to "Hello! I am an AI..." or add self-introduction.

Examples (follow exactly):
Input: "hey"
Output: Hey.

Input: "hello there"
Output: Hello there.

Input: "umm add tests for the a sink user service"
Output: Add tests for the async user service.

Input: "check the locks for the doc container"
Output: Check the logs for the Docker container.

Input: "craft a notion bait tracking our work items"
Output: Craft a Notion page tracking our work items.

Input: "check the notion they face for the next phase target"
Output: Check the Notion database for the next phase target.

If you cannot normalize, return the input trimmed.

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

WORKFLOW VOCABULARY - the user works with these tools; prefer these terms when the transcript sounds similar:
- "bait" / "paid" -> "page" (in Notion contexts)
- "they face" / "data base" -> "database"
- "phase target" - keep as-is (not "face target")
- "master" - keep as-is (git branch, not "muster")
- "commit" - keep as-is (not "comet")
- "notion" - keep as-is (not "motion" / "ocean")

Rely heavily on context to fix words that sound similar to programming terminology.`;

// Strict mode: the old transcribe-exactly behavior (no reinterpretation).
// Opt in via "sttNormalizeMode": "strict".

export const STT_SYSTEM_PROMPT_STRICT = `You are a DETERMINISTIC speech-to-text normalizer for a coding assistant CLI. You are NOT a chatbot. You NEVER answer, explain, greet back, or introduce yourself.

Task: Return ONLY the cleaned version of the user's spoken words — exactly what they said, with punctuation and homophone fixes. No reply. No extra sentences.

Strict rules:
- Output is the user's utterance, cleaned. It is NOT a response to the user.
- Fix punctuation, capitalization, grammar minimally.
- Remove filler words (um, uh, like, you know, etc.).
- Keep technical terms, file names, and code references exact.
- If the user is dictating code, format it appropriately.
- Use the <knowledge> conversation context only to resolve ambiguous names, pronouns, and references (that function, the file, it; e.g. Cristina uses he/him if the conversation says so) — do not invent new content and never copy facts from the context into the output.
- Output ONLY the cleaned text, nothing else. No quotes, no prefixes, no suffixes.
- Do NOT add greetings, introductions, offers to help, questions, or commentary.
- Do NOT expand short inputs. Keep output length close to input length; do not add paragraphs.
- If input is a short greeting/noise like "hey", "hello", "hi", "hey there", output exactly that greeting capitalized with a period (e.g., "hey" -> "Hey.") — DO NOT expand to "Hello! I am an AI..." or add self-introduction.

Examples (follow exactly):
Input: "hey"
Output: Hey.

Input: "hello there"
Output: Hello there.

Input: "umm add tests for the a sink user service"
Output: Add tests for the async user service.

Input: "check the locks for the doc container"
Output: Check the logs for the Docker container.

If you cannot normalize, return the input trimmed.

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

export function selectSttSystemPrompt(mode, custom) {
  if (custom) return custom;
  return mode === "strict" ? STT_SYSTEM_PROMPT_STRICT : STT_SYSTEM_PROMPT;
}

// Live notes: cleans ONE chunk of a continuous recording (meeting, lecture)
// into readable prose. Different job than STT_SYSTEM_PROMPT's "message to
// submit" framing - this is note-taking, so it must not shorten, summarize,
// or address anyone; it stays close to what was actually said.

export const NOTES_SYSTEM_PROMPT = `You are a DETERMINISTIC transcript cleaner for a live meeting/lecture note-taking tool. You are NOT a chatbot. You NEVER answer, summarize, or add commentary.

Task: Clean up ONE short segment of a continuous spoken recording (already split from a longer session) into readable, accurate prose for a written transcript.

Rules:
- Fix punctuation, capitalization, and speech-recognition mistakes (words that sound similar to the correct word), using the <knowledge> context (the tail of the immediately preceding segment) when it helps.
- Preserve facts, names, numbers, and technical terms exactly. Do not translate the spoken language.
- Remove filler words (um, uh, like, you know) and false starts/stutters, but keep everything else the speaker said - do NOT shorten, paraphrase, or summarize. This is a transcript, not a summary.
- Output length must stay close to the input length (within ~20%).
- If the segment is empty, pure noise, or a speech-recognizer hallucination on silence (e.g. "Thank you for watching", "[Music]", "Subscribe", "Thanks for watching!"), output nothing.
- Output ONLY the cleaned segment text. No labels, no quotes, no timestamps, no commentary.

If you cannot clean it, return the input trimmed.`;

// whisper.cpp loves to "hear" YouTube outros on quiet/noise - English AND
// Vietnamese training data leaks through. Real lecture speech is rarely an
// exact outro CTA, so phrase-level matches are safe to drop.
const NOTES_HALLUCINATION_PATTERNS = [
  /thank(s| you) for watching/i,
  /thanks for watching/i,
  /please (subscribe|like and subscribe)/i,
  /see you (next time|in the next video)/i,
  /^\[.*?(music|applause|noise|silence|blank_audio).*?\]$/i,
  // Vietnamese YouTube-outro hallucinations (seen verbatim in real sessions)
  /hãy subscribe cho kênh/i,
  /đăng k[ýy] kênh/i,
  /ủng hộ kênh/i,
  /ghiền mì gõ/i,
  /đừng quên (like|đăng k[ýy]|nhấn)/i,
  /nhấn chuông/i,
  /video hấp dẫn/i,
  /cảm ơn .* (xem|theo dõi)/i,
  /các bạn hãy .* kênh của mình nhé/i,
];

export function isLikelyWhisperHallucination(text) {
  const t = (text || "").trim();
  if (!t || t.length > 140) return false;
  return NOTES_HALLUCINATION_PATTERNS.some((re) => re.test(t));
}

const STT_HALLUCINATION_PATTERNS = [
  /I am (an )?AI/i,
  /as an AI/i,
  /language model/i,
  /nice to meet you/i,
  /how can I help/i,
  /hello! I am/i,
  /I'm here to help/i,
];

function isHallucinated(raw, normalized) {
  if (!normalized) return false;
  if (STT_HALLUCINATION_PATTERNS.some((re) => re.test(normalized))) return true;
  // blow-up: short input -> long output is hallucination (e.g., "hey" -> paragraph)
  if (raw.length <= 20 && normalized.length > raw.length * 4 + 20) return true;
  if (raw.length <= 10 && normalized.split(/\s+/).length > 10) return true;
  return false;
}

function fallbackForRaw(raw) {
  return raw.trim();
}

export async function normalizeTranscription(
  complete,
  rawText,
  contextBlock,
  systemPrompt,
  logger,
) {
  logger?.log(
    "STT",
    `Normalizing transcription chars=${rawText.length} contextChars=${contextBlock?.length || 0}`,
    "debug",
  );
  const prompt = contextBlock
    ? `<knowledge>\n${contextBlock}\n</knowledge>\n<task>Clean up this speech-to-text transcription:\n\n${rawText}</task>`
    : `Clean up this speech-to-text transcription:\n\n${rawText}`;
  const result = await Promise.race([
    complete({
      system: systemPrompt,
      prompt,
      // Spoken turns are short; a tight cap bounds worst-case latency so a
      // rambling model cannot stall the turn (overrides global maxTokens).
      config: { temperature: 0, maxTokens: 1024 },
    }),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            text: null,
            error: `Normalization timed out after ${sttNormalizeTimeoutMs}ms`,
            timedOut: true,
          }),
        sttNormalizeTimeoutMs,
      ),
    ),
  ]);
  if (result?.timedOut) {
    logger?.log("STT", `Normalization timeout after ${sttNormalizeTimeoutMs}ms, using raw`, "warn");
  }
  if (result.text && isHallucinated(rawText, result.text)) {
    logger?.log(
      "STT",
      `Hallucination detected rawLen=${rawText.length} normalizedLen=${result.text.length} -> fallback`,
      "warn",
    );
    return { text: fallbackForRaw(rawText) };
  }
  return result;
}

async function getApiModels(logger) {
  if (!sttApiEndpoint) return [];
  try {
    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}models`
      : `${sttApiEndpoint}/models`;
    const headers = {};
    if (sttApiKeyEnv && process.env[sttApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[sttApiKeyEnv];
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    logger?.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || [])
      .filter((m) => m.id && /whisper/i.test(m.id))
      .map((m) => ({ value: m.id, label: m.id }));
  } catch (err) {
    logger?.log("STT", `Failed to fetch STT API models: ${err.message}`, "error");
    return [];
  }
}

export async function transcribeApiFile(wavFile, endpoint, model, apiKeyEnv, logger) {
  if (!endpoint || !model) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  logger?.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(endpoint);

    const url = endpoint.endsWith("/")
      ? `${endpoint}audio/transcriptions`
      : `${endpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody);
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

async function transcribeApi(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const model = kv.get("stt.api.model") || sttApiModel;
  return transcribeApiFile(wavFile, sttApiEndpoint, model, sttApiKeyEnv, logger);
}

/**
 * Which path owns silence auto-end for the current streaming session.
 * Conversation mode always wins: the plain dictation path submits the text
 * directly, which bypasses the conversation turn (no reply wait, no speech,
 * UI stuck on "Listening"). While a conversation is active the timer either
 * finishes the turn through the conversation callback or stays off - it never
 * falls back to that submit.
 */
export function streamAutoEndRoute({
  conversation,
  conversationStopSec,
  conversationOnStopped,
  previewAutoEnd,
}) {
  if (conversation) {
    const enabled = conversationStopSec > 0 || previewAutoEnd === true;
    return enabled && typeof conversationOnStopped === "function" ? "conversation" : "off";
  }
  return previewAutoEnd === true ? "dictation" : "off";
}

export function insertIntoFocusedInput(renderer, text, submit = false) {
  const focused = renderer?.currentFocusedRenderable;
  if (!focused || typeof focused.insertText !== "function") return false;

  try {
    focused.insertText(text);
    if (submit && typeof focused.submit === "function") focused.submit();
    return true;
  } catch {
    return false;
  }
}

async function appendTranscription(client, renderer, text, submit, isCurrent) {
  if (insertIntoFocusedInput(renderer, text, submit)) {
    return true;
  }

  // Only the v2 adapter consumes this fence; v1 request bodies remain
  // unchanged. Re-check after an asynchronous home session create. The
  // `submit` flag lets the adapter distinguish an explicit submit from a
  // plain append with no editable field focused (append must not send).
  const fence = client.tui?.v2 ? { isCurrent, submit } : {};
  let appendResult = await client.tui.appendPrompt({ body: { text }, ...fence });

  if (appendResult?.error?.data?.message === "Expected object, got undefined") {
    appendResult = await client.tui.appendPrompt({ text });
  }

  if (appendResult?.error) {
    throw new Error(
      `appendPrompt failed: ${appendResult.error.data?.message || appendResult.error.name}`,
    );
  }

  if (appendResult?.retained) return appendResult;

  if (submit && !appendResult?.submitted) {
    await client.tui.submitPrompt();
  }
  return appendResult;
}

// Transcribe the finished recording and normalize it, without touching the
// prompt. Leaves the sticky "Normalizing..." toast up on success so the caller
// can submit/speak without a silent gap; error/empty paths clear it and reset
// the flags themselves.

async function transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger) {
  processing = true;
  clearRecordingToast();
  logger?.log("STT", "Turn transcription started", "debug");
  stopRecording(logger);
  await waitForSoxExit(logger);

  if (remotePcmFile) {
    try {
      const pcm = fs.readFileSync(remotePcmFile);
      sttLog("STT", `remote PCM wrap: pcmBytes=${pcm.length}`);
      const wav = wrapPcmAsWav(pcm, { sampleRate: audioSampleRateValue });
      fs.writeFileSync(path.join(tmpDir, WAV_FILENAME), wav);
      sttLog("STT", `remote WAV written: wavBytes=${wav.length}`);
    } catch (err) {
      sttLog("STT", `Remote PCM wrap failed: ${err.message}`);
    }
    remotePcmFile = null;
  }

  try {
    showProcessingToast("Transcribing...");
    const tTranscribe = Date.now();
    const result = sttApiEndpoint ? await transcribeApi(kv, logger) : await transcribe(kv, logger);
    const transcribeMs = Date.now() - tTranscribe;

    if (result.error) {
      clearProcessingToast();
      processing = false;
      recording = false;
      logger?.log("STT", `Transcription failed: ${result.error}`, "error");
      toast(result.error, "error");
      return { error: result.error };
    }
    if (!result.text) {
      clearProcessingToast();
      processing = false;
      recording = false;
      logger?.log("STT", "Transcription produced no text", "warn");
      toast("No speech detected", "warning");
      return { text: null, empty: true };
    }

    updateProcessingToast("Normalizing...");
    const tContext = Date.now();
    const sessionID = currentRouteSessionID(api);
    const pref = prefetchedContext;
    prefetchedContext = null;
    const { sessionTitle, recent } =
      pref && Date.now() - pref.at < 60000 && pref.sessionID === sessionID
        ? await pref.promise
        : await fetchContextParts(client, api);
    const contextMs = Date.now() - tContext;
    const withTurns = needsContext(result.text);
    const contextBlock = [
      sessionTitle ? `[session: "${sessionTitle}"]` : null,
      withTurns && recent ? recent : null,
    ]
      .filter(Boolean)
      .join("\n");
    const tNormalize = Date.now();
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      contextBlock,
      systemPrompt,
      logger,
    );
    const normalizeMs = Date.now() - tNormalize;

    if (!llmResult.text) {
      clearProcessingToast();
      processing = false;
      recording = false;
      logger?.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      return { text: result.text, fallback: true };
    }

    logger?.log(
      "STT",
      `Turn timings transcribeMs=${transcribeMs} contextMs=${contextMs} contextTurns=${withTurns ? 1 : 0} normalizeMs=${normalizeMs} rawChars=${result.text.length}`,
      "debug",
    );
    return { text: llmResult.text };
  } catch (err) {
    clearProcessingToast();
    processing = false;
    recording = false;
    logger?.log("STT", `Turn transcription error: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  }
}

async function submitTurnText(client, renderer, toast, text, logger) {
  const myGen = pipelineGeneration;
  try {
    await appendTranscription(client, renderer, text, true, () => myGen === pipelineGeneration);
    clearProcessingToast();
    logger?.log("STT", `Turn submitted chars=${text.length}`, "debug");
    toast("Transcription submitted", "success");
    return { text };
  } catch (err) {
    clearProcessingToast();
    logger?.log("STT", `Turn submit failed: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  } finally {
    processing = false;
    recording = false;
  }
}

async function appendTurnText(client, renderer, toast, text, logger) {
  const myGen = pipelineGeneration;
  try {
    const appendResult = await appendTranscription(
      client,
      renderer,
      text,
      false,
      () => myGen === pipelineGeneration,
    );
    clearProcessingToast();
    logger?.log("STT", `Turn appended chars=${text.length}`, "debug");
    // The v2 adapter retains the transcript when no editable field has
    // focus — it never sends an unrequested prompt. v1 results carry no
    // marker and keep the original toast.
    const retained = appendResult?.retained === true;
    toast(
      retained
        ? "No text field focused - transcription kept (not sent)"
        : "Transcription added to prompt",
      retained ? "warning" : "success",
    );
    return { text };
  } catch (err) {
    clearProcessingToast();
    logger?.log("STT", `Turn append failed: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
    return { error: err.message };
  } finally {
    processing = false;
    recording = false;
  }
}

// Drop a transcribed turn without submitting (e.g. voice stop phrase).
// Clears the sticky toast left up by transcribeTurn and resets the flags.

function discardTurn() {
  pipelineGeneration += 1;
  clearProcessingToast();
  processing = false;
  recording = false;
}

// Cancel an in-progress recording without transcribing.

function cancelRecording(logger) {
  pipelineGeneration += 1;
  recording = false;
  clearRecordingToast();
  forceKillSox(logger);
}

async function doTranscribePipeline(
  kv,
  complete,
  client,
  api,
  toast,
  systemPrompt,
  submit = false,
  logger,
  renderer,
) {
  logger?.log("STT", `Pipeline started submit=${submit}`, "debug");
  const myGen = pipelineGeneration;
  const turn = await transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger);
  // A cancel during transcribe/normalize invalidates this turn: drop the
  // stale text instead of appending it after the user cancelled.
  if (myGen !== pipelineGeneration) {
    clearProcessingToast();
    processing = false;
    recording = false;
    return;
  }
  if (!turn.text) return;
  if (submit) {
    await submitTurnText(client, renderer, toast, turn.text, logger);
  } else {
    await appendTurnText(client, renderer, toast, turn.text, logger);
  }
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, prompts, opts, logger, deps = {}) {
  pluginKv = kv;
  pluginOpts = opts || {};
  if (deps.isConversationActive || deps.onConversationKey) {
    __setConversationHooks({
      isActive: deps.isConversationActive,
      onKey: deps.onConversationKey,
    });
  }
  if (deps.isLiveNotesActive) {
    __setLiveNotesHooks({ isActive: deps.isLiveNotesActive });
  }
  const client = api.client;
  const renderer = opts?.focusMode === "primary" ? null : api.renderer;
  const preview = api.voicePreview;
  // Seed engine from opts if the host delivered it.
  try {
    if (opts?.ttsEngine && kv.get("tts.engine") == null) {
      kv.set("tts.engine", opts.ttsEngine);
    }
  } catch {}
  __setToastPolling(!preview);
  const bootMode = resolveSttMode(opts, kv);
  let modeSource = "default-batch";
  try {
    if (kv?.get("stt.mode") === bootMode) modeSource = "kv";
    else if (opts?.sttMode === bootMode) modeSource = "options";
  } catch {}
  sttLog(
    "register",
    `sttMode=${bootMode} source=${modeSource} preview=${preview ? "yes" : "no"} toastPolling=${!preview} optKeys=${Object.keys(opts || {}).join(",")}`,
  );
  let streamGeneration = 0;
  let streamDisposed = false;
  let finalizingController = null;
  const systemPrompt = selectSttSystemPrompt(sttNormalizeMode, prompts?.stt);
  let captureCmdOpt = opts?.sttCaptureCmd ?? kv.get("sttCaptureCmd") ?? kv.get("stt.captureCmd");
  if (!captureCmdOpt && process.env.STT_CAPTURE_CMD) {
    try {
      captureCmdOpt = JSON.parse(process.env.STT_CAPTURE_CMD);
    } catch {}
  }
  if (Array.isArray(captureCmdOpt) && captureCmdOpt.length) {
    __setSttCaptureCmd(captureCmdOpt);
  }
  let srOpt = opts?.audioSampleRate ?? kv.get("audioSampleRate") ?? kv.get("audio.sampleRate");
  if (!srOpt && process.env.AUDIO_SAMPLE_RATE) srOpt = process.env.AUDIO_SAMPLE_RATE;
  if (Number(srOpt) > 0) {
    __setAudioSampleRate(Number(srOpt));
  }

  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  __setRecordingToastFn((input) => api.ui.toast(input));
  __setProcessingToastFn((input) => api.ui.toast(input));
  __setStreamingToastFn((input) => api.ui.toast(input));
  api.lifecycle?.onDispose?.(() => {
    __clearRecordingToastState();
    __clearProcessingToastState();
    __clearStreamingToastState();
  });

  if (opts?.sttEndpoint) {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    logger?.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger?.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  if (opts?.sttNormalizeMode === "strict") {
    sttNormalizeMode = "strict";
  }
  logger?.log("STT", `Normalize mode=${sttNormalizeMode}`, "debug");

  if (Number(opts?.sttContextMessages) > 0) {
    sttContextMessages = Math.floor(Number(opts.sttContextMessages));
  }
  if (Number(opts?.sttContextChars) > 0) {
    sttContextChars = Math.floor(Number(opts.sttContextChars));
  }
  if (Number(opts?.sttNormalizeTimeoutMs) > 0) {
    sttNormalizeTimeoutMs = Math.floor(Number(opts.sttNormalizeTimeoutMs));
  }
  logger?.log(
    "STT",
    `Normalize context messages=${sttContextMessages} chars=${sttContextChars}`,
    "debug",
  );

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger?.log("STT", `Failed to create tmpDir ${tmpDir}: ${err.message}`, "warn");
  }
  logger?.log("STT", `STT temp dir=${tmpDir}`, "debug");

  const DEFAULT_KEYBINDS = {
    "stt.record": "<leader>[",
  };
  function kb(value) {
    const kb = opts?.keybinds;
    if (!kb || typeof kb !== "object" || Array.isArray(kb)) return DEFAULT_KEYBINDS[value];
    if (!Object.prototype.hasOwnProperty.call(kb, value)) return DEFAULT_KEYBINDS[value];
    const v = kb[value];
    if (!v || v === "none") return undefined;
    return v;
  }
  __setRecordKeybind(kb("stt.record") || "<leader>[");

  // Start a recording for the voice-conversation loop. Returns false when busy.

  // Conversation-mode silence auto-finalize: when set, the recording uses
  // sox silence detection to auto-stop after this many seconds of silence,
  // and the onStopped callback fires. Default null = manual stop only.
  let conversationSilenceStopSec = null;
  let conversationOnStopped = null;

  function startLoopRecording() {
    if (recording || processing || streamingDictationActive) return false;
    startRecording(
      kv,
      backend,
      toast,
      logger,
      opts?.trimSilence,
      conversationSilenceStopSec,
      conversationOnStopped,
    );
    if (recording) {
      showRecordingToast();
      // Fetch title + recent turns while the user speaks, so the context is
      // usually ready before the turn ends instead of on the critical path.
      prefetchContextParts(client, api);
    }
    return recording;
  }

  // ---- Streaming dictation session (stage 2, local-only, no LLM) ----
  // Mode/auto-submit resolve live from kv first: options seed kv on first
  // boot, then the /stt-mode and /stt-autosubmit commands own the runtime
  // value. This survives hosts that deliver partial plugin options.
  const seedKvFromOpts = () => {
    try {
      if (
        (opts?.sttMode === "streaming" || opts?.sttMode === "batch") &&
        kv.get("stt.mode") == null
      ) {
        kv.set("stt.mode", opts.sttMode);
      }
    } catch {}
    try {
      if (opts?.sttAutoSubmit !== undefined && kv.get("stt.autoSubmit") == null) {
        kv.set("stt.autoSubmit", opts.sttAutoSubmit === true);
      }
    } catch {}
  };
  seedKvFromOpts();
  const currentSttMode = () => resolveSttMode(opts, kv);
  const sttAutoSubmitEnabled = () => resolveSttAutoSubmit(opts, kv);
  // Boot-time snapshot for the mode log line below; behavior branches call
  // currentSttMode() live so /stt-mode takes effect without a restart.
  const sttMode = currentSttMode();
  const streamTimings = resolveStreamTimings(opts);
  logger?.log(
    "STT",
    `Mode=${sttMode} streamWindowMs=${streamTimings.windowMs} streamStepMs=${streamTimings.cadenceMs}`,
    "debug",
  );
  let streamController = null;
  let streamEditor = null;
  let streamTarget = null;
  let streamStarting = false;
  // Auto-end-of-speech: when enabled, a timer checks if no new partial has
  // arrived for AUTO_END_SILENCE_MS and triggers finalize automatically.
  let streamAutoEndTimer = null;
  const AUTO_END_SILENCE_MS = 3000;

  function enableStreamAutoEnd() {
    disableStreamAutoEnd();
    streamAutoEndTimer = setInterval(() => {
      if (!streamingDictationActive || !streamController) {
        disableStreamAutoEnd();
        return;
      }
      const route = streamAutoEndRoute({
        conversation: conversationActive(),
        conversationStopSec: conversationStreamingStopSec,
        conversationOnStopped: conversationStreamingOnStopped,
        previewAutoEnd: preview?.getAutoEndOfSpeech?.() === true,
      });
      if (route === "off") return;
      const useConv = route === "conversation";
      const convSec = conversationStreamingStopSec;
      let audioSilent = false;
      let rms = 0;
      try {
        const pcm = streamController.peekPcm?.(STREAM_WAVE_BYTES);
        if (pcm && pcm.length >= 2) {
          let sum = 0;
          const samples = Math.floor(pcm.length / 2);
          for (let i = 0; i + 1 < pcm.length; i += 2) {
            const s = pcm.readInt16LE(i) / 32768;
            sum += s * s;
          }
          rms = Math.sqrt(sum / samples);
          if (rms < 0.01) audioSilent = true;
        }
      } catch {}
      if (audioSilent) {
        if (lastAudioActiveMs === null) lastAudioActiveMs = Date.now();
      } else {
        lastAudioActiveMs = null;
      }
      const audioSilentMs = lastAudioActiveMs ? Date.now() - lastAudioActiveMs : 0;
      const last = streamingLastPartialMs;
      const elapsed = last ? Date.now() - last : 0;
      const threshold = useConv && convSec > 0 ? convSec * 1000 : AUTO_END_SILENCE_MS;
      if (useConv) {
        if (audioSilent && audioSilentMs > threshold) {
          sttLog(
            "stream.autoEnd",
            `conversation triggered rms=${rms.toFixed(4)} silentMs=${audioSilentMs}ms`,
          );
          disableStreamAutoEnd();
          try {
            conversationStreamingOnStopped?.();
          } catch {}
          return;
        }
        if (last && elapsed > threshold * 2) {
          sttLog(
            "stream.autoEnd",
            `conversation triggered (partial) rms=${rms.toFixed(4)} elapsed=${elapsed}ms`,
          );
          disableStreamAutoEnd();
          try {
            conversationStreamingOnStopped?.();
          } catch {}
        }
        return;
      }
      if (audioSilent && audioSilentMs > threshold) {
        sttLog(
          "stream.autoEnd",
          `triggered by silence (audio) rms=${rms.toFixed(4)} silentMs=${audioSilentMs}ms`,
        );
        disableStreamAutoEnd();
        void finalizeStreamingDictation({ submit: preview?.getAutoSubmit?.() ?? false });
        return;
      }
      if (last && elapsed > threshold * 2) {
        sttLog(
          "stream.autoEnd",
          `triggered by silence (partial only) rms=${rms.toFixed(4)} elapsed=${elapsed}ms`,
        );
        disableStreamAutoEnd();
        void finalizeStreamingDictation({ submit: preview?.getAutoSubmit?.() ?? false });
      }
    }, 500);
    if (typeof streamAutoEndTimer.unref === "function") streamAutoEndTimer.unref();
  }

  function disableStreamAutoEnd() {
    if (streamAutoEndTimer) {
      clearInterval(streamAutoEndTimer);
      streamAutoEndTimer = null;
    }
  }
  // Warm server lease retained across dictations: the idle controller (mic
  // fully stopped, server still loaded) parks here between sessions. At most
  // one warm lease ever exists; the next start reuses it when the model key
  // matches, or tears it down first when the model/language changed.
  let warmStreamController = null;
  let warmStreamModelKey = null;

  function warmControllerPort(controller) {
    try {
      return controller?.getServerPort?.() ?? undefined;
    } catch {
      return undefined;
    }
  }

  function currentStreamModelKey(port) {
    return streamModelKey(getModelPath(kv), getLanguage(kv), port);
  }

  function disposeWarmStreamController() {
    if (warmStreamController) {
      const c = warmStreamController;
      warmStreamController = null;
      warmStreamModelKey = null;
      try {
        const maybe = c.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
    }
  }

  function retainWarmStreamController(controller) {
    // Single-lease invariant: never park a second handle alongside one.
    if (warmStreamController && warmStreamController !== controller) {
      try {
        const maybe = controller.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
      return;
    }
    warmStreamController = controller;
    warmStreamModelKey = currentStreamModelKey(warmControllerPort(controller));
  }

  function isStreaming() {
    return streamingDictationActive || (preview && (streamStarting || !!finalizingController));
  }

  async function startStreamingDictation() {
    if (streamingDictationActive || streamStarting || finalizingController || streamDisposed)
      return false;
    if (recording || processing) {
      toast("STT busy, please wait...");
      return false;
    }
    if (liveNotesActive()) {
      toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
      return false;
    }
    if (conversationActive() && !conversationStreamingEnabled) {
      toast("Conversation mode is on - use the conversation key to exit", "warning");
      return false;
    }
    const myGen = ++streamGeneration;
    // Model/language change tears down the warm lease first so the next
    // start loads the new model instead of reusing the stale server. The
    // key carries the bound server port, so a lease on a different port is
    // never mistaken for a matching one.
    if (
      warmStreamController &&
      warmStreamModelKey !== currentStreamModelKey(warmControllerPort(warmStreamController))
    ) {
      disposeWarmStreamController();
    }
    let controller = null;
    let reusedWarm = false;
    try {
      const { createStreamingController } = await import("./streaming-stt.js");
      const { createStreamingEditorAdapter } = await import("./streaming-editor.js");
      const focused = renderer?.currentFocusedRenderable || null;
      const target = focused && typeof focused.insertText === "function" ? focused : null;
      const editor =
        preview ||
        createStreamingEditorAdapter({
          toast: (message, variant) => api.ui.toast({ message, variant, duration: 2500 }),
          getFocused: () => renderer?.currentFocusedRenderable || null,
        });
      if (preview) await preview.begin();
      else editor.begin(target);
      sttLog("stream.begin", `preview=${preview ? "yes" : "no"}`);
      // Clickable pause lives on the preview line (v2 slot). The toggle
      // action funnels through the same pause/resume path as the command.
      try {
        preview?.setToggleAction?.(() => toggleStreamingPause());
      } catch {}
      // Restore persisted toggle states from kv so they survive restarts.
      try {
        const savedAutoSubmit = kv.get("stt.autoSubmit");
        if (savedAutoSubmit === true || savedAutoSubmit === false) {
          preview?.setAutoSubmit?.(savedAutoSubmit);
        }
      } catch {}
      try {
        const savedAutoEnd = kv.get("stt.autoEndOfSpeech");
        if (savedAutoEnd === true || savedAutoEnd === false) {
          preview?.setAutoEndOfSpeech?.(savedAutoEnd);
        }
      } catch {}
      try {
        preview?.setAutoSubmitToggleAction?.(() => {
          const next = !preview.getAutoSubmit?.();
          preview.setAutoSubmit?.(next);
          // Persist in kv so it survives restarts.
          try {
            kv.set("stt.autoSubmit", next);
          } catch {}
          sttLog("stream.autoSubmit", `toggled to ${next}`);
        });
      } catch {}
      try {
        preview?.setAutoEndToggleAction?.(() => {
          const next = !preview.getAutoEndOfSpeech?.();
          preview.setAutoEndOfSpeech?.(next);
          // Persist so it survives restarts.
          try {
            kv.set("stt.autoEndOfSpeech", next);
          } catch {}
          sttLog("stream.autoEnd", `toggled to ${next}`);
          // If recording is active, enable/disable silence auto-finalize.
          if (streamingDictationActive && streamController) {
            if (next) {
              enableStreamAutoEnd();
            } else {
              disableStreamAutoEnd();
            }
          }
        });
      } catch {}
      if (streamDisposed || myGen !== streamGeneration) {
        preview?.clear();
        return false;
      }
      const sessionCallbacks = (ed) => ({
        onPartial: (p) => {
          if (streamDisposed || myGen !== streamGeneration) return;
          try {
            noteStreamingPartial(p);
          } catch {}
          try {
            ed.applyPartial(p);
          } catch {}
          sttLog(
            "stream.partial",
            `stable=${(p?.stableText || "").length} tentative=${(p?.tentativeText || "").length}`,
          );
        },
        onStateChange: (s) => {
          sttLog("stream.state", s);
          try {
            if (s === "streaming") {
              updateStreamingToast("● Streaming dictation — listening");
            }
          } catch {}
        },
        onError: (e) => {
          logger?.log("STT", `Streaming error: ${e?.code || ""} ${e?.message || ""}`, "error");
          try {
            clearStreamingToast();
          } catch {}
          toast(
            `Streaming STT error: ${e?.message || "unknown"}${e?.hasFallbackAudio ? " (audio kept)" : ""}`,
            "error",
          );
        },
      });
      if (warmStreamController) {
        controller = warmStreamController;
        warmStreamController = null;
        warmStreamModelKey = null;
        reusedWarm = true;
        // Rebind to the new session's editor: the warm lease stays, but
        // partials/errors must never reach the previous session's editor.
        try {
          controller.updateCallbacks?.(sessionCallbacks(editor));
        } catch {}
      } else {
        controller = createStreamingController({
          windowMs: streamTimings.windowMs,
          cadenceMs: streamTimings.cadenceMs,
          model: { modelPath: getModelPath(kv), language: getLanguage(kv) },
          logger,
          sampleRate: getAudioSampleRate(),
          captureCmd: getSttCaptureCmd(),
          ...sessionCallbacks(editor),
          // Test seam (stage 3 e2e): deterministic capture/transcriber/clock
          // without a mic. Absent in production; the default path is
          // unchanged when deps.streamingControllerOpts is unset.
          ...deps.streamingControllerOpts,
        });
      }
      streamEditor = editor;
      streamTarget = target;
      streamController = controller;
      if (!controller.start()) {
        streamEditor = null;
        streamTarget = null;
        streamController = null;
        // start() refused (already running): park the warm handle back so
        // the lease is never dropped on a refusal path.
        if (reusedWarm) retainWarmStreamController(controller);
        return false;
      }
      __setStreamingActive(true);
      sttLog("stream.started", `reusedWarm=${reusedWarm}`);
      // Live waveform rides the v2 preview slot next to the live transcript.
      // v1 has no persistent preview surface; its batch wave is unchanged.
      if (preview) {
        __resetStreamWave();
        let pcmLogCount = 0;
        preview.startWave?.(() => {
          const pcm = controller.peekPcm?.(STREAM_WAVE_BYTES);
          if (pcmLogCount < 3 && pcm) {
            pcmLogCount += 1;
            sttLog("stream.pcm", `bytes=${pcm.length}`);
          }
          return pcm ? waveLevelsFromPcm(pcm) : null;
        });
        // Auto-end: always run the timer; it checks the preview's toggle
        // state internally so toggling mid-recording works without restart.
        enableStreamAutoEnd();
      }
      // Sticky, never silent: covers the cold model load ("Loading…") until
      // the controller reports streaming, then live capture with elapsed
      // time. Partial preview toasts continue alongside via the editor.
      showStreamingToast("Loading speech model…", {
        slowAfterMs: Math.max(2000, streamTimings.cadenceMs * 2),
      });
      logger?.log("STT", "Streaming dictation started", "debug");
      return true;
    } catch (err) {
      preview?.clear();
      sttLog("stream.start-failed", err?.message || String(err));
      logger?.log("STT", `Streaming start failed: ${err?.message || err}`, "error");
      try {
        clearStreamingToast();
      } catch {}
      toast(`Streaming STT failed to start: ${err?.message || err}`, "error");
      streamEditor = null;
      streamTarget = null;
      streamController = null;
      if (reusedWarm && controller) {
        // Setup failed after taking the warm handle: park it back so the
        // lease survives a transient editor/import failure.
        retainWarmStreamController(controller);
      } else if (controller) {
        // Fresh handle that never became a session: release any partial
        // lease so a failed start never leaks a server ref.
        try {
          const maybe = controller.dispose?.();
          if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
        } catch {}
      }
      return false;
    } finally {
      streamStarting = false;
    }
  }

  // Pause/resume for live dictation: freezes the mic (SIGSTOP) and skips
  // recognition ticks so paused spans cost nothing and never enter the
  // transcript. The record key resumes a paused session instead of
  // finalizing it; explicit stop stays on /stt-stop.
  function toggleStreamingPause() {
    if (!streamingDictationActive || !streamController) return false;
    let pausedNow = false;
    try {
      pausedNow = !!streamController.getState?.().paused;
    } catch {
      return false;
    }
    if (pausedNow) {
      let ok = false;
      try {
        ok = streamController.resume() === true;
      } catch {
        ok = false;
      }
      if (ok) {
        preview?.setPaused?.(false);
        updateStreamingToast("● Streaming dictation — listening");
        sttLog("stream.resume", "ok");
      }
      return ok;
    }
    let ok = false;
    try {
      ok = streamController.pause?.() === true;
    } catch {
      ok = false;
    }
    if (ok) {
      preview?.setPaused?.(true);
      updateStreamingToast("⏸ Dictation paused — press record or click ▶ to resume");
      sttLog("stream.pause", "ok");
    }
    return ok;
  }

  // Pause/resume entry point shared by the /stt-pause command. Returns false
  // with a hint toast when there is nothing pausable.
  async function pauseStreamingDictation() {
    if (!streamingDictationActive || !streamController) {
      toast("No streaming dictation in progress", "warning");
      return false;
    }
    if (!toggleStreamingPause()) {
      toast("Pause unavailable right now - use /stt-stop to cancel", "warning");
      return false;
    }
    return true;
  }

  // Finalize: stop the controller (single tail transcription, no LLM),
  // commit the editor range, then insert EXACTLY once via the focused-input
  // helper. Never falls through to primary-chat appendPrompt. When `submit`
  // is set, submits ONLY via the captured target's own submit().
  // Warm-lease semantics: the mic is fully stopped by stop(), but the
  // server lease is RETAINED across dictations (parked as the single warm
  // handle) and released only when the stop result proves the server itself
  // is at fault, on model/language change, or on plugin unload.
  async function finalizeStreamingDictation({ submit = false, insert = true } = {}) {
    if (!streamingDictationActive || !streamController) return null;
    sttLog("stream.finalize", `submit=${submit} insert=${insert}`);
    disableStreamAutoEnd();
    const controller = streamController;
    const editor = streamEditor;
    const target = streamTarget;
    const myGen = streamGeneration;
    finalizingController = controller;
    if (preview) processing = true;
    streamController = null;
    streamEditor = null;
    streamTarget = null;
    __setStreamingActive(false);
    // Never silent between the second keypress and the insert: the stop-tail
    // transcription can take ~a second while the screen otherwise freezes.
    try {
      updateStreamingToast("Finalizing…");
    } catch {}
    let done = null;
    try {
      done = await controller.stop();
    } catch (err) {
      finalizingController = null;
      if (preview) processing = false;
      logger?.log("STT", `Streaming stop failed: ${err?.message || err}`, "error");
      try {
        clearStreamingToast();
      } catch {}
      toast(`Streaming stop failed: ${err?.message || err}`, "error");
      // Mid-stop throw: preserve the lease (transient/per-dictation until
      // proven otherwise); the next start re-probes server readiness.
      retainWarmStreamController(controller);
      return null;
    }
    finalizingController = null;
    if (streamDisposed || myGen !== streamGeneration) {
      preview?.clear();
      if (preview) processing = false;
      await controller.dispose?.();
      return null;
    }
    // The stop-tail resolved: the sticky status served its purpose (no
    // silent gap during the wait). Clear before the terminal toasts below.
    try {
      clearStreamingToast();
    } catch {}
    if (done?.error && isStreamingServerFault(done.error)) {
      if (preview) processing = false;
      // Server at fault (not ready / transcribe failure): release the lease
      // so the next start cold-loads from a clean handle instead of reusing
      // a dead server.
      toast(`Streaming stopped with error: ${done.error?.message || done.error}`, "warning");
      try {
        editor?.finalize((done?.text || editor?.getTranscript?.() || "").trim());
      } catch {}
      try {
        await controller.dispose?.();
      } catch {}
      return { text: (done?.text || "").trim(), error: done.error };
    }
    const text = (done?.text || editor?.getTranscript?.() || "").trim();
    if (done?.error) {
      toast(`Streaming stopped with error: ${done.error?.message || done.error}`, "warning");
    }
    // editor.finalize already writes the owned range for live-capable
    // targets (inserted:true) — inserting again would duplicate. Only the
    // fallback path (no range API) needs the single insert below, routed
    // through the captured target, never the current focus.
    let fin = null;
    try {
      fin = editor?.finalize(text);
    } catch {}
    // Every path below retains the warm lease: the mic stopped, the server
    // stays loaded for the next dictation.
    if (!text) {
      if (preview) processing = false;
      toast("No speech detected", "warning");
      retainWarmStreamController(controller);
      return { text: "" };
    }
    if (fin?.inserted) {
      logger?.log("STT", `Streaming finalized via owned range chars=${text.length}`, "debug");
      if (submit === true || (submit !== false && autoSubmitNow())) {
        if (target && typeof target.submit === "function") {
          try {
            target.submit();
            toast("Streaming transcription submitted", "success");
          } catch (err) {
            toast(`Streaming submit failed: ${err?.message || err}`, "error");
          }
        } else {
          toast("Target cannot submit - text inserted, not submitted", "warning");
        }
      } else {
        toast("Streaming transcription added", "success");
      }
      if (preview) processing = false;
      retainWarmStreamController(controller);
      return { text, inserted: true };
    }
    // Fallback session: single insert into the captured target only. A
    // missing/unusable target retains the transcript via toast instead of
    // redirecting into chat or the current focus.
    let inserted = false;
    if (insert) {
      if (target && typeof target.insertText === "function") {
        try {
          target.insertText(text);
          inserted = true;
        } catch {
          inserted = false;
        }
      } else {
        inserted = insertIntoFocusedInput(renderer, text, false);
      }
    }
    if (insert && !inserted) {
      logger?.log("STT", "Streaming finalize: no editable field, transcript retained", "warn");
      toast("No editable field - dictated text kept (not inserted elsewhere)", "warning");
      if (preview) processing = false;
      retainWarmStreamController(controller);
      return { text, inserted: false };
    }
    if (insert) {
      logger?.log("STT", `Streaming finalized chars=${text.length}`, "debug");
      if (submit === true || (submit !== false && autoSubmitNow())) {
        if (target && typeof target.submit === "function") {
          try {
            target.submit();
            toast("Streaming transcription submitted", "success");
          } catch (err) {
            toast(`Streaming submit failed: ${err?.message || err}`, "error");
          }
        } else {
          toast("Target cannot submit - text inserted, not submitted", "warning");
        }
      } else {
        toast("Streaming transcription added", "success");
      }
    }
    if (preview) processing = false;
    retainWarmStreamController(controller);
    return { text, inserted };
  }

  // Cancel: drop the session and remove ONLY plugin-owned dictated text.
  // Fallback path inserted nothing, so there is nothing to remove. The mic
  // is fully stopped by cancel(); the server lease is retained warm for the
  // next dictation (user cancel is per-dictation, never a server fault).
  async function cancelStreamingDictation() {
    streamGeneration += 1;
    sttLog("stream.cancel");
    disableStreamAutoEnd();
    preview?.clear();
    if (preview && processing) cancelRecording(logger);
    if (finalizingController) {
      const finishing = finalizingController;
      finalizingController = null;
      cancelRecording(logger);
      await finishing.cancel();
      processing = false;
      clearStreamingToast();
      return true;
    }
    if (!streamingDictationActive || !streamController) return false;
    const controller = streamController;
    const editor = streamEditor;
    streamController = null;
    streamEditor = null;
    streamTarget = null;
    __setStreamingActive(false);
    try {
      await controller.cancel();
    } catch {}
    let removed = 0;
    try {
      removed = editor?.cancel?.()?.removedChars || 0;
    } catch {}
    retainWarmStreamController(controller);
    logger?.log("STT", `Streaming cancelled removedChars=${removed}`, "debug");
    try {
      clearStreamingToast();
    } catch {}
    toast("Streaming dictation cancelled");
    return true;
  }

  api.lifecycle?.onDispose?.(() => {
    streamDisposed = true;
    streamGeneration += 1;
    preview?.clear();
    if (finalizingController) {
      const finishing = finalizingController;
      finalizingController = null;
      void finishing.dispose?.();
    }
    // Unload mid-recording must not orphan the sox child: cancel kills it,
    // bumps the pipeline generation (late transcriptions are dropped), and
    // clears the sticky toast. processing is not owned by cancel, reset it
    // here so a later registration starts from idle.
    try {
      cancelRecording(logger);
    } catch {}
    processing = false;
    if (streamController) {
      const c = streamController;
      streamController = null;
      streamEditor = null;
      streamTarget = null;
      __setStreamingActive(false);
      try {
        const maybe = c.dispose?.();
        if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
      } catch {}
    }
    try {
      clearStreamingToast();
    } catch {}
    // Plugin unload releases the parked warm lease: the model must not stay
    // loaded after the plugin is gone.
    disposeWarmStreamController();
  });

  const controller = {
    isRecording: () => recording,
    isProcessing: () => processing,
    isStreaming,
    log: (msg) => sttLog("CONV", msg),
    start: startLoopRecording,
    setSilenceAutoFinalize: (sec, onStopped) => {
      conversationSilenceStopSec = sec && sec > 0 ? sec : null;
      conversationOnStopped = typeof onStopped === "function" ? onStopped : null;
    },
    setConversationStreamingFinalize: (sec, onStopped) => {
      conversationStreamingStopSec = sec && sec > 0 ? sec : null;
      conversationStreamingOnStopped = typeof onStopped === "function" ? onStopped : null;
      if (conversationStreamingStopSec) enableStreamAutoEnd();
      else disableStreamAutoEnd();
    },
    setConversationStreamingEnabled: (v) => {
      conversationStreamingEnabled = !!v;
    },
    finalizeStreaming: (opts) => finalizeStreamingDictation(opts || {}),
    setStopHint: (hint) => __setStopHint(hint),
    cancel: () => cancelRecording(logger),
    discard: () => discardTurn(),
    transcribeTurn: () => transcribeTurn(kv, complete, client, api, toast, systemPrompt, logger),
    // Conversation turns are hands-free submissions, not dictation: on v2
    // they must not press Enter in whatever field happens to have focus (a
    // permission dialog could own it), so they always go through the
    // session.prompt submit path. v1 keeps its focused-insert + submit.
    submitTurnText: (text) =>
      submitTurnText(client, client.tui?.v2 ? null : renderer, toast, text, logger),
    startStreaming: startStreamingDictation,
    finalizeStreaming: finalizeStreamingDictation,
    cancelStreaming: cancelStreamingDictation,
  };

  // One-shot auto-submit: speak, press again, and the text submits itself
  // without landing in the box first. Off by default (append-then-edit).
  // Live reader: /stt-autosubmit flips the kv value mid-session.
  const autoSubmit = sttAutoSubmitEnabled();
  const autoSubmitNow = () => sttAutoSubmitEnabled();

  const commands = [
    {
      title: sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      value: "stt.record",
      category: "opencode-voice",
      description:
        sttApiEndpoint && autoSubmit
          ? "Toggle recording; press again to stop, transcribe via API and submit"
          : sttApiEndpoint
            ? "Toggle recording; press again to stop and transcribe via API"
            : autoSubmit
              ? "Toggle recording; press again to stop, transcribe and submit"
              : "Toggle recording; press again to stop and transcribe",
      ...(kb("stt.record") ? { keybind: kb("stt.record") } : {}),
      slash: { name: "stt-record" },
      onSelect() {
        // Streaming mode: toggle streaming record/finalize, or resume a
        // paused session (cheaper than re-speaking; explicit stop stays on
        // /stt-stop). Batch default below is behavior-identical to before.
        sttLog("toggle", `sttMode=${currentSttMode()} streamingActive=${streamingDictationActive}`);
        // Conversation owns the live turn. Finalizing or cancelling the
        // stream here would bypass finishTurnFlow: no submit, no reply wait,
        // no speech, and the mode stays stuck on "Listening". The STT key
        // therefore means the same thing as the conversation key.
        if (conversationActive()) {
          conversationHooks.onKey?.("record");
          return;
        }
        if (currentSttMode() === "streaming") {
          if (streamingDictationActive) {
            try {
              if (streamController?.getState?.().paused) {
                toggleStreamingPause();
                return;
              }
            } catch {}
            void finalizeStreamingDictation({ submit: false });
            return;
          }
          if (liveNotesActive()) {
            toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
            return;
          }
          if (processing || recording) {
            toast("STT busy, please wait...");
            return;
          }
          void startStreamingDictation();
          return;
        }
        if (streamingDictationActive) {
          toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (liveNotesActive()) {
          toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          clearRecordingToast();
          toast("Stopping, transcribing...");
          doTranscribePipeline(
            kv,
            complete,
            client,
            api,
            toast,
            systemPrompt,
            autoSubmit,
            logger,
            renderer,
          );
        } else {
          startLoopRecording();
        }
      },
    },
    {
      title: sttApiEndpoint ? "STT: submit recording (API)" : "STT: submit recording",
      value: "stt.submit",
      category: "opencode-voice",
      description: sttApiEndpoint
        ? "Stop recording, transcribe via API, and submit prompt"
        : "Stop recording, transcribe, and submit prompt",
      ...(kb("stt.submit") ? { keybind: kb("stt.submit") } : {}),
      slash: { name: "stt-submit" },
      onSelect() {
        // Streaming mode: finalize then submit ONLY via the captured
        // target's own submit(). Never falls through to primary-chat submit.
        // Conversation owns the turn (see stt.record).
        if (conversationActive()) {
          conversationHooks.onKey?.("submit");
          return;
        }
        if (currentSttMode() === "streaming") {
          if (!streamingDictationActive) {
            toast("No streaming dictation in progress", "warning");
            return;
          }
          void finalizeStreamingDictation({ submit: true });
          return;
        }
        if (streamingDictationActive) {
          toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (liveNotesActive()) {
          toast("Live notes recording - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!recording) {
          toast("No recording in progress", "warning");
          return;
        }
        clearRecordingToast();
        toast("Stopping, transcribing...");
        doTranscribePipeline(
          kv,
          complete,
          client,
          api,
          toast,
          systemPrompt,
          true,
          logger,
          renderer,
        );
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      category: "opencode-voice",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      onSelect() {
        // Conversation owns the turn: cancel the recording through the loop so
        // the mode returns to paused instead of sitting on "Listening" with a
        // dead stream.
        if (conversationActive()) {
          conversationHooks.onKey?.("cancel");
          return;
        }
        // Streaming mode: cancel and remove ONLY plugin-owned dictation
        // text, never user-typed text.
        if (currentSttMode() === "streaming" || streamingDictationActive) {
          if (streamingDictationActive) {
            void cancelStreamingDictation();
            return;
          }
          if (liveNotesActive()) {
            toast("Live notes recording - use /voice-notes-stop", "warning");
            return;
          }
          return;
        }
        if (liveNotesActive()) {
          toast("Live notes recording - use /voice-notes-stop", "warning");
          return;
        }
        if (recording) {
          cancelRecording(logger);
          logger?.log("STT", "Recording cancelled", "debug");
          toast("Recording cancelled");
        }
      },
    },
    {
      title: "STT: pause / resume streaming dictation",
      value: "stt.pause",
      category: "opencode-voice",
      description: "Freeze the mic mid-dictation (skips noise); run again to resume",
      slash: { name: "stt-pause" },
      onSelect() {
        // Conversation records through its own loop: there is no dictation
        // session to freeze, and pausing the mic would strand the live turn.
        if (conversationActive()) {
          toast(
            "Conversation is recording - use the conversation key to send or /stt-stop to cancel",
          );
          return;
        }
        // Batch mode has no pausable session (one-shot record); the mic
        // toggle is start/stop there.
        if (currentSttMode() !== "streaming" && !streamingDictationActive) {
          toast("Pause needs streaming mode - use /stt-mode to switch", "warning");
          return;
        }
        void pauseStreamingDictation();
      },
    },
    {
      title: "STT: select dictation mode",
      value: "stt.mode",
      category: "opencode-voice",
      description: "Choose one-shot batch or live streaming dictation (saved, survives restarts)",
      slash: { name: "stt-mode" },
      onSelect() {
        const current = currentSttMode();
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select dictation mode",
            current,
            options: [
              {
                title: "Streaming (live transcript + wave, local whisper, no LLM)",
                value: "streaming",
                onSelect() {
                  kv.set("stt.mode", "streaming");
                  sttLog("mode.set", "streaming via /stt-mode");
                  toast("Dictation mode: streaming");
                  api.ui.dialog.clear();
                },
              },
              {
                title: "Batch (record, then transcribe)",
                value: "batch",
                onSelect() {
                  kv.set("stt.mode", "batch");
                  sttLog("mode.set", "batch via /stt-mode");
                  toast("Dictation mode: batch");
                  api.ui.dialog.clear();
                },
              },
            ],
          }),
        );
      },
    },
    {
      title: "STT: toggle auto-submit",
      value: "stt.autosubmit",
      category: "opencode-voice",
      description: "Toggle submitting the transcript automatically after dictation (saved)",
      slash: { name: "stt-autosubmit" },
      onSelect() {
        const next = !sttAutoSubmitEnabled();
        kv.set("stt.autoSubmit", next);
        sttLog("mode.set", `autoSubmit=${next} via /stt-autosubmit`);
        toast(`STT auto-submit: ${next ? "on" : "off"}`);
      },
    },
    {
      title: sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      value: "stt.model",
      category: "opencode-voice",
      description: sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        if (sttApiEndpoint) {
          const current = kv.get("stt.api.model") || sttApiModel;
          const apiModels = await getApiModels(logger);
          const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model (API)",
              current,
              options: options.map((m) => ({
                title: m.label,
                value: m.value,
                onSelect() {
                  kv.set("stt.api.model", m.value);
                  toast(`Whisper API model: ${m.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        } else {
          const current = getModelName(kv);
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model",
              current,
              options: Object.entries(MODELS).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  kv.set("stt.model", key);
                  // Model change tears down the parked warm server lease so
                  // the next dictation loads the new model (refused
                  // mid-dictation by the start guards; idle teardown here).
                  if (!streamingDictationActive) disposeWarmStreamController();
                  toast(`Whisper model: ${v.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
    {
      title: "STT: select language",
      value: "stt.language",
      category: "opencode-voice",
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      onSelect() {
        const current = getLanguage(kv);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select transcription language",
            current,
            options: Object.entries(LANGUAGES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                kv.set("stt.language", key);
                // Language is part of the server key: drop the parked warm
                // lease so the next dictation starts the new configuration.
                if (!streamingDictationActive) disposeWarmStreamController();
                toast(`Whisper language: ${v.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      category: "opencode-voice",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const remoteCmd = getSttCaptureCmd() || buildRemoteCaptureCmd(getRemoteConfig());
        const remoteConfigured = !!remoteCmd;
        const current = kv.get("stt.mic", "");
        const options = [];
        if (remoteConfigured) {
          options.push({
            title: "Phone (remote)",
            value: "remote",
            onSelect() {
              kv.set("stt.mic", "remote");
              toast("Mic: phone (remote)");
              api.ui.dialog.clear();
            },
          });
        }
        options.push({
          title: "System default",
          value: "",
          onSelect() {
            kv.set("stt.mic", "");
            toast("Mic: system default");
            api.ui.dialog.clear();
          },
        });
        const devices = backend === "remote" ? [] : listInputDevices(backend);
        for (const d of devices) {
          options.push({
            title: d.label,
            value: d.name,
            onSelect() {
              kv.set("stt.mic", d.name);
              toast(`Mic: ${d.label}`);
              api.ui.dialog.clear();
            },
          });
        }
        if (options.length <= 2 && !remoteConfigured) {
          toast("No local mic found. Run /stt-remote-setup to use a phone mic.", "warning");
          return;
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select microphone",
            current: remoteConfigured && current === "remote" ? "remote" : current,
            options,
          }),
        );
      },
    },
    {
      title: "STT: set up remote (phone) mic",
      value: "stt.remote-setup",
      category: "opencode-voice",
      description: "Configure phone host/port/key for remote capture",
      slash: { name: "stt-remote-setup" },
      onSelect() {
        toast("Remote setup starting...");
        const state = getRemoteConfig();
        const cmd = [
          "ssh",
          "-i",
          state.key,
          "-p",
          String(state.port),
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          state.host,
          "echo OK",
        ];
        let ok = false;
        try {
          const out = execSync(cmd[0] + " " + cmd.slice(1).join(" "), {
            encoding: "utf-8",
            timeout: 10000,
          });
          ok = String(out).trim() === "OK";
        } catch (err) {
          ok = false;
          toast(`SSH test failed: ${err?.message || err}`, "error");
        }
        kv.set("stt.remoteHost", state.host);
        kv.set("stt.remotePort", state.port);
        kv.set("stt.remoteKey", state.key);
        kv.set("audio.sampleRate", state.rate);
        if (ok) {
          kv.set("stt.mic", "remote");
          if (kv.get("tts.output") == null) kv.set("tts.output", "remote");
          toast("Phone mic configured and selected");
        } else {
          toast("Saved config (SSH test failed)", "warning");
        }
      },
    },
  ];

  return { commands, controller };
}
