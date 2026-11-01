import { vieneuSupportsLang } from "../vieneu-server.js";

const VIENEU_VOICES = [
  "Adam bựa",
  "Trúc Ly",
  "Thiện Minh",
  "Mai Anh",
  "Hải Đăng",
  "Thùy Dung",
  "Thiền Tâm Đức",
  "Ngọc Huyền",
  "Quang Sơn",
  "Ngọc Trân",
  "Minh Đức",
  "Phạm Tuyên",
  "Thái Sơn",
  "Xuân Vĩnh",
  "Thanh Bình",
  "Ngọc Linh",
  "Đoan Trang",
  "Thục Đoan",
  "Minh Triết",
  "Mỹ Duyên",
  "Quỳnh Anh",
  "Đức Trí",
  "Kim Thanh",
  "Adam",
  "Quốc Tuấn",
];

export function createVieneuEngine({ opts, kv, logger, toast, deps }) {
  const api = deps?.api;
  return {
    id: "vieneu",
    label: "VieNeu-TTS",
    description: "Bilingual Vietnamese-English TTS with code-switching",
    supportsLang: (lang) => vieneuSupportsLang(lang),
    ensureReady: () =>
      deps?.ensureVieneuReady ? deps.ensureVieneuReady() : Promise.resolve(false),
    synthesize: async (text, ctx) => {
      const ready = await (deps?.ensureVieneuReady
        ? deps.ensureVieneuReady()
        : Promise.resolve(false));
      if (!ready) {
        const client = deps?.getVieneuClient?.();
        const err = client?.getLastError?.();
        return {
          ok: false,
          code: err?.code || "START_FAILED",
          message: err?.message || "unavailable",
        };
      }
      const client = deps?.getVieneuClient?.();
      let result;
      try {
        result = await client.synthesize(text);
      } catch (err) {
        result = { ok: false, code: "REQUEST_FAILED", message: err?.message || String(err) };
      }
      if (result?.ok) return { ok: true, audio: { wav: result.wav } };
      return { ok: false, code: result?.code, message: result?.message };
    },
    isRunning: () => deps?.getVieneuClient?.()?.isRunning?.() ?? false,
    getLastError: () => deps?.getVieneuClient?.()?.getLastError?.() ?? null,
    dispose: () => {
      try {
        deps?.disposeVieneu?.();
      } catch {}
    },
    // Engine-owned command: voice selection. Value and slash name are frozen.
    commands: () => [
      {
        title: "TTS: select VieNeu voice",
        value: "tts.vieneu-voice",
        category: "opencode-voice",
        description: "Choose VieNeu-TTS voice (bilingual vi+en) - persisted",
        slash: { name: "tts-vieneu-voice" },
        onSelect() {
          const current = kv.get("tts.vieneuVoice", opts?.ttsVieneuVoice || "Mai Anh");
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select VieNeu voice",
              current,
              options: VIENEU_VOICES.map((name) => ({
                title: name,
                value: name,
                onSelect() {
                  kv.set("tts.vieneuVoice", name);
                  // Reset client so next speak uses new voice.
                  try {
                    deps?.resetVieneuClient?.();
                  } catch {}
                  toast(`VieNeu voice: ${name}`);
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
