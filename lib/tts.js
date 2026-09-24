// Text-to-speech: LLM normalization, Piper synthesis, sox playback.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getSessionTitle } from "./session.js";
import { clearProcessingToast, showProcessingToast, updateProcessingToast } from "./stt.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
  vi: { label: "Vais (vi_VN medium)", file: "vi_VN-vais1000-medium.onnx" },
  vi_vivo: { label: "Vivos (vi_VN x_low)", file: "vi_VN-vivos-x_low.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";
// Vietnamese diacritics — used for auto vi/en detection
const VI_REGEX = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;

const PIPER_RATE = 22050;
const PIPER_BITS = 16;
const PIPER_CHANNELS = 1;

// ---- Local (no-LLM) speech cleanup ----
// Deterministic markdown -> spoken-text transform. Zero network latency, so it
// backs streaming speech and ttsNormalizeMode "local". Less polished than the
// LLM narrator (no summarization), but instant.

function splitIdentifier(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

export function localSpeechCleanup(text) {
  if (!text) return "";
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, " code snippet ");
  out = out.replace(/`([^`]+)`/g, (_, code) => ` ${splitIdentifier(code)} `);
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^[>\s]*[-*+]\s+/gm, "");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2");
  out = out
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok) || !tok) return tok;
      if (/^https?:\/\//i.test(tok)) {
        const domain = tok.replace(/^https?:\/\/([^/]+).*$/i, "$1");
        return domain.replace(/\./g, " dot ");
      }
      const base = tok.includes("/") ? tok.slice(tok.lastIndexOf("/") + 1) : tok;
      if (/^\w[\w.-]*\.[a-z0-9]{1,4}$/i.test(base)) {
        const dot = base.lastIndexOf(".");
        return `${splitIdentifier(base.slice(0, dot))} dot ${base.slice(dot + 1)}`;
      }
      return splitIdentifier(tok);
    })
    .join("");
  return out.replace(/\s+/g, " ").trim();
}

// Split streamed text into complete spoken sentences. Returns what is ready
// plus the trailing incomplete fragment to keep buffering. Sentences that
// look like code dumps (overlong, backticks) are skipped by the caller.

export function splitSpokenSentences(text) {
  const flat = (text || "").replace(/\s+/g, " ");
  const parts = flat.split(/(?<=[.!?…])\s+/);
  if (parts.length === 0) return { sentences: [], rest: "" };
  const lastComplete = /[.!?…]\s*$/.test(flat);
  if (lastComplete) return { sentences: parts.filter(Boolean), rest: "" };
  const rest = parts.pop() || "";
  return { sentences: parts.filter(Boolean), rest };
}

export function isSpeakableSentence(sentence) {
  const s = (sentence || "").trim();
  if (!s || s.length > 400 || s.includes("`")) return false;
  return true;
}

// Decide ONE language for the whole call (utterance or, during streaming,
// one completed sentence) and speak all of it with that single voice - no
// mid-utterance voice switching, since splicing separately synthesized clips
// sounds jarring (clicks/gaps between voices).
//
// Root-cause fix: the old rule was "any Vietnamese diacritic anywhere in the
// text -> vi voice". A single stray diacritic word in an English-dominant
// reply (e.g. a name) flipped the ENTIRE text to the Vietnamese voice, which
// then mispronounced every English word - and conversely, if the diacritics
// got normalized away, a Vietnamese reply flipped to the English voice. That
// is the "speaks Vietnamese with English (voice) and English with Vietnamese
// (voice)" bug. Fix: majority vote over words - only route to "vi" when a
// meaningful share of words actually carry Vietnamese diacritics, so one
// stray word can no longer flip the whole utterance.

const VI_LANG_WORD_THRESHOLD = 0.15;

export function detectLang(text) {
  if (!text) return "en";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "en";
  const viWords = words.filter((w) => VI_REGEX.test(w)).length;
  return viWords / words.length >= VI_LANG_WORD_THRESHOLD ? "vi" : "en";
}

