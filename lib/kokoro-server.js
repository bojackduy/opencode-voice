// Managed Kokoro TTS sidecar (see vendor/kokoro_server.py).
//
// Kokoro is a local English TTS with natural prosody. Like VieNeu it ships as
// a Python sidecar serving WAV bytes over plain HTTP; the plugin spawns it
// once and keeps it loaded for the session.
//
// Install: pip install kokoro soundfile. First run downloads ~350 MB weights.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sttLog } from "./stt-log.js";

// Sidecar error bodies are not always strings: OpenAI-compatible APIs
// return { error: { message, type, code } }, which would render as
// "[object Object]" in toasts. Always reduce to a readable string.
function errText(value, fallback) {
  if (typeof value === "string" && value) return value;
  if (value != null) {
    try {
      const s = JSON.stringify(value);
      if (s) return s.slice(0, 300);
    } catch {}
  }
  return fallback;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8130;
const DEFAULT_PORT_SCAN_MAX = 4;
const READY_TIMEOUT_MS = 300000;
const READY_POLL_MS = 1000;
const SYNTHESIZE_TIMEOUT_MS = 120000;

const SIDECAR_PATH = fileURLToPath(new URL("../vendor/kokoro_server.py", import.meta.url));

export function buildKokoroArgs({ scriptPath, host, port, voice }) {
  return [
    scriptPath || SIDECAR_PATH,
    "--host",
    host || DEFAULT_HOST,
    "--port",
    String(port || DEFAULT_PORT),
    "--voice",
    voice || "af_heart",
  ];
}

export function createKokoroClient(options = {}) {
  const {
    host = DEFAULT_HOST,
    python,
    voice = "af_heart",
    logger,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyPollMs = READY_POLL_MS,
    synthesizeTimeoutMs = SYNTHESIZE_TIMEOUT_MS,
    portScanMax = DEFAULT_PORT_SCAN_MAX,
    deps = {},
  } = options;

  const scriptPath = options.scriptPath || SIDECAR_PATH;
  const spawnFn = deps.spawn ?? spawn;
  const fetchFn = deps.fetch ?? fetch;

  let proc = null;
  let ready = false;
  let adopted = false;
  let ownerPid = null;
  let boundPort = options.port ?? DEFAULT_PORT;
  let lastError = null;

  const baseUrlFor = (p) => `http://${host}:${p}`;

  async function portResponds(p) {
    try {
      const resp = await fetchFn(`${baseUrlFor(p)}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return !!resp;
    } catch {
      return false;
    }
  }

  async function probeOnce() {
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp) return "down";
      if (resp.ok) return "ready";
      // 503 with phase "failed" is terminal: the sidecar is alive but the
      // model did not load (missing kokoro/soundfile, bad weights). Polling
      // it for the full ready timeout hides the real reason for minutes.
      try {
        const body = await resp.json();
        if (body?.status === "failed") {
          const detail = errText(body.error, `kokoro sidecar reported ${resp.status}`);
          sttLog("kokoro.ready", `model load failed: ${String(detail).slice(0, 200)}`);
          return { failed: detail };
        }
      } catch {}
      return "down";
    } catch {
      return "down";
    }
  }

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return { failed: "kokoro sidecar exited before becoming ready" };
      const state = await probeOnce();
      if (state === "ready") return state;
      if (state && typeof state === "object" && state.failed) return state;
      await new Promise((r) => setTimeout(r, readyPollMs));
    }
    return "timeout";
  }

  async function startOnPort(port) {
    boundPort = port;
    if (await portResponds(port)) {
      const probe = await probeOnce();
      if (probe === "ready") {
        adopted = true;
        ready = true;
        ownerPid = null;
        sttLog("kokoro.spawn", `adopted healthy sidecar on port ${port}`);
        return { ok: true, adopted: true };
      }
      // A live server that reports a failed model load is THIS engine, broken
      // - not a port conflict to walk past. Scanning onward would hide the
      // real error behind "no free port".
      if (probe && typeof probe === "object" && probe.failed) {
        return {
          ok: false,
          code: "MODEL_LOAD_FAILED",
          advancable: false,
          message: probe.failed,
        };
      }
      return {
        ok: false,
        code: "PORT_IN_USE",
        advancable: true,
        message: `Port ${port} already answers`,
      };
    }
    adopted = false;
    const bin = python || "python3";
    const args = buildKokoroArgs({ scriptPath, host, port, voice });
    sttLog("kokoro.spawn", `bin=${bin} port=${port} voice=${voice}`);
    try {
      proc = spawnFn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      proc = null;
      return {
        ok: false,
        code: "SPAWN_FAILED",
        advancable: false,
        message: `Failed to spawn ${bin}: ${err.message}`,
      };
    }

    let stderr = "";
    const owned = proc;
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      logger?.log?.("VOICE", `kokoro stderr: ${chunk.toString().trim()}`, "debug");
    });
    proc.on("exit", (code) => {
      if (proc !== owned) return;
      lastError = {
        code: "EXITED",
        message: `kokoro sidecar exited (code=${code}) stderr=${stderr.trim().slice(-200)}`,
      };
      proc = null;
      ready = false;
      ownerPid = null;
      logger?.log?.(
        "VOICE",
        `kokoro sidecar exited (code=${code}) stderr=${stderr.trim().slice(-200)}`,
        "warn",
      );
    });
    proc.on("error", (err) => {
      if (proc !== owned) return;
      logger?.log?.("VOICE", `kokoro sidecar error: ${err.message}`, "warn");
      proc = null;
      ready = false;
      ownerPid = null;
    });

    const outcome = await pollReady(Date.now() + readyTimeoutMs);
    sttLog("kokoro.ready", `port=${boundPort} outcome=${typeof outcome === "string" ? outcome : "failed"}`);
    if (outcome !== "ready") {
      const tail = stderr.trim().slice(-300);
      const message =
        outcome === "timeout"
          ? `kokoro sidecar did not become ready in time (${readyTimeoutMs}ms) stderr=${tail}`
          : `kokoro sidecar unavailable: ${outcome.failed ?? "unknown"}`;
      const code = outcome === "timeout" ? "START_TIMEOUT" : "MODEL_LOAD_FAILED";
      sttLog("kokoro.ready", `failed code=${code} msg=${String(message).slice(0, 200)}`);
      stop();
      return { ok: false, code, advancable: false, message };
    }
    ownerPid = proc?.pid ?? null;
    return { ok: true };
  }

  async function start() {
    if (ready) return true;
    const scanMax = Math.max(1, Math.floor(portScanMax) || 1);
    for (let i = 0; i < scanMax; i++) {
      const port = boundPort + i;
      const r = await startOnPort(port);
      if (r.ok) {
        ready = true;
        lastError = null;
        logger?.log?.(
          "VOICE",
          `kokoro sidecar ready at ${baseUrlFor(boundPort)} voice=${voice} pid=${ownerPid}`,
          "debug",
        );
        return true;
      }
      if (!r.advancable) {
        lastError = { code: r.code, message: r.message };
        logger?.log?.("VOICE", r.message, "warn");
        return false;
      }
      logger?.log?.("VOICE", r.message, "warn");
    }
    lastError = {
      code: "PORT_RANGE_EXHAUSTED",
      message: `No free port in ${boundPort}..${boundPort + scanMax - 1}`,
    };
    logger?.log?.("VOICE", lastError.message, "warn");
    return false;
  }

  async function synthesize(text, opts = {}) {
    if (!ready) {
      return {
        ok: false,
        code: lastError?.code || "NOT_READY",
        message: lastError?.message || "kokoro sidecar not ready",
      };
    }
    try {
      const resp = await fetchFn(`${baseUrlFor(boundPort)}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: opts.voice || voice,
          lang: opts.lang,
        }),
        signal: AbortSignal.timeout(synthesizeTimeoutMs),
      });
      if (!resp?.ok) {
        let message = `kokoro sidecar responded ${resp?.status}`;
        try {
          const data = await resp.json();
          if (data?.error != null) message = errText(data.error, message);
        } catch {
          // Keep the status-based message.
        }
        sttLog("kokoro.synth", `BAD_STATUS http=${resp?.status} msg=${String(message).slice(0, 200)}`);
        return { ok: false, code: "BAD_STATUS", message };
      }
      const audio = Buffer.from(await resp.arrayBuffer());
      if (audio.length === 0) {
        return { ok: false, code: "EMPTY_AUDIO", message: "kokoro returned no audio" };
      }
      return { ok: true, wav: audio };
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      if (adopted && !timedOut) {
        ready = false;
        adopted = false;
      }
      sttLog("kokoro.synth", `${timedOut ? "SYNTH_TIMEOUT" : "REQUEST_FAILED"} err=${String(err?.message || err).slice(0, 200)}`);
      return {
        ok: false,
        code: timedOut ? "SYNTH_TIMEOUT" : "REQUEST_FAILED",
        message: `kokoro synthesis failed: ${err.message}`,
      };
    }
  }

  function stop() {
    ready = false;
    adopted = false;
    ownerPid = null;
    if (proc) {
      const owned = proc;
      proc = null;
      try {
        owned.kill("SIGTERM");
      } catch {}
    }
  }

  function isRunning() {
    return ready && (proc !== null || adopted);
  }

  function getLastError() {
    return lastError;
  }

  function getPort() {
    return boundPort;
  }

  return { start, stop, synthesize, isRunning, getLastError, getPort };
}

export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PORT_SCAN_MAX, SIDECAR_PATH };
