// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, append to the TUI prompt (v1) or submit
//      immediately via session.prompt (v2 submit-only mode, see README
//      "OpenCode v1 and v2").
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary on PATH, voice models at ~/.local/share/piper-voices/
//
// Configuration via tui.json plugin options:
//   ["opencode-voice", { "endpoint": "...", "model": "...", "apiKeyEnv": "..." }]
//
// Runtime state (model, mic, voice, tts mode) persisted via api.kv.
//
// Commands (palette + slash; default shortcuts use rare leader combos to avoid collisions):
//   /stt-record          - start/stop recording + transcribe  (default: <leader>[ = ctrl+x, [)
//   /stt-submit          - stop recording + transcribe + submit (palette-only)
//   /stt-stop            - cancel recording (palette-only)
//   /stt-model           - select whisper model
//   /stt-language        - select transcription language
//   /stt-mic             - select microphone
//   /tts-speak           - read last response aloud        (default: <leader>] = ctrl+x, ])
//   /tts-mode            - toggle auto TTS on/off (palette-only)
//   /tts-stop            - stop playback                   (default: <leader>; , also palette)
//   /tts-voice           - select TTS voice
//   /voice-conversation  - toggle hands-free voice conversation (default: <leader>v = ctrl+x, v)
//   /voice-conversation-stop - exit voice conversation mode (palette-only)
//   /voice-notes-start   - start continuous live-notes recording (palette-only)
//   /voice-notes-stop    - stop live notes, flush, and save (palette-only)
//   /voice-notes-cancel  - stop live notes immediately, save in background (palette-only)
//   /voice-notes-status  - show live-notes recording status (palette-only)
//   /voice-cancel        - cancel everything in flight            (default: <leader>.)
//   All also palette-accessible via Ctrl+P or /slash. Override via plugin options `keybinds`:
//   { "keybinds": { "stt.record": "ctrl+r", "tts.speak-last": "none", "voice.conversation": "none" } }
//   Weird keys [ ] ; were chosen because opencode doesn't use them and shift variants were ignored in terminals.
//   <leader>v is free in opencode defaults (c/e/s/m/a/y/u/r/h etc. are taken) and mnemonic for voice.

import { bootVoice } from "./lib/boot.js";
import { adaptV2Context } from "./lib/v2-compat.js";

// Dual-compat export: v1's loader reads `tui`, v2's reads `setup`
// (`Plugin.define` is an identity wrapper, so a plain object carries both).
// Each host ignores the other's key. The core (`bootVoice`) is shared; v2
// runs it over the v2-compat adapted api in submit-only mode.
export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    await bootVoice(api, options);
  },
  setup: async (ctx) => {
    const adapted = adaptV2Context(ctx);
    await bootVoice(adapted.api, ctx.options, {
      submitOnly: true,
      onReady: async ({ logger }) => {
        // First-run submit-only notice (required UX disclosure): v2 has no
        // append-to-composer API, so every STT turn submits immediately.
        const notice =
          "Voice on OpenCode v2: transcripts submit immediately as-is " +
          "(submit-only mode — append-for-edit is unavailable on v2). " +
          "For live preview, set sttMode to streaming.";
        adapted.api.ui.toast({ message: notice, variant: "warning", duration: 8000 });
        logger?.log?.("plugin", `v2 submit-only mode: ${notice}`, "warn");
        // v2 has no client.app.log, so the logger above is a no-op: compat
        // warnings must surface as a toast or they are lost entirely.
        if (adapted.warnMessages.length > 0) {
          const shown = adapted.warnMessages.slice(0, 3).join(" | ");
          const rest =
            adapted.warnMessages.length > 3 ? ` (+${adapted.warnMessages.length - 3} more)` : "";
          adapted.api.ui.toast({
            message: `Voice v2 compat: ${shown}${rest}`,
            variant: "warning",
            duration: 8000,
          });
        }
        for (const message of adapted.warnMessages) {
          logger?.log?.("plugin", `v2-compat: ${message}`, "warn");
        }
      },
    });
    return adapted.cleanup;
  },
};
