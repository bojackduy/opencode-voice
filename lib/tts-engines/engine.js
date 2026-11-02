// Adapter contract for TTS engines. Plain JSDoc only - no runtime types.

import { measurePcmDurationSec, measureWavDurationSec } from "../tts/player.js";

/**
 * @typedef {object} TtsAudio
 * @property {Buffer} [wav]
 * @property {Buffer} [pcm]
 * @property {number} [sampleRate]
 * @property {number} [channels]
 * @property {number} [bits]
 */

/**
 * @typedef {object} TtsEngine
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {(lang: string) => boolean} supportsLang
 * @property {() => Promise<boolean>} ensureReady
 * @property {(text: string, ctx: {lang: string}) =>
 *   Promise<{ok: true, audio: TtsAudio} | {ok: false, code: string, message: string}>} synthesize
 * @property {() => boolean} isRunning
 * @property {() => object|null} getLastError
 * @property {() => void} dispose
 * @property {() => object[]} [commands]
 */

// Normalize either audio shape into the player's load argument. The orchestrator
// calls this once per group so the player never sees engine-specific shapes.
export function toLoadArg(audio) {
  if (!audio) return null;
  if (Buffer.isBuffer(audio.wav) && !audio.pcm) return { wav: audio.wav };
  if (Buffer.isBuffer(audio.pcm)) {
    return {
      pcm: audio.pcm,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      bits: audio.bits,
    };
  }
  if (Buffer.isBuffer(audio.wav)) return { wav: audio.wav };
  return null;
}

// Measure a synthesized audio buffer's duration in seconds, or null when it
// cannot be read. Accepts either { wav: Buffer } or { pcm, sampleRate, ... }.
export function measureAudioSec(audio) {
  if (!audio) return null;
  if (Buffer.isBuffer(audio.wav)) return measureWavDurationSec(audio.wav);
  if (Buffer.isBuffer(audio.pcm)) {
    return measurePcmDurationSec(
      { bytes: audio.pcm },
      audio.sampleRate,
      audio.channels ?? 1,
      audio.bits ?? 16,
    );
  }
  return null;
}

// Alias kept for the plan's alternate name.
export const measureDurationSec = measureAudioSec;
