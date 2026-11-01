export function createPiperEngine({ opts, kv, logger, toast, deps }) {
  return {
    id: "piper",
    label: "Piper",
    description: "Default Piper TTS (offline, multilingual voices)",
    tracksPending: true,
    supportsLang: () => true,
    ensureReady: async () => true,
    synthesize: async (text, ctx) => {
      const voiceModel = deps?.resolveVoice?.(text);
      if (!voiceModel) {
        return { ok: false, code: "NO_VOICE", message: "no voice model" };
      }
      if (deps?.piperOnPath && !deps.piperOnPath()) {
        return { ok: false, code: "NO_PIPER", message: "piper not on PATH" };
      }
      let pcm;
      try {
        pcm = await deps?.synthPiperToPcm?.(voiceModel, text);
      } catch (err) {
        return { ok: false, code: "REQUEST_FAILED", message: err?.message || String(err) };
      }
      if (!pcm || pcm.length === 0) {
        return { ok: false, code: "EMPTY", message: "empty audio" };
      }
      const rate = deps?.getVoiceRate?.(voiceModel) ?? 22050;
      return { ok: true, audio: { pcm, sampleRate: rate, channels: 1, bits: 16 } };
    },
    isRunning: () => false,
    getLastError: () => null,
    dispose: () => {},
  };
}
