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

function buildInferenceRequest(audioBuffer) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("response_format", "json");
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
}) {
  let proc = null;
  let ready = false;
  const baseUrl = `http://${host}:${port}`;

  async function pollReady(deadline) {
    while (Date.now() < deadline) {
      if (!proc) return false; // exited before becoming ready
      try {
        await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
        return true;
      } catch {
        // Any response (even 404) means the HTTP server is up; connection
        // errors mean keep waiting.
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    return false;
  }

  async function start() {
    if (!whisperServerOnPath()) {
      logger?.log("VOICE", "whisper-server not on PATH, falling back to whisper-cli", "warn");
      return false;
    }
    const args = buildWhisperServerArgs({ modelPath, language, host, port, threads });
    logger?.log("VOICE", `Starting whisper-server ${args.join(" ")}`, "debug");
    try {
      proc = spawn("whisper-server", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      logger?.log("VOICE", `Failed to spawn whisper-server: ${err.message}`, "warn");
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
      proc = null;
      ready = false;
    });
    proc.on("error", (err) => {
      logger?.log("VOICE", `whisper-server process error: ${err.message}`, "warn");
      proc = null;
      ready = false;
    });

    ready = await pollReady(Date.now() + READY_TIMEOUT_MS);
    if (!ready) {
      logger?.log("VOICE", "whisper-server did not become ready in time", "warn");
      stop();
    } else {
      logger?.log("VOICE", `whisper-server ready at ${baseUrl}`, "debug");
    }
    return ready;
  }

  async function transcribeFile(wavPath) {
    if (!ready) return { error: "whisper-server not ready" };
    try {
      const audioBuffer = await fs.promises.readFile(wavPath);
      const resp = await fetch(`${baseUrl}/inference`, {
        method: "POST",
        body: buildInferenceRequest(audioBuffer),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) {
        return { error: `whisper-server responded ${resp.status}` };
      }
      const data = await resp.json();
      return { text: (data?.text || "").trim() };
    } catch (err) {
      return { error: `whisper-server request failed: ${err.message}` };
    }
  }

  function stop() {
    ready = false;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      proc = null;
    }
  }

  function isRunning() {
    return ready;
  }

  return { start, transcribeFile, stop, isRunning };
}
