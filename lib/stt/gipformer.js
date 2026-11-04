// Gipformer 1.5 STT engine option (Vietnamese Zipformer RNN-T).
//
// Research summary (2026-11-02):
// - Model: g-group-ai-lab/gipformer1.5-68M-rnnt, 68M params, Zipformer
//   Transducer (RNN-T) architecture, Vietnamese-only, 16kHz, int8-quantized
//   ONNX available. RNN-T transducers support streaming decoding; the
//   upstream repo ships ONNX inference (sherpa-onnx / onnxruntime) plus a
//   PyTorch/icefall stack (Linux + CUDA only).
// - License: MIT (model + code). No license friction for local use.
// - Runtime: `python infer_onnx.py --audio f.wav [--quantize int8]
//   [--version 1|1.5] [--model-dir dir]` after `uv sync` in a clone of
//   github.com/ggroup-ai-lab/gipformer. CPU/GPU/mobile via ONNX.
// - Fit: this plugin's local path is whisper-cli shaped
//   (transcribeFileLocal(wavFile, modelPath, language, logger)). Gipformer
//   plugs in as an alternate transcribeFn with the same WAV-in/text-out
//   contract, selected by `stt.engine` (kv wins, options fallback,
//   default "whisper" so existing behavior is unchanged). Chunked
//   long-turn splitting is engine-agnostic and reused as-is.
// - Tradeoffs: Vietnamese-only (whisper stays the multilingual default);
//   needs a repo checkout + python env (heavier setup than a whisper bin);
//   per-span LLM normalization still applies downstream.

import fs from "node:fs";
import path from "node:path";

export const GIPFORMER_HF_REPO = "g-group-ai-lab/gipformer1.5-68M-rnnt";
export const GIPFORMER_GITHUB = "https://github.com/ggroup-ai-lab/gipformer";
export const GIPFORMER_LICENSE = "MIT";
export const GIPFORMER_DEFAULT_VERSION = "1.5";
export const GIPFORMER_DEFAULT_QUANTIZE = "int8";

const ENGINES = new Set(["whisper", "gipformer"]);

/**
 * Canonical engine resolver. kv wins (including explicit "whisper"),
 * options are the configured fallback, unknown values fall back to
 * "whisper" so a typo can never brick transcription.
 * @param {any} kv
 * @param {any} opts
 * @returns {"whisper"|"gipformer"}
 */
export function getSttEngine(kv, opts) {
  try {
    const fromKv = kv?.get?.("stt.engine");
    if (fromKv === "gipformer" || fromKv === "whisper") return fromKv;
  } catch {}
  try {
    if (opts?.sttEngine === "gipformer" || opts?.sttEngine === "whisper") return opts.sttEngine;
  } catch {}
  return "whisper";
}

/**
 * Gipformer runner config. kv wins per key, options are the fallback.
 * modelDir null = auto-download into the upstream script's cache.
 * @param {any} kv
 * @param {any} opts
 */
export function getGipformerConfig(kv, opts) {
  let version = GIPFORMER_DEFAULT_VERSION;
  let quantize = GIPFORMER_DEFAULT_QUANTIZE;
  let modelDir = null;
  let python = "python3";
  let script = "infer_onnx.py";
  let timeoutMs = 120000;
  try {
    version = kv?.get?.("stt.gipformer.version", version) ?? version;
  } catch {}
  try {
    quantize = kv?.get?.("stt.gipformer.quantize", quantize) ?? quantize;
  } catch {}
  try {
    modelDir = kv?.get?.("stt.gipformer.modelDir", modelDir) ?? modelDir;
  } catch {}
  try {
    if (opts?.sttGipformerVersion != null && kv?.get?.("stt.gipformer.version") == null) {
      version = opts.sttGipformerVersion;
    }
  } catch {}
  try {
    if (opts?.sttGipformerQuantize !== undefined && kv?.get?.("stt.gipformer.quantize") == null) {
      quantize = opts.sttGipformerQuantize;
    }
  } catch {}
  try {
    if (opts?.sttGipformerModelDir && kv?.get?.("stt.gipformer.modelDir") == null) {
      modelDir = opts.sttGipformerModelDir;
    }
  } catch {}
  try {
    python = kv?.get?.("stt.gipformer.python", python) ?? python;
  } catch {}
  try {
    if (opts?.sttGipformerPython && kv?.get?.("stt.gipformer.python") == null) {
      python = opts.sttGipformerPython;
    }
  } catch {}
  try {
    script = kv?.get?.("stt.gipformer.script", script) ?? script;
  } catch {}
  try {
    if (opts?.sttGipformerScript && kv?.get?.("stt.gipformer.script") == null) {
      script = opts.sttGipformerScript;
    }
  } catch {}
  return {
    version: String(version),
    quantize,
    modelDir,
    python,
    script,
    timeoutMs,
    repo: GIPFORMER_HF_REPO,
  };
}

/**
 * argv (after the python binary) for upstream infer_onnx.py. Pure.
 * @param {string} wavFile
 * @param {{version?: string, quantize?: string|null, modelDir?: string|null, script?: string}} cfg
 */
export function buildGipformerArgs(wavFile, cfg = {}) {
  const script = cfg.script || "infer_onnx.py";
  const args = [script, "--audio", wavFile];
  const major = String(cfg.version ?? GIPFORMER_DEFAULT_VERSION).startsWith("1.5") ? "1.5" : "1";
  args.push("--version", major);
  if (cfg.quantize) args.push("--quantize", String(cfg.quantize));
  if (cfg.modelDir) args.push("--model-dir", String(cfg.modelDir));
  return args;
}

