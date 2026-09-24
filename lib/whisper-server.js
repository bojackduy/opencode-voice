// Persistent local whisper-server for live notes.
//
// One-shot STT reuses whisper-cli, which reloads the model on every call -
// fine for a single utterance, but live notes transcribes a new chunk every
// few seconds and reloading a multi-GB model that often would fall behind
// the meeting. whisper-server (shipped alongside whisper-cli by the same
// whisper.cpp build) loads the model once and serves /inference over HTTP.
//
// If the binary is missing, the port is unavailable, or it fails to become
// ready in time, callers fall back to per-chunk whisper-cli - this is an
// optimization, never a hard dependency.
//
// Ownership rules (shared-port safety):
// - Before spawning, the port is probed. If anything already answers, the
//   start is refused with an explicit PORT_IN_USE error - the existing
//   process (possibly another tool, possibly an older live-notes session) is
//   never claimed as ours and never killed.
// - Readiness is established via GET /health (200 = model loaded, 503 =
//   still loading). Very old server builds without /health fall back to the
//   base URL, but only when the Server response header identifies whisper.cpp
//   - any HTTP response (a proxy, another app) must not count as ready.
// - stop() only ever signals the process this client spawned (by pid handle),
//   never a port-wide pkill.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 300;

export function whisperServerOnPath() {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return pathDirs.some((dir) => fs.existsSync(path.join(dir, "whisper-server")));
}

export function buildWhisperServerArgs({ modelPath, language, host, port, threads }) {
  const args = [
    "-m",
    modelPath,
    "-l",
    language || "auto",
    "--host",
    host || DEFAULT_HOST,
    "--port",
    String(port || DEFAULT_PORT),
  ];
  if (threads) args.push("-t", String(threads));
  return args;
}

function buildInferenceRequest(audioBuffer, responseFormat = "json") {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("response_format", responseFormat);
  form.append("temperature", "0.0");
  return form;
}

