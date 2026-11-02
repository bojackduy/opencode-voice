import { createPiperEngine } from "./piper.js";
import { createChatterboxEngine } from "./chatterbox.js";
import { createVieneuEngine } from "./vieneu.js";
import { createKokoroEngine } from "./kokoro.js";

import {
  isChatterboxVariant,
  DEFAULT_CHATTERBOX_VARIANT,
  chatterboxSupportsLang,
} from "../sidecars/chatterbox-server.js";

export function createEngineRegistry({ opts, kv, logger, toast, deps }) {
  const engines = [
    createPiperEngine({ opts, kv, logger, toast, deps }),
    createChatterboxEngine({ opts, kv, logger, toast, deps }),
    createVieneuEngine({ opts, kv, logger, toast, deps }),
    createKokoroEngine({ opts, kv, logger, toast, deps }),
  ];
  const byId = new Map(engines.map((e) => [e.id, e]));
  const warned = new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    logger?.log?.("TTS", message, "warn");
  }

  return {
    list: () => engines.slice(),
    get: (id) => byId.get(id) ?? null,
    resolve: (configuredId, lang) => {
      const configured =
        configuredId ?? kv?.get?.("tts.engine", opts?.ttsEngine) ?? opts?.ttsEngine;
      if (!configured || configured === "piper") {
        return { engine: byId.get("piper"), fallback: false, reason: "default" };
      }
      const engine = byId.get(configured);
      if (!engine) {
        warnOnce(
          `unknown:${configured}`,
          `Unknown ttsEngine "${configured}" - expected "piper", "chatterbox", "vieneu", or "kokoro"; using Piper`,
        );
        return { engine: byId.get("piper"), fallback: true, reason: "unknown-engine" };
      }
      // Chatterbox variant validation.
      if (configured === "chatterbox") {
        const requested = opts?.ttsChatterboxVariant;
        if (requested && !isChatterboxVariant(requested)) {
          warnOnce(
            `variant:${requested}`,
            `Unknown ttsChatterboxVariant "${requested}" - expected multilingual | turbo | nano; using "${DEFAULT_CHATTERBOX_VARIANT}"`,
          );
        }
      }
      if (!engine.supportsLang(lang)) {
        const msg =
          configured === "vieneu"
            ? `VieNeu-TTS cannot speak "${lang}" - using Piper for this utterance`
            : configured === "kokoro"
              ? `Kokoro cannot speak "${lang}" - using Piper for this utterance`
              : `Chatterbox variant "${isChatterboxVariant(opts?.ttsChatterboxVariant) ? opts.ttsChatterboxVariant : DEFAULT_CHATTERBOX_VARIANT}" cannot speak "${lang}" - using Piper for this utterance`;
        warnOnce(`unsupported:${configured}:${lang}`, msg);
        return { engine: byId.get("piper"), fallback: true, reason: "unsupported-language" };
      }
      return { engine, fallback: false, reason: "ok" };
    },
    disposeAll: () => {
      for (const e of engines) {
        try {
          e.dispose();
        } catch {}
      }
    },
  };
}
