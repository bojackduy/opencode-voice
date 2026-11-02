import {
  isChatterboxVariant,
  DEFAULT_CHATTERBOX_VARIANT,
  chatterboxSupportsLang,
} from "../sidecars/chatterbox-server.js";

export function createChatterboxEngine({ opts, kv, logger, toast, deps }) {
  function variant() {
    const r = opts?.ttsChatterboxVariant;
    return isChatterboxVariant(r) ? r : DEFAULT_CHATTERBOX_VARIANT;
  }
  return {
    id: "chatterbox",
    label: "Chatterbox",
    description: "Local Chatterbox TTS (high quality, 23 languages)",
    supportsLang: (lang) => chatterboxSupportsLang(variant(), lang),
    ensureReady: () =>
      deps?.ensureChatterboxReady ? deps.ensureChatterboxReady() : Promise.resolve(false),
    synthesize: async (text, ctx) => {
      const lang = ctx?.lang ?? "en";
      const ready = await (deps?.ensureChatterboxReady
        ? deps.ensureChatterboxReady()
        : Promise.resolve(false));
      if (!ready) {
        const client = deps?.getChatterboxClient?.();
        const err = client?.getLastError?.();
        return {
          ok: false,
          code: err?.code || "START_FAILED",
          message: err?.message || "unavailable",
        };
      }
      const client = deps?.getChatterboxClient?.();
      let result;
      try {
        result = await client.synthesize(text, lang);
      } catch (err) {
        result = { ok: false, code: "REQUEST_FAILED", message: err?.message || String(err) };
      }
      if (result?.ok) return { ok: true, audio: { wav: result.wav } };
      return { ok: false, code: result?.code, message: result?.message };
    },
    isRunning: () => deps?.getChatterboxClient?.()?.isRunning?.() ?? false,
    getLastError: () => deps?.getChatterboxClient?.()?.getLastError?.() ?? null,
    dispose: () => {
      try {
        deps?.disposeChatterbox?.();
      } catch {}
    },
  };
}
