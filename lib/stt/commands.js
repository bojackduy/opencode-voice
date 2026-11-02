// Extracted STT commands (Phase C). Built once from a SttContext so
// registerSTT stays assembly-only.
//
// @param {any} ctx
// @returns {any[]}
export function createCommands(ctx) {
  const commands = [
    {
      title: ctx.sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      value: "stt.record",
      category: "opencode-voice",
      description:
        ctx.sttApiEndpoint && ctx.autoSubmit
          ? "Toggle ctx.recording(); press again to stop, transcribe via API and submit"
          : ctx.sttApiEndpoint
            ? "Toggle ctx.recording(); press again to stop and transcribe via API"
            : ctx.autoSubmit
              ? "Toggle ctx.recording(); press again to stop, transcribe and submit"
              : "Toggle ctx.recording(); press again to stop and transcribe",
      ...(ctx.kb("stt.record") ? { keybind: ctx.kb("stt.record") } : {}),
      slash: { name: "stt-record" },
      onSelect() {
        // Streaming mode: toggle streaming record/finalize, or resume a
        // paused session (cheaper than re-speaking; explicit stop stays on
        // /stt-stop). Batch default below is behavior-identical to before.
        ctx.sttLog(
          "toggle",
          `sttMode=${ctx.currentSttMode()} streamingActive=${ctx.getStreamingActive()}`,
        );
        // Conversation owns the live turn. Finalizing or cancelling the
        // stream here would bypass finishTurnFlow: no submit, no reply wait,
        // no speech, and the mode stays stuck on "Listening". The STT key
        // therefore means the same thing as the conversation key.
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("record");
          return;
        }
        if (ctx.currentSttMode() === "streaming") {
          if (ctx.getStreamingActive()) {
            try {
              if (ctx.streamController()?.getState?.().paused) {
                ctx.toggleStreamingPause();
                return;
              }
            } catch {}
            void ctx.finalizeStreamingDictation({ submit: false });
            return;
          }
          if (ctx.liveNotesActive()) {
            ctx.toast("Live notes ctx.recording() - stop it first (/voice-notes-stop)", "warning");
            return;
          }
          if (ctx.processing() || ctx.recording()) {
            ctx.toast("STT busy, please wait...");
            return;
          }
          void ctx.startStreamingDictation();
          return;
        }
        if (ctx.getStreamingActive()) {
          ctx.toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes ctx.recording() - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (ctx.processing()) {
          ctx.toast("STT busy, please wait...");
          return;
        }
        if (ctx.recording()) {
          ctx.clearRecordingToast();
          ctx.toast("Stopping, transcribing...");
          ctx.doTranscribePipeline(
            ctx.kv,
            ctx.complete,
            ctx.client,
            ctx.api,
            ctx.toast,
            ctx.systemPrompt,
            ctx.autoSubmit,
            ctx.logger,
            ctx.renderer,
          );
        } else {
          ctx.startLoopRecording();
        }
      },
    },
    {
      title: ctx.sttApiEndpoint
        ? "STT: submit ctx.recording() (API)"
        : "STT: submit ctx.recording()",
      value: "stt.submit",
      category: "opencode-voice",
      description: ctx.sttApiEndpoint
        ? "Stop ctx.recording(), transcribe via API, and submit prompt"
        : "Stop ctx.recording(), transcribe, and submit prompt",
      ...(ctx.kb("stt.submit") ? { keybind: ctx.kb("stt.submit") } : {}),
      slash: { name: "stt-submit" },
      onSelect() {
        // Streaming mode: finalize then submit ONLY via the captured
        // target's own submit(). Never falls through to primary-chat submit.
        // Conversation owns the turn (see stt.record).
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("submit");
          return;
        }
        if (ctx.currentSttMode() === "streaming") {
          if (!ctx.getStreamingActive()) {
            ctx.toast("No streaming dictation in progress", "warning");
            return;
          }
          void ctx.finalizeStreamingDictation({ submit: true });
          return;
        }
        if (ctx.getStreamingActive()) {
          ctx.toast("Streaming dictation active - use /stt-stop to cancel first", "warning");
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes ctx.recording() - stop it first (/voice-notes-stop)", "warning");
          return;
        }
        if (ctx.processing()) {
          ctx.toast("STT busy, please wait...");
          return;
        }
        if (!ctx.recording()) {
          ctx.toast("No ctx.recording() in progress", "warning");
          return;
        }
        ctx.clearRecordingToast();
        ctx.toast("Stopping, transcribing...");
        ctx.doTranscribePipeline(
          ctx.kv,
          ctx.complete,
          ctx.client,
          ctx.api,
          ctx.toast,
          ctx.systemPrompt,
          true,
          ctx.logger,
          ctx.renderer,
        );
      },
    },
    {
      title: "STT: cancel ctx.recording()",
      value: "stt.stop",
      category: "opencode-voice",
      description: "Cancel current ctx.recording()",
      slash: { name: "stt-stop" },
      onSelect() {
        // Conversation owns the turn: cancel the ctx.recording() through the loop so
        // the mode returns to paused instead of sitting on "Listening" with a
        // dead stream.
        if (ctx.conversationActive()) {
          ctx.conversationHooks.onKey?.("cancel");
          return;
        }
        // Streaming mode: cancel and remove ONLY plugin-owned dictation
        // text, never user-typed text.
        if (ctx.currentSttMode() === "streaming" || ctx.getStreamingActive()) {
          if (ctx.getStreamingActive()) {
            void ctx.cancelStreamingDictation();
            return;
          }
          if (ctx.liveNotesActive()) {
            ctx.toast("Live notes ctx.recording() - use /voice-notes-stop", "warning");
            return;
          }
          return;
        }
        if (ctx.liveNotesActive()) {
          ctx.toast("Live notes ctx.recording() - use /voice-notes-stop", "warning");
          return;
        }
        if (ctx.recording()) {
          ctx.cancelRecording(ctx.logger);
          ctx.logger?.log("STT", "Recording cancelled", "debug");
          ctx.toast("Recording cancelled");
        }
      },
    },
    {
      title: "STT: pause / resume streaming dictation",
      value: "stt.pause",
      category: "opencode-voice",
      description: "Freeze the mic mid-dictation (skips noise); run again to resume",
      slash: { name: "stt-pause" },
      onSelect() {
        // Conversation records through its own loop: there is no dictation
        // session to freeze, and pausing the mic would strand the live turn.
        if (ctx.conversationActive()) {
          ctx.toast(
            "Conversation is ctx.recording() - use the conversation key to send or /stt-stop to cancel",
          );
          return;
        }
        // Batch mode has no pausable session (one-shot record); the mic
        // toggle is start/stop there.
        if (ctx.currentSttMode() !== "streaming" && !ctx.getStreamingActive()) {
          ctx.toast("Pause needs streaming mode - use /stt-mode to switch", "warning");
          return;
        }
        void ctx.pauseStreamingDictation();
      },
    },
    {
      title: "STT: select dictation mode",
      value: "stt.mode",
      category: "opencode-voice",
      description: "Choose one-shot batch or live streaming dictation (saved, survives restarts)",
      slash: { name: "stt-mode" },
      onSelect() {
        const current = ctx.currentSttMode();
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select dictation mode",
            current,
            options: [
              {
                title: "Streaming (live transcript + wave, local whisper, no LLM)",
                value: "streaming",
                onSelect() {
                  ctx.kv.set("stt.mode", "streaming");
                  ctx.sttLog("mode.set", "streaming via /stt-mode");
                  ctx.toast("Dictation mode: streaming");
                  ctx.api.ui.dialog.clear();
                },
              },
              {
                title: "Batch (record, then transcribe)",
                value: "batch",
                onSelect() {
                  ctx.kv.set("stt.mode", "batch");
                  ctx.sttLog("mode.set", "batch via /stt-mode");
                  ctx.toast("Dictation mode: batch");
                  ctx.api.ui.dialog.clear();
                },
              },
            ],
          }),
        );
      },
    },
    {
      title: "STT: toggle auto-submit",
      value: "stt.autosubmit",
      category: "opencode-voice",
      description: "Toggle submitting the transcript automatically after dictation (saved)",
      slash: { name: "stt-autosubmit" },
      onSelect() {
        const next = !ctx.sttAutoSubmitEnabled();
        ctx.kv.set("stt.ctx.autoSubmit", next);
        ctx.sttLog("mode.set", `ctx.autoSubmit=${next} via /stt-autosubmit`);
        ctx.toast(`STT auto-submit: ${next ? "on" : "off"}`);
      },
    },
    {
      title: "STT: toggle auto-end (batch)",
      value: "stt.auto-end",
      category: "opencode-voice",
      description: "Stop ctx.recording() automatically after silence and transcribe",
      slash: { name: "stt-auto-end" },
      onSelect() {
        const current = ctx.kv.get("stt.autoEndOfSpeech") === true;
        const next = !current;
        ctx.kv.set("stt.autoEndOfSpeech", next);
        ctx.sttLog("mode.set", `autoEnd=${next} via /stt-auto-end`);
        ctx.toast(`STT auto-end: ${next ? "on" : "off"}`);
      },
    },
    {
      title: ctx.sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      value: "stt.model",
      category: "opencode-voice",
      description: ctx.sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        if (ctx.sttApiEndpoint) {
          const current = ctx.kv.get("stt.ctx.api.model") || ctx.sttApiModel;
          const apiModels = await ctx.getApiModels(ctx.logger);
          const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
          ctx.api.ui.dialog.replace(() =>
            ctx.api.ui.DialogSelect({
              title: "Select whisper model (API)",
              current,
              options: options.map((m) => ({
                title: m.label,
                value: m.value,
                onSelect() {
                  ctx.kv.set("stt.ctx.api.model", m.value);
                  ctx.toast(`Whisper API model: ${m.label}`);
                  ctx.api.ui.dialog.clear();
                },
              })),
            }),
          );
        } else {
          const current = ctx.getModelName(ctx.kv);
          ctx.api.ui.dialog.replace(() =>
            ctx.api.ui.DialogSelect({
              title: "Select whisper model",
              current,
              options: Object.entries(ctx.MODELS).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  ctx.kv.set("stt.model", key);
                  // Model change tears down the parked warm server lease so
                  // the next dictation loads the new model (refused
                  // mid-dictation by the start guards; idle teardown here).
                  if (!ctx.getStreamingActive()) ctx.disposeWarmStreamController();
                  ctx.toast(`Whisper model: ${v.label}`);
                  ctx.api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
    {
      title: "STT: select language",
      value: "stt.language",
      category: "opencode-voice",
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      onSelect() {
        const current = ctx.getLanguage(ctx.kv);
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select transcription language",
            current,
            options: Object.entries(ctx.LANGUAGES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                ctx.kv.set("stt.language", key);
                // Language is part of the server key: drop the parked warm
                // lease so the next dictation starts the new configuration.
                if (!ctx.getStreamingActive()) ctx.disposeWarmStreamController();
                ctx.toast(`Whisper language: ${v.label}`);
                ctx.api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      category: "opencode-voice",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const remoteCmd =
          ctx.getSttCaptureCmd() || ctx.buildRemoteCaptureCmd(ctx.getRemoteConfig());
        const remoteConfigured = !!remoteCmd;
        const current = ctx.kv.get("stt.mic", "");
        const options = [];
        if (remoteConfigured) {
          options.push({
            title: "Phone (remote)",
            value: "remote",
            onSelect() {
              ctx.kv.set("stt.mic", "remote");
              ctx.toast("Mic: phone (remote)");
              ctx.api.ui.dialog.clear();
            },
          });
        }
        options.push({
          title: "System default",
          value: "",
          onSelect() {
            ctx.kv.set("stt.mic", "");
            ctx.toast("Mic: system default");
            ctx.api.ui.dialog.clear();
          },
        });
        const devices = ctx.backend === "remote" ? [] : ctx.listInputDevices(ctx.backend);
        for (const d of devices) {
          options.push({
            title: d.label,
            value: d.name,
            onSelect() {
              ctx.kv.set("stt.mic", d.name);
              ctx.toast(`Mic: ${d.label}`);
              ctx.api.ui.dialog.clear();
            },
          });
        }
        if (options.length <= 2 && !remoteConfigured) {
          ctx.toast("No local mic found. Run /stt-remote-setup to use a phone mic.", "warning");
          return;
        }
        ctx.api.ui.dialog.replace(() =>
          ctx.api.ui.DialogSelect({
            title: "Select microphone",
            current: remoteConfigured && current === "remote" ? "remote" : current,
            options,
          }),
        );
      },
    },
    {
      title: "STT: set up remote (phone) mic",
      value: "stt.remote-setup",
      category: "opencode-voice",
      description: "Configure phone host/port/key for remote capture",
      slash: { name: "stt-remote-setup" },
      onSelect() {
        ctx.toast("Remote setup starting...");
        const state = ctx.getRemoteConfig();
        const cmd = [
          "ssh",
          "-i",
          state.key,
          "-p",
          String(state.port),
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          state.host,
          "echo OK",
        ];
        let ok = false;
        try {
          const out = ctx.execSync(cmd[0] + " " + cmd.slice(1).join(" "), {
            encoding: "utf-8",
            timeout: 10000,
          });
          ok = String(out).trim() === "OK";
        } catch (err) {
          ok = false;
          ctx.toast(`SSH test failed: ${err?.message || err}`, "error");
        }
        ctx.kv.set("stt.remoteHost", state.host);
        ctx.kv.set("stt.remotePort", state.port);
        ctx.kv.set("stt.remoteKey", state.key);
        ctx.kv.set("audio.sampleRate", state.rate);
        if (ok) {
          ctx.kv.set("stt.mic", "remote");
          if (ctx.kv.get("tts.output") == null) ctx.kv.set("tts.output", "remote");
          ctx.toast("Phone mic configured and selected");
        } else {
          ctx.toast("Saved config (SSH test failed)", "warning");
        }
      },
    },
  ];

  return commands;
}