// ---- Conversation-mode hooks (wired by index.js) ----
// While voice conversation owns speaking, the TTS stop key pauses the loop
// instead of just silencing (which would auto-record again).

let conversationTtsHooks = { isActive: null, onStopKey: null };

export function __setConversationTtsHooks(hooks) {
  conversationTtsHooks = { ...conversationTtsHooks, ...hooks };
}

function conversationTtsActive() {
  try {
    return conversationTtsHooks.isActive?.() === true;
  } catch {
    return false;
  }
}

// ---- System prompts ----

const SYSTEM_AUTO = `You are a text-to-speech narrator for a coding assistant CLI. Your job is to convert the assistant's markdown output into natural spoken text that is useful and pleasant to listen to.

You have three modes depending on the content complexity:

1. NARRATE - For simple explanations, short answers, and conversational responses. Convert to natural spoken text, normalizing code references for speech.
   - camelCase/PascalCase identifiers: split into words (parseConfig -> "parse config")
   - File paths: use just the filename (src/utils/helpers.ts -> "helpers dot ts")
   - Short code snippets in backticks: read them naturally
   - Keep the narrative flow intact

2. SUMMARIZE - For responses with significant code blocks, multiple file changes, or complex technical details. Provide a brief spoken summary of what was done and tell the user to check the screen.
   - Mention what was changed and why
   - Do not try to describe code blocks verbatim
   - End with something like "check the details on your screen" or "take a look at the output for the specifics"

3. NOTIFY - For very short confirmations, status updates, or acknowledgments. Keep it to one brief sentence.

Choose the appropriate mode based on the content. Most responses with code blocks should use SUMMARIZE mode. Simple Q&A or short explanations use NARRATE. Build results, "done", confirmations use NOTIFY.

Output ONLY the spoken text. Nothing else. No mode labels. No commentary.`;

const SYSTEM_MANUAL = `You are a text-to-speech reader for a coding assistant. The user has explicitly requested this text be read aloud. Read the prose content faithfully and in detail.

Rules:
- Read all prose text naturally and completely
- Code identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config", my_variable -> "my variable")
- File paths: read just the filename with extension (src/utils/helpers.ts -> "helpers dot ts")
- Line references: keep as is ("line 42")
- URLs: say "a link" or just the domain name
- Code blocks: skip entirely, just say "code block" or "code snippet"
- Error codes: expand naturally (ECONNREFUSED -> "connection refused")
- Shell commands: read them naturally (npm test -> "npm test")
- List items: read each item
- Remove markdown formatting but preserve all the informational content
- Do NOT summarize. Do NOT say "check the screen". Read everything that is prose.
- Output ONLY the spoken text`;

// ---- Session helpers ----

async function getTurnAssistantText(client, api) {
  const route = api.route.current;
  if (route.name !== "session") return null;

  const sessionID = route.params.sessionID;
  const stateMessages = api.state.session.messages(sessionID);
  if (!stateMessages || stateMessages.length === 0) return null;

  const assistantIDs = [];
  for (let i = stateMessages.length - 1; i >= 0; i--) {
    if (stateMessages[i].role === "user") break;
    if (stateMessages[i].role === "assistant") {
      assistantIDs.unshift(stateMessages[i].id);
    }
  }
  if (assistantIDs.length === 0) return null;

  const allText = [];
  for (const msgID of assistantIDs) {
    try {
      const fullMsg = await client.session
        .message({ sessionID, messageID: msgID }, { throwOnError: true })
        .then((r) => r.data);

      const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
      const text = textParts
        .map((p) => p.text || "")
        .join("\n\n")
        .trim();
      if (text) allText.push(text);
    } catch {
      // Skip messages that fail to fetch
    }
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: assistantIDs[assistantIDs.length - 1],
    text: allText.join("\n\n"),
  };
}

// ---- Public API for TUI plugin ----

