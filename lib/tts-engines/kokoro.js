import { createKokoroClient } from "../kokoro-server.js";

const KOKORO_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
];

export function createKokoroEngine({ opts, kv, logger, toast, deps }) {
  const api = deps?.api;
  return {
    id: "kokoro",
    label: "Kokoro",
    description: "Local English TTS with natural prosody (Kokoro-82M)",
    supportsLang: (lang) => lang === "en",
    ensureReady: () =>
      deps?.ensureKokoroReady ? deps.ensureKokoroReady() : Promise.resolve(false),
    synthesize: async (text, ctx) => {
      const ready = await (deps?.ensureKokoroReady
        ? deps.ensureKokoroReady()
        : Promise.resolve(false));
      if (!ready) {
        const client = deps?.getKokoroClient?.();
        const err = client?.getLastError?.();
        return {
          ok: false,
          code: err?.code || "START_FAILED",
          message: err?.message || "unavailable",
        };
      }
      const client = deps?.getKokoroClient?.();
      let result;
      try {
        result = await client.synthesize(text, {
          voice: kv.get("tts.kokoroVoice", opts?.ttsKokoroVoice || "af_heart"),
          lang: ctx?.lang,
        });
      } catch (err) {
        result = { ok: false, code: "REQUEST_FAILED", message: err?.message || String(err) };
      }
      if (result?.ok) return { ok: true, audio: { wav: result.wav } };
      return { ok: false, code: result?.code, message: result?.message };
    },
    isRunning: () => deps?.getKokoroClient?.()?.isRunning?.() ?? false,
    getLastError: () => deps?.getKokoroClient?.()?.getLastError?.() ?? null,
    dispose: () => {
      try {
        deps?.disposeKokoro?.();
      } catch {}
    },
    commands: () => [
      {
        title: "TTS: select Kokoro voice",
        value: "tts.kokoro-voice",
        category: "opencode-voice",
        description: "Choose Kokoro voice (English) - persisted",
        slash: { name: "tts-kokoro-voice" },
        onSelect() {
          const current = kv.get("tts.kokoroVoice", opts?.ttsKokoroVoice || "af_heart");
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select Kokoro voice",
              current,
              options: KOKORO_VOICES.map((name) => ({
                title: name,
                value: name,
                onSelect() {
                  kv.set("tts.kokoroVoice", name);
                  try {
                    deps?.resetKokoroClient?.();
                  } catch {}
                  toast(`Kokoro voice: ${name}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        },
      },
    ],
  };
}
