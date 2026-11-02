// Extracted TTS commands (Phase C2). Built once from a TtsContext so
// registerTTS stays assembly-only.

/**
 * @param {any} ctx
 * @returns {any[]}
 */
export function createCommands(ctx) {
  const commands = [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      category: "opencode-voice",
      description: "Read the last assistant response aloud (detailed)",
      ...(ctx.kb("tts.speak-last") ? { keybind: ctx.kb("tts.speak-last") } : {}),
      slash: { name: "tts-speak" },
      onSelect() {
        ctx.speakLastResponse();
      },
    },
    {
      title: "TTS: speak a past response",
      value: "tts.speak-past",
      category: "opencode-voice",
      description: "Pick a previous assistant response from a list and read it aloud",
      slash: { name: "tts-speak-past" },
      onSelect() {
        ctx.speakPastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      category: "opencode-voice",
      description: "Toggle auto text-to-speech on/off",
      ...(ctx.kb("tts.mode") ? { keybind: ctx.kb("tts.mode") } : {}),
      slash: { name: "tts-mode" },
      onSelect() {
        const current = ctx.kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        ctx.kv.set("tts.mode", next);
        if (next === "off") {
          // Conversation speech pauses through its own loop so the status line
          // and buttons move to "Paused" instead of staying on "Speaking".
          if (!(ctx.conversationTtsActive() && ctx.conversationTtsHooks.onStopKey?.()))
            ctx.stopSpeech();
        }
        if (next === "on") {
          const enVoice =
            ctx.TTS_VOICES[ctx.kv.get("tts.voice", ctx.DEFAULT_TTS_VOICE)] ||
            ctx.TTS_VOICES[ctx.DEFAULT_TTS_VOICE];
          const viPath = ctx.path.join(ctx.voicesDir, ctx.TTS_VOICES.vi.file);
          const hasVi = ctx.fs.existsSync(viPath);
          ctx.toast(
            hasVi
              ? `TTS on (auto: ${enVoice.label} / ${ctx.TTS_VOICES.vi.label})`
              : `TTS on (${enVoice.label})`,
          );
        } else {
          ctx.toast("TTS off");
        }
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      category: "opencode-voice",
      description: "Stop current TTS playback",
      ...(ctx.kb("tts.stop") ? { keybind: ctx.kb("tts.stop") } : {}),
      slash: { name: "tts-stop" },
      onSelect() {
        if (ctx.conversationTtsActive() && ctx.conversationTtsHooks.onStopKey?.()) return;
        if (ctx.stopSpeech()) ctx.toast("TTS stopped");
      },
    },
    {
      title: "TTS: pause / resume playback",
      value: "tts.pause",
      category: "opencode-voice",
      description: "Pause speaking mid-speech, resume when paused",
      ...(ctx.kb("tts.pause") ? { keybind: ctx.kb("tts.pause") } : {}),
      slash: { name: "tts-pause" },
      onSelect() {
        // Pausing playback would leave the conversation loop awaiting audio
        // that never finishes, so the mic would never reopen. Pause the loop
        // instead: it stops the audio and moves the status line to paused.
        if (ctx.conversationTtsActive()) {
          if (ctx.conversationTtsHooks.onStopKey?.()) return;
          ctx.toast("Conversation is not speaking", "warning");
          return;
        }
        const state = ctx.player.getState();
        if (state.status === "playing" && ctx.controller.pause()) ctx.toast("Paused");
        else if (state.status === "paused" && ctx.controller.resume()) ctx.toast("Resumed");
        else ctx.toast("Nothing playing", "warning");
      },
    },
    {
      title: "TTS: replay from start",
      value: "tts.replay",
      category: "opencode-voice",
      description: "Restart the current utterance from zero",
      ...(ctx.kb("tts.replay") ? { keybind: ctx.kb("tts.replay") } : {}),
      slash: { name: "tts-replay" },
      onSelect() {
        if (ctx.player.replay()) ctx.toast(`Replaying from start (${ctx.progressLabel()})`);
        else ctx.toast("Nothing to replay", "warning");
      },
    },
    {
      title: "TTS: rewind 5 seconds",
      value: "tts.rewind",
      category: "opencode-voice",
      description: "Jump back 5 seconds in the current utterance",
      ...(ctx.kb("tts.rewind") ? { keybind: ctx.kb("tts.rewind") } : {}),
      slash: { name: "tts-rewind" },
      onSelect() {
        if (ctx.player.getState().exactTotal) {
          ctx.player.rewind(ctx.SEEK_STEP_SEC);
          ctx.toast(`Rewound (${ctx.progressLabel()})`);
        } else ctx.toast("Nothing to rewind", "warning");
      },
    },
    {
      title: "TTS: forward 5 seconds",
      value: "tts.forward",
      category: "opencode-voice",
      description: "Jump ahead 5 seconds in the current utterance",
      ...(ctx.kb("tts.forward") ? { keybind: ctx.kb("tts.forward") } : {}),
      slash: { name: "tts-forward" },
      onSelect() {
        if (ctx.player.getState().exactTotal) {
          ctx.player.forward(ctx.SEEK_STEP_SEC);
          ctx.toast(`Forwarded (${ctx.progressLabel()})`);
        } else ctx.toast("Nothing to skip", "warning");
      },
    },
    {
      title: "TTS: playback speed",
      value: "tts.rate",
      category: "opencode-voice",
      description: "Choose playback speed 0.75x-2x (persisted)",
      slash: { name: "tts-rate" },
      onSelect() {
        const current = String(ctx.currentRate());
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select playback speed",
            current,
            options: ["0.75", "1", "1.25", "1.5", "1.75", "2"].map((label) => ({
              title: `${label}x`,
              value: label,
              onSelect() {
                const applied = ctx.controller.setRate(Number(label));
                ctx.toast(`Playback speed: ${applied}x`);
                ctx.api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select voice",
      value: "tts.voice",
      category: "opencode-voice",
      description: "Choose TTS voice",
      slash: { name: "tts-voice" },
      onSelect() {
        const current = ctx.kv.get("tts.voice", ctx.DEFAULT_TTS_VOICE);
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select voice (auto vi/en)",
            current,
            options: Object.entries(ctx.TTS_VOICES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                if (key.startsWith("vi")) ctx.kv.set("tts.voice.vi", key);
                else ctx.kv.set("tts.voice", key);
                ctx.toast(`Voice: ${v.label} (auto vi/en)`);
                ctx.api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select engine",
      value: "tts.engine",
      category: "opencode-voice",
      description: "Choose TTS engine (piper, chatterbox, vieneu) - persisted",
      slash: { name: "tts-engine" },
      onSelect() {
        const current = ctx.kv.get("tts.engine", ctx.opts?.ttsEngine || "piper");
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select TTS engine",
            current,
            options: ctx.registry.list().map((engine) => ({
              title: `${engine.label} (${engine.description})`,
              value: engine.id,
              onSelect() {
                ctx.kv.set("tts.engine", engine.id);
                ctx.sttLog("tts.engine.set", engine.id);
                ctx.toast(`TTS engine: ${engine.id}`);
                ctx.api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select output",
      value: "tts.output",
      category: "opencode-voice",
      description: "Choose TTS output: local speaker or phone (remote)",
      slash: { name: "tts-output" },
      onSelect() {
        const remoteConfigured = !!ctx.buildRemotePlayCmd(ctx.getRemoteConfig());
        const options = [];
        if (remoteConfigured) {
          options.push({
            title: "Phone (remote)",
            value: "remote",
            onSelect() {
              ctx.kv.set("tts.output", "remote");
              ctx.toast("TTS output: phone (remote)");
              ctx.api.ui.dialog.clear();
            },
          });
        }
        options.push({
          title: "Local speaker",
          value: "local",
          onSelect() {
            ctx.kv.set("tts.output", "local");
            ctx.toast("TTS output: local");
            ctx.api.ui.dialog.clear();
          },
        });
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select TTS output",
            current: ctx.kv.get("tts.output", "local"),
            options,
          }),
        );
      },
    },
    ...ctx.adapterCommands,
  ];
  return commands;
}