/**
 * Extract the transcript from the upstream script's stdout. The script prints
 * a banner (download/loading notices) and a trailing summary block
 * (`File:`, `Text:`, `Time: ... RTF:`), so the LAST `Text:` line is the
 * transcript. Falls back to trimmed stdout for any quiet-mode variant.
 */
export function parseGipformerStdout(stdout) {
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*Text:\s?(.*)$/);
    if (m) return m[1].trim();
  }
  return String(stdout ?? "").trim();
}

/**
 * WAV-in/text-out transcription via the Gipformer ONNX script.
 * Same result contract as transcribeFileLocal: {text} | {error}.
 * @param {string} wavFile
 * @param {object} cfg
 * @param {any} logger
 * @param {{spawn?: Function}} deps
 */
export async function transcribeFileGipformer(wavFile, cfg = {}, logger = null, deps = {}) {
  if (!fs.existsSync(wavFile)) {
    logger?.log?.("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  try {
    if (fs.statSync(wavFile).size <= 44) {
      logger?.log?.("STT", `Recording file empty: ${wavFile}`, "warn");
      return { error: "Recording is empty - no audio captured" };
    }
  } catch (err) {
    return { error: `Recording unreadable: ${err?.message || err}` };
  }
  const full = { ...getGipformerConfig(null, null), ...cfg };
  // A bare "infer_onnx.py" never resolves against the host process cwd
  // (e.g. the user's $HOME) — search the conventional checkouts first and
  // fail fast with the exact setup remedy instead of a raw python ENOENT.
  const os = await import("node:os");
  let scriptPath = full.script;
  if (!path.isAbsolute(scriptPath) && !scriptPath.includes(path.sep)) {
    const home = os.homedir();
    const candidates = [
      path.resolve(process.cwd(), scriptPath),
      path.join(home, "Code", "gipformer", scriptPath),
      path.join(home, "gipformer", scriptPath),
    ];
    scriptPath = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
  } else if (!path.isAbsolute(scriptPath)) {
    scriptPath = path.resolve(process.cwd(), scriptPath);
  }
  if (!fs.existsSync(scriptPath)) {
    logger?.log?.("STT", `Gipformer script missing: ${scriptPath}`, "error");
    return {
      error:
        `Gipformer script not found: ${scriptPath} — clone ${GIPFORMER_GITHUB} to ~/Code/gipformer, ` +
        `run uv sync there, or set stt.gipformer.script (kv) / sttGipformerScript (option) to its infer_onnx.py`,
    };
  }
  const args = buildGipformerArgs(wavFile, { ...full, script: scriptPath });
  // Prefer the checkout's own uv venv: the upstream deps (soundfile,
  // onnxruntime, sherpa-onnx) live there, and system python3 does not have
  // them. Explicit kv/option python still wins.
  let python = full.python;
  const configuredPython = full.python && full.python !== "python3";
  if (!configuredPython) {
    const venv = path.join(path.dirname(scriptPath), ".venv", "bin", "python");
    if (fs.existsSync(venv)) python = venv;
  }
  logger?.log?.(
    "STT",
    `Gipformer transcription requested version=${full.version} quantize=${full.quantize || "fp32"} python=${python}`,
    "debug",
  );
  let spawnFn = deps.spawn;
  if (!spawnFn) {
    try {
      spawnFn = (await import("node:child_process")).spawn;
    } catch (err) {
      return { error: `Gipformer runner unavailable: ${err?.message || err}` };
    }
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnFn(python, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: path.dirname(scriptPath),
      });
    } catch (err) {
      logger?.log?.("STT", `Gipformer runner failed: ${err?.message || err}`, "error");
      resolve({ error: `Gipformer runner failed: ${err?.message || err}` });
      return;
    }
    if (!child?.stdout) {
      resolve({ error: "Gipformer runner failed: no process streams" });
      return;
    }
    logger?.log?.("STT", `Started gipformer pid=${child.pid}`, "debug");
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      logger?.log?.("STT", "Gipformer timed out", "error");
      resolve({ error: "Transcription timed out (120s)" });
    }, full.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      logger?.log?.("STT", `Gipformer runner error: ${err.message}`, "error");
      resolve({ error: `Gipformer runner failed: ${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split("\n").pop() || `gipformer exited (code=${code})`;
        logger?.log?.(
          "STT",
          `Gipformer exited code=${code} stderr=${stderr.trim().slice(-300)}`,
          "error",
        );
        // Name the setup mistake instead of leaking a bare traceback line.
        const missing = stderr.match(/ModuleNotFoundError: No module named '([^']+)'/);
        if (missing) {
          resolve({
            error:
              `Gipformer venv is missing "${missing[1]}" (${python}) — run uv sync in ` +
              `${path.dirname(scriptPath)}, or point stt.gipformer.python at that venv's python`,
          });
          return;
        }
        resolve({ error: tail });
        return;
      }
      const text = parseGipformerStdout(stdout);
      if (!text) {
        logger?.log?.("STT", "Gipformer returned empty transcript", "warn");
        resolve({ error: "Gipformer returned empty transcript" });
        return;
      }
      logger?.log?.("STT", `Gipformer transcription succeeded chars=${text.length}`, "debug");
      resolve({ text });
    });
  });
}
