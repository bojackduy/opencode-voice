// Per-utterance audio cache: repeat playback without re-inference.
//
// A spoken group is keyed by engine + language + voice selection + text, so
// pressing "speak reply" (or re-speaking any heard text) reuses the buffered
// asset instead of paying sidecar inference again. Rate is NOT part of the
// key: tempo applies at play time, so the cached asset stays rate-neutral.
// Failures are never cached. Bounded (count + bytes) with oldest-first
// eviction; one instance lives per registerTTS call so tests stay isolated.

export function hashText(text) {
  // djb2, hex. Content key only - collisions across different sentences are
  // astronomically unlikely at this input size and the cost is one re-synth.
  let h = 5381;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function cacheKey({ engineId, lang, voiceKey, text }) {
  return [engineId, lang, voiceKey, hashText(text)].join("|");
}

export const DEFAULT_MAX_ENTRIES = 40;
export const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;

export function audioBytes(audio) {
  if (!audio) return 0;
  if (Buffer.isBuffer(audio.wav)) return audio.wav.length;
  if (Buffer.isBuffer(audio.pcm)) return audio.pcm.length;
  return 0;
}

export function createAudioCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const entries = new Map(); // key -> { audio, totalSec, bytes }
  let bytes = 0;
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      // LRU refresh: a replayed line stays cached.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, { audio, totalSec }) {
      const size = audioBytes(audio);
      if (!audio || !(totalSec > 0) || size <= 0) return false;
      if (size > maxBytes) return false;
      const prev = entries.get(key);
      if (prev) bytes -= prev.bytes;
      entries.delete(key);
      entries.set(key, { audio, totalSec, bytes: size });
      bytes += size;
      while ((entries.size > maxEntries || bytes > maxBytes) && entries.size > 0) {
        const oldest = entries.keys().next().value;
        const evicted = entries.get(oldest);
        entries.delete(oldest);
        bytes -= evicted?.bytes ?? 0;
      }
      return true;
    },
    stats() {
      return { entries: entries.size, bytes };
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