export function registerTTS(api, kv, complete, prompts, opts, logger, deps = {}) {
  if (deps.isConversationActive || deps.onConversationStopKey) {
    __setConversationTtsHooks({
      isActive: deps.isConversationActive,
      onStopKey: deps.onConversationStopKey,
    });
  }
  const client = api.client;
  const systemAuto = prompts?.ttsAuto || SYSTEM_AUTO;
  const systemManual = prompts?.ttsManual || SYSTEM_MANUAL;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function getVoiceModel(text) {
    const lang = detectLang(text);
    if (lang === "vi") {
      // prefer explicit vi voice from kv, else default vi
      const viKey = kv.get("tts.voice.vi", "vi");
      const viEntry = TTS_VOICES[viKey] || TTS_VOICES.vi;
      const viPath = path.join(VOICES_DIR, viEntry.file);
      if (fs.existsSync(viPath)) return viPath;
      // fallback: any vi file present
      for (const k of ["vi", "vi_vivo"]) {
        const p = path.join(VOICES_DIR, TTS_VOICES[k].file);
        if (fs.existsSync(p)) return p;
      }
    }
    const voice = kv.get("tts.voice", DEFAULT_TTS_VOICE);
    // if voice is a vi key but text is en, still respect en
    const entry = TTS_VOICES[voice];
    // if current kv is vi but text is en, use en default
    if (entry && entry.file.includes("vi_VN") && lang === "en") {
      return path.join(VOICES_DIR, TTS_VOICES[DEFAULT_TTS_VOICE].file);
    }
    return path.join(VOICES_DIR, (entry || TTS_VOICES[DEFAULT_TTS_VOICE]).file);
  }

  function piperOnPath() {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    return pathDirs.some((dir) => fs.existsSync(path.join(dir, "piper")));
  }

  async function normalizeForSpeech(text, systemPrompt, maxTokens = 4096) {
    logger?.log?.("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens },
    });
  }

  function getVoiceRate(voicePath) {
    try {
      const j = JSON.parse(fs.readFileSync(`${voicePath}.json`, "utf-8"));
      return j?.audio?.sample_rate || PIPER_RATE;
    } catch {
      return PIPER_RATE;
    }
  }

  // ---- Audio pipeline ----

  let piperProc = null;
  let playProc = null;

  function killProcs() {
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
    }
    if (playProc) {
      try {
        playProc.kill("SIGKILL");
      } catch {}
      playProc = null;
    }
  }

  // Spawn piper -> play and wire them. Resolves onDone when playback ends.

  function spawnPlayback(voiceModel, onDone) {
    let piperStderr = "";
    let playStderr = "";
    const rate = getVoiceRate(voiceModel);
    playProc = spawn(
      "play",
      [
        "-t",
        "raw",
        "-r",
        String(rate),
        "-e",
        "signed",
        "-b",
        String(PIPER_BITS),
        "-c",
        String(PIPER_CHANNELS),
        "-q",
        "-",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    piperProc = spawn("piper", ["-m", voiceModel, "--output_raw"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    piperProc.stderr.on("data", (chunk) => {
      piperStderr += chunk.toString();
    });
    playProc.stderr.on("data", (chunk) => {
      playStderr += chunk.toString();
    });

    piperProc.stdout.on("data", (chunk) => {
      if (playProc?.stdin && !playProc.stdin.destroyed) {
        playProc.stdin.write(chunk);
      }
    });

    piperProc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        logger?.log?.("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
      }
      if (playProc?.stdin && !playProc.stdin.destroyed) {
        playProc.stdin.end();
      }
    });

    playProc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        logger?.log?.("TTS", `play exited code=${code} stderr=${playStderr.trim()}`, "error");
      } else {
        logger?.log?.("TTS", "playback finished", "debug");
      }
      piperProc = null;
      playProc = null;
      onDone();
    });

    piperProc.on("error", (err) => {
      logger?.log?.("TTS", `piper error: ${err.message}`, "error");
      killProcs();
      onDone();
    });
    playProc.on("error", (err) => {
      logger?.log?.("TTS", `play error: ${err.message}`, "error");
      killProcs();
      onDone();
    });
  }

  function resolveVoiceOrWarn(line) {
    const voiceModel = getVoiceModel(line);
    if (!piperOnPath()) {
      logger?.log?.("TTS", `Piper binary not found on PATH`, "warn");
      toast(`Piper binary not found on PATH`, "warning");
      return null;
    }
    if (!fs.existsSync(voiceModel)) {
      logger?.log?.("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast(`Voice model not found: ${voiceModel}`, "warning");
      return null;
    }
    return voiceModel;
  }

  function speak(text) {
    if (!text) return Promise.resolve();
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return Promise.resolve();

    killProcs();

    // One voice for the whole call (see detectLang) - no mid-utterance
    // switching.
    const voiceModel = resolveVoiceOrWarn(line);
    if (!voiceModel) return Promise.resolve();
    logger?.log?.("TTS", `Speak requested chars=${line.length} voice=${voiceModel}`, "debug");

    return new Promise((resolve) => {
      spawnPlayback(voiceModel, resolve);
      if (piperProc?.stdin && !piperProc.stdin.destroyed) {
        piperProc.stdin.write(line + "\n");
        piperProc.stdin.end();
      }
    });
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(sessionID, message, suffix) {
    const sessionTitle = await getSessionTitle(client, sessionID);
    const parts = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "));
  }

  function stopSpeech() {
    const wasPlaying = piperProc !== null || playProc !== null;
    killProcs();
    return wasPlaying;
  }

  // ---- Auto mode ----

  let lastSpokenMessageID = null;
  let wasBusy = false;
  // Set by the voice-conversation loop while it owns speaking, and by live
  // notes while it owns the mic. Auto TTS stays out of the way (and consumes
  // the busy flag) in both cases so replies are not spoken twice, and so a
  // live-notes recording session is never interrupted by an unrelated auto
  // TTS reply.
  let conversationActive = false;
  let liveNotesActive = false;

  api.event.on("session.status", (event) => {
    if (event.properties?.status?.type === "busy") wasBusy = true;
  });

  api.event.on("session.idle", async (event) => {
    if (conversationActive || liveNotesActive) {
      wasBusy = false;
      return;
    }
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!wasBusy) return;
    wasBusy = false;

    const sessionID = event.properties?.sessionID;
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    showProcessingToast("Normalizing response...");
    const llmResult = await normalizeOrLocal(result.text, systemAuto, 4096);
    if (!llmResult.text) {
      clearProcessingToast();
      logger?.log?.("TTS", `Auto normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Auto normalization succeeded chars=${llmResult.text.length}`, "debug");
    clearProcessingToast();
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  });

  api.event.on("permission.asked", async (event) => {
    if (conversationActive || liveNotesActive) return;
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "Permission requested. Please check your screen.",
    );
  });

  api.event.on("question.asked", async (event) => {
    if (conversationActive || liveNotesActive) return;
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "A question needs your answer. Please check your screen.",
    );
  });

  // ---- Manual mode ----

  async function speakLastResponse() {
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    showProcessingToast("Normalizing response...");
    const llmResult = await normalizeOrLocal(result.text, systemManual, 4096);
    if (!llmResult.text) {
      clearProcessingToast();
      logger?.log?.("TTS", `Manual normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Manual normalization succeeded chars=${llmResult.text.length}`, "debug");
    updateProcessingToast("Speaking...");
    await speak(llmResult.text);
    clearProcessingToast();
  }

  // Speak the current assistant turn for the voice-conversation loop. Uses the
  // auto (narrate/summarize) prompt and no session prefix - the loop already
  // announces its own state via toasts.

  // ttsNormalizeMode "local" skips the LLM entirely (instant, less polished).
  const ttsLocal = opts?.ttsNormalizeMode === "local";

  async function normalizeOrLocal(text, systemPrompt, maxTokens) {
    if (ttsLocal) return { text: localSpeechCleanup(text) };
    return normalizeForSpeech(text, systemPrompt, maxTokens);
  }

  async function speakAssistantTurn() {
    const tFetch = Date.now();
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) {
      logger?.log?.("TTS", "Conversation: no assistant text to speak", "warn");
      return { spoken: false };
    }
    const fetchMs = Date.now() - tFetch;

    showProcessingToast("Normalizing response...");
    const tNormalize = Date.now();
    // Auto replies are narrated/summarized, so a tight cap is safe here (the
    // manual read-aloud keeps the full 4096).
    const llmResult = await normalizeOrLocal(result.text, systemAuto, 2048);
    const normalizeMs = Date.now() - tNormalize;
    if (!llmResult.text) {
      clearProcessingToast();
      logger?.log?.("TTS", `Conversation normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return { spoken: false, error: llmResult.error };
    }

    updateProcessingToast("Speaking...");
    const tSpeak = Date.now();
    await speak(llmResult.text);
    const speakMs = Date.now() - tSpeak;
    clearProcessingToast();
    logger?.log?.(
      "TTS",
      `Conversation timings fetchMs=${fetchMs} normalizeMs=${normalizeMs} speakMs=${speakMs} replyChars=${result.text.length}`,
      "debug",
    );
    return { spoken: true };
  }

  const DEFAULT_KEYBINDS = {
    "tts.speak-last": "<leader>]",
    "tts.stop": "<leader>;",
  };
  function kb(value) {
    const kb = opts?.keybinds;
    if (!kb || typeof kb !== "object" || Array.isArray(kb)) return DEFAULT_KEYBINDS[value];
    if (!Object.prototype.hasOwnProperty.call(kb, value)) return DEFAULT_KEYBINDS[value];
    const v = kb[value];
    if (!v || v === "none") return undefined;
    return v;
  }

  const controller = {
    speak: (text) => speak(text),
    speakAssistantTurn,
    stop: () => stopSpeech(),
    isSpeaking: () => piperProc !== null || playProc !== null,
    setConversationActive: (v) => {
      conversationActive = !!v;
    },
    setLiveNotesActive: (v) => {
      liveNotesActive = !!v;
    },
  };

  // ---- Commands ----

  const commands = [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      category: "opencode-voice",
      description: "Read the last assistant response aloud (detailed)",
      ...(kb("tts.speak-last") ? { keybind: kb("tts.speak-last") } : {}),
      slash: { name: "tts-speak" },
      onSelect() {
        speakLastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      category: "opencode-voice",
      description: "Toggle auto text-to-speech on/off",
      ...(kb("tts.mode") ? { keybind: kb("tts.mode") } : {}),
      slash: { name: "tts-mode" },
      onSelect() {
        const current = kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        kv.set("tts.mode", next);
        if (next === "off") stopSpeech();
        if (next === "on") {
          const enVoice =
            TTS_VOICES[kv.get("tts.voice", DEFAULT_TTS_VOICE)] || TTS_VOICES[DEFAULT_TTS_VOICE];
          const viPath = path.join(VOICES_DIR, TTS_VOICES.vi.file);
          const hasVi = fs.existsSync(viPath);
          toast(
            hasVi
              ? `TTS on (auto: ${enVoice.label} / ${TTS_VOICES.vi.label})`
              : `TTS on (${enVoice.label})`,
          );
        } else {
          toast("TTS off");
        }
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      category: "opencode-voice",
      description: "Stop current TTS playback",
      ...(kb("tts.stop") ? { keybind: kb("tts.stop") } : {}),
      slash: { name: "tts-stop" },
      onSelect() {
        if (conversationTtsActive() && conversationTtsHooks.onStopKey?.()) return;
        if (stopSpeech()) toast("TTS stopped");
      },
    },
    {
      title: "TTS: select voice",
      value: "tts.voice",
      category: "opencode-voice",
      description: "Choose TTS voice",
      slash: { name: "tts-voice" },
      onSelect() {
        const current = kv.get("tts.voice", DEFAULT_TTS_VOICE);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select voice (auto vi/en)",
            current,
            options: Object.entries(TTS_VOICES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                if (key.startsWith("vi")) kv.set("tts.voice.vi", key);
                else kv.set("tts.voice", key);
                toast(`Voice: ${v.label} (auto vi/en)`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
  ];

  return { commands, controller };
}