export function createWhisperServerClient({
  modelPath,
  language,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  threads,
  logger,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyPollMs = READY_POLL_MS,
  deps = {},
}) {
  const spawnFn = deps.spawn ?? spawn;
  const fetchFn = deps.fetch ?? fetch;
  let proc = null;
  let ready = false;
  let ownerPid = null;
  let lastError = null;
  const baseUrl = `http://${host}:${port}`;

  // True when something already answers on the port - i.e. a foreign owner.
  // Called before spawn only, so any responder is by definition not ours.
  async function portResponds() {
    for (const url of [`${baseUrl}/health`, baseUrl]) {
      try {
        const resp = await fetchFn(url, { signal: AbortSignal.timeout(1500) });
        if (resp) return true;
      } catch {
        // Connection refused / timeout: keep checking the next URL.
      }
    }
    return false;
  }

  // One readiness probe. Returns "ready" | "loading" | "down".
  async function probeOnce() {
    try {
      const resp = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (resp?.ok) return "ready";
      if (resp?.status === 503) return "loading";
      if (resp?.status === 404) {
        // Build predates /health: only accept the base URL when the Server
        // header identifies whisper.cpp, so a proxy or another app on the
        // port is never mistaken for our service.
        try {
          const base = await fetchFn(baseUrl, { signal: AbortSignal.timeout(1500) });
          const server = base?.headers?.get?.("server") || "";
          if (server.toLowerCase().includes("whisper")) return "ready";
        } catch {
          // Fall through to "down".
        }
        return "down";
      }
      return "down";
    } catch {
      return "down";
    }
  }

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return false; // exited before becoming ready
      const state = await probeOnce();
      if (state === "ready") {
        if (!proc) return false; // raced with exit; not ours to claim
        return true;
      }
      await new Promise((r) => setTimeout(r, readyPollMs));
    }
    return false;
  }

  async function start() {
    if (proc && ready) return true; // reuse the owned, already-ready server
    if (!whisperServerOnPath()) {
      lastError = {
        code: "SERVER_BINARY_MISSING",
        message: "whisper-server not on PATH, falling back to whisper-cli",
      };
      logger?.log("VOICE", lastError.message, "warn");
      return false;
    }
    if (await portResponds()) {
      lastError = {
        code: "PORT_IN_USE",
        message: `Port ${port} already answers - owned by another process, not starting a second whisper-server`,
      };
      logger?.log("VOICE", lastError.message, "warn");
      return false;
    }
    const args = buildWhisperServerArgs({ modelPath, language, host, port, threads });
    logger?.log("VOICE", `Starting whisper-server ${args.join(" ")}`, "debug");
    try {
      proc = spawnFn("whisper-server", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      lastError = {
        code: "SPAWN_FAILED",
        message: `Failed to spawn whisper-server: ${err.message}`,
      };
      logger?.log("VOICE", lastError.message, "warn");
      proc = null;
      return false;
    }

    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      if (!ready) {
        logger?.log(
          "VOICE",
          `whisper-server exited before ready code=${code} stderr=${stderr.trim().slice(-300)}`,
          "warn",
        );
      }
      if (proc) {
        proc = null;
        ready = false;
        ownerPid = null;
      }
    });
    proc.on("error", (err) => {
      logger?.log("VOICE", `whisper-server process error: ${err.message}`, "warn");
      if (proc) {
        proc = null;
        ready = false;
        ownerPid = null;
      }
    });

    ready = await pollReady(Date.now() + readyTimeoutMs);
    if (!ready) {
      const exitedEarly = !proc;
      lastError = exitedEarly
        ? {
            code: "EXITED_EARLY",
            message: `whisper-server exited before ready stderr=${stderr.trim().slice(-300)}`,
          }
        : {
            code: "START_TIMEOUT",
            message: `whisper-server did not become ready in time (${readyTimeoutMs}ms)`,
          };
      logger?.log("VOICE", lastError.message, "warn");
      stop();
    } else {
      ownerPid = proc?.pid ?? null;
      lastError = null;
      logger?.log("VOICE", `whisper-server ready at ${baseUrl} pid=${ownerPid}`, "debug");
    }
    return ready;
  }

  // Transcribe one WAV file. responseFormat "verbose_json" additionally
  // returns snapshot-relative segments (start/end/duration are relative to
  // the submitted audio, NOT absolute session time - see
  // lib/streaming-transcript.js). Defaults to "json" (live-notes behavior).
  // options.signal aborts the HTTP request (streaming stop/cancel/restart
  // must not leave a doomed request running while a new session starts).
  async function transcribeFile(wavPath, options = {}) {
    if (!ready) {
      return {
        error: lastError?.message || "whisper-server not ready",
        code: lastError?.code || "NOT_READY",
      };
    }
    const responseFormat = options.responseFormat || "json";
    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const audioBuffer = await fs.promises.readFile(wavPath);
      const resp = await fetchFn(`${baseUrl}/inference`, {
        method: "POST",
        body: buildInferenceRequest(audioBuffer, responseFormat),
        signal,
      });
      if (!resp.ok) {
        return { error: `whisper-server responded ${resp.status}`, code: "BAD_STATUS" };
      }
      const data = await resp.json();
      const result = { text: (data?.text || "").trim() };
      if (Array.isArray(data?.segments)) result.segments = data.segments;
      return result;
    } catch (err) {
      if (err?.name === "AbortError") {
        return { error: "whisper-server request aborted", code: "ABORTED" };
      }
      return { error: `whisper-server request failed: ${err.message}`, code: "REQUEST_FAILED" };
    }
  }

  // Transcribe an in-memory WAV buffer (streaming snapshots never touch the
  // disk). Same contract as transcribeFile (including options.signal).
  async function transcribeBuffer(wavBuffer, options = {}) {
    if (!ready) {
      return {
        error: lastError?.message || "whisper-server not ready",
        code: lastError?.code || "NOT_READY",
      };
    }
    const responseFormat = options.responseFormat || "json";
    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const resp = await fetchFn(`${baseUrl}/inference`, {
        method: "POST",
        body: buildInferenceRequest(wavBuffer, responseFormat),
        signal,
      });
      if (!resp.ok) {
        return { error: `whisper-server responded ${resp.status}`, code: "BAD_STATUS" };
      }
      const data = await resp.json();
      const result = { text: (data?.text || "").trim() };
      if (Array.isArray(data?.segments)) result.segments = data.segments;
      return result;
    } catch (err) {
      if (err?.name === "AbortError") {
        return { error: "whisper-server request aborted", code: "ABORTED" };
      }
      return { error: `whisper-server request failed: ${err.message}`, code: "REQUEST_FAILED" };
    }
  }

  // Stop ONLY the process this client spawned (by handle). A foreign process
  // on the same port is never signaled - see PORT_IN_USE above.

  // Stop ONLY the process this client spawned (by handle). A foreign process
  // on the same port is never signaled - see PORT_IN_USE above.
  function stop() {
    ready = false;
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
    return ready && proc !== null;
  }

  function getLastError() {
    return lastError;
  }

  function getOwnerPid() {
    return ownerPid;
  }

  return { start, transcribeFile, transcribeBuffer, stop, isRunning, getLastError, getOwnerPid };
}

// Shared rendezvous so the streaming dictation controller (stage 1) and
// future consumers reuse one owned server per model/language/port instead of
// racing for the port. live-notes keeps its own private client (behavior
// unchanged); a second claimant on the same port gets an explicit
// PORT_IN_USE error rather than a second server or a kill.
const sharedServers = new Map();

function sharedKey({ modelPath, language, host, port }) {
  return `${host || DEFAULT_HOST}:${port || DEFAULT_PORT}:${modelPath}:${language || "auto"}`;
}

export function acquireSharedWhisperServer(options = {}) {
  const key = sharedKey(options);
  let entry = sharedServers.get(key);
  if (!entry) {
    entry = { client: createWhisperServerClient(options), refs: 0 };
    sharedServers.set(key, entry);
  }
  entry.refs += 1;
  let released = false;
  return {
    client: entry.client,
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        sharedServers.delete(key);
        entry.client.stop();
      }
    },
  };
}

export function __clearSharedWhisperServersForTest() {
  sharedServers.clear();
}
