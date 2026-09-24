// Voice-only preprocessing for live notes (and anything else that feeds
// quiet far-field audio to whisper).
//
// A classroom professor 3-5m from a laptop mic produces RMS ~0.01-0.02 -
// right at the chunker silence threshold and far below what whisper.cpp was
// trained on. Human ears compensate with automatic gain control; whisper
// does not, so it hallucinates (Vietnamese YouTube outros) or mistranscribes
// instead. This module applies the missing AGC in software before each chunk
// reaches whisper:
//
//   1. measure the chunk (RMS + peak, same math as audio-chunker.js)
//   2. compute the gain needed to bring speech up to a healthy target level
//   3. run sox: highpass (room rumble/HVAC out) + gain with limiter (speech
//      up, loud chunks untouched, never clips)
//
// Enhancement is per-chunk (not in the live capture chain) so the mic path
// stays untouched and a failed enhance can never lose audio - on any sox
// error the original file is kept as-is.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pcm16Rms } from "./audio-chunker.js";

export const DEFAULT_ENHANCE_TARGET_RMS = 0.1;
export const DEFAULT_ENHANCE_MAX_GAIN_DB = 24;
export const DEFAULT_ENHANCE_HIGHPASS_HZ = 80;
// Chunks quieter than this are essentially silence - gaining them up only
// amplifies noise into hallucination fuel, so they pass through untouched.
export const DEFAULT_ENHANCE_MIN_RMS = 0.004;

/**
 * RMS + peak (both 0..1) of a PCM16LE mono buffer. Pure.
 */
export function measurePcmStats(pcmBuffer) {
  const rms = pcm16Rms(pcmBuffer);
  let peak = 0;
  const usable = pcmBuffer.length - (pcmBuffer.length % 2);
  for (let i = 0; i < usable; i += 2) {
    const a = Math.abs(pcmBuffer.readInt16LE(i) / 32768);
    if (a > peak) peak = a;
  }
  return { rms, peak };
}

export function rmsToDb(rms) {
  if (!rms || rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/**
 * Gain in dB needed to bring `rms` up to `targetRms`. Never negative
 * (loud chunks stay as they are) and never above `maxGainDb`. Pure.
 */
export function computeGainDb(rms, options = {}) {
  const targetRms = options.targetRms ?? DEFAULT_ENHANCE_TARGET_RMS;
  const maxGainDb = options.maxGainDb ?? DEFAULT_ENHANCE_MAX_GAIN_DB;
  if (!rms || rms <= 0 || rms >= targetRms) return 0;
  return Math.min(maxGainDb, 20 * Math.log10(targetRms / rms));
}

/**
 * sox effect chain: strip sub-voice rumble, then adaptive gain with the
 * limiter engaged so an underestimated peak can never clip. Pure.
 */
export function buildEnhanceArgs(gainDb, options = {}) {
  const highpassHz = options.highpassHz ?? DEFAULT_ENHANCE_HIGHPASS_HZ;
  return ["highpass", String(highpassHz), "gain", "-l", gainDb.toFixed(1)];
}

/**
 * Enhance one chunk WAV file in place for whisper. `pcm` is the raw chunk
 * samples (used for measurement so we don't have to re-read the file).
 * Returns stats for the JSONL sidecar; `enhanced:false` means the original
 * file was kept untouched (quiet-as-silence, already loud, or sox failed).
 */
export function enhanceWavFile(wavPath, pcm, options = {}, logger) {
  const targetRms = options.targetRms ?? DEFAULT_ENHANCE_TARGET_RMS;
  const maxGainDb = options.maxGainDb ?? DEFAULT_ENHANCE_MAX_GAIN_DB;
  const minRms = options.minRms ?? DEFAULT_ENHANCE_MIN_RMS;

  const before = measurePcmStats(pcm);
  const noEnhance = (reason) => ({
    enhanced: false,
    reason,
    rmsBefore: before.rms,
    peakBefore: before.peak,
    gainDb: 0,
  });

  if (before.rms < minRms) return noEnhance("too-quiet");
  const gainDb = computeGainDb(before.rms, { targetRms, maxGainDb });
  if (gainDb <= 0) return noEnhance("already-loud");

  const tmpPath = `${wavPath}.enh.wav`;
  const args = [wavPath, "-b", "16", tmpPath, ...buildEnhanceArgs(gainDb, options)];
  let res;
  try {
    res = spawnSync("sox", args, { timeout: 15000 });
  } catch (err) {
    logger?.log("VOICE", `Enhance spawn failed, keeping original: ${err.message}`, "warn");
    return noEnhance("sox-spawn-failed");
  }
  if (res.error || res.status !== 0) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    logger?.log(
      "VOICE",
      `Enhance failed, keeping original: ${(res.error?.message || res.stderr?.toString().trim() || `exit ${res.status}`).slice(0, 200)}`,
      "warn",
    );
    return noEnhance("sox-failed");
  }

  let after;
  try {
    const out = fs.readFileSync(tmpPath);
    after = measurePcmStats(out.subarray(Math.min(44, out.length)));
    fs.renameSync(tmpPath, wavPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    logger?.log("VOICE", `Enhance replace failed, keeping original: ${err.message}`, "warn");
    return noEnhance("replace-failed");
  }
  return {
    enhanced: true,
    gainDb,
    rmsBefore: before.rms,
    peakBefore: before.peak,
    rmsAfter: after.rms,
    peakAfter: after.peak,
  };
}
