// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, append to the TUI prompt.
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
//   All also palette-accessible via Ctrl+P or /slash. Override via plugin options `keybinds`:
//   { "keybinds": { "stt.record": "ctrl+r", "tts.speak-last": "none", "voice.conversation": "none" } }
//   Weird keys [ ] ; were chosen because opencode doesn't use them and shift variants were ignored in terminals.
//   <leader>v is free in opencode defaults (c/e/s/m/a/y/u/r/h etc. are taken) and mnemonic for voice.

import fs from "node:fs";
import os from "node:os";
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { registerConversation } from "./lib/conversation.js";
import { registerVoiceModel, resolveVoiceProviderModel } from "./lib/voice-model.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";

function loadPromptFile(filePath, logger, name) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    const prompt = fs.readFileSync(resolved, "utf-8").trim() || null;
    logger?.log(
      "plugin",
      prompt ? `Loaded ${name} prompt: ${resolved}` : `Ignored empty ${name} prompt: ${resolved}`,
      "debug",
    );
    return prompt;
  } catch (err) {
    logger?.log("Plugin", `Failed to load ${name} prompt ${resolved}: ${err.message}`, "warn");
    return null;
  }
}

export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    const { kv } = api;
    const logger = createLogger(api.client);
    logger.log("plugin", "Initializing", "debug");
    // Session-scoped gateways (opencode.ai/zen/go) require x-opencode-session.
    // Read the live route at call time so normalize works in any session.
    // The voice-selected provider (/voice-model) fills endpoint/model only
    // when the explicit options leave them out.
    const { complete } = createClient(
      options,
      logger,
      () => {
        const route = api?.route?.current;
        return route?.name === "session" ? route?.params?.sessionID : undefined;
      },
      () => resolveVoiceProviderModel(api, kv),
    );

    const prompts = {
      stt: loadPromptFile(options?.sttPrompt, logger, "STT"),
      ttsAuto: loadPromptFile(options?.ttsAutoPrompt, logger, "TTS auto"),
      ttsManual: loadPromptFile(options?.ttsManualPrompt, logger, "TTS manual"),
    };

    const shared = {};
    const stt = registerSTT(api, kv, complete, prompts, options, logger, {
      isConversationActive: () => shared.conversation?.isActive() === true,
      onConversationKey: (source) => shared.conversation?.onKey(source),
    });
    const tts = registerTTS(api, kv, complete, prompts, options, logger, {
      isConversationActive: () => shared.conversation?.isActive() === true,
      onConversationStopKey: () => shared.conversation?.onTtsStop() === true,
    });
    const conversation = registerConversation(api, options, logger, {
      stt: stt.controller,
      tts: tts.controller,
    });
    shared.conversation = conversation.controller;
    const voiceModel = registerVoiceModel(api, kv, options, logger);

    api.command.register(() => [
      ...stt.commands,
      ...tts.commands,
      ...conversation.commands,
      ...voiceModel.commands,
    ]);
  },
};
