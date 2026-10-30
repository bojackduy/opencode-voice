# Product Positioning — opencode-voice

**Status:** Draft v1 (auto-generated from codebase inspection, 2026-10-30)

## Product description

`opencode-voice` is a plugin for [OpenCode](https://opencode.ai/) that adds
speech-to-text (STT) and text-to-speech (TTS) to the terminal-based AI coding
assistant. It records voice prompts with local whisper transcription, transcribes
and normalizes them with an LLM, and inserts the result at the focused cursor
without auto-sending. It also speaks assistant responses aloud via Piper (or
Chatterbox / VieNeu-TTS), with per-sentence language routing and LLM
summarization of code-heavy replies. A hands-free conversation mode ties both
directions together.

- Package: `@bojackduy/opencode-voice` (npm, public)
- License: AGPL-3.0-or-later
- Repo: https://github.com/bojackduy/opencode-voice
- Stars: 0 · Forks: 0 · Version: 0.11.3

## Primary audience

Developers who use OpenCode as their AI coding assistant and want to:

- Dictate prompts instead of typing (faster for long, multi-part requests)
- Listen to responses while keeping eyes on code (hands-busy, walking, reviewing)
- Use voice accessibility affordances in a terminal workflow

Secondary: non-English (especially Vietnamese) developers who want bilingual
speech, since most TTS tools are English-only or need separate voice models.

## User pain points

1. Typing long, detailed prompts into a terminal composer is slow and breaks flow.
2. Reading long assistant responses pulls attention away from the code.
3. Most voice tools are GUI-first and don't integrate with terminal AI assistants.
4. Cloud STT/TTS raises privacy concerns for code that shouldn't leave the machine.
5. Bilingual (Vietnamese + English code-switching) speech is poorly supported by
   existing tools.

## Value proposition

Voice in and voice out for OpenCode, fully local by default, bilingual, and
terminal-native. Speak a prompt; hear the answer — without leaving your editor
or sending audio to a cloud.

## Differentiators

1. **OpenCode-native.** Built as a first-class OpenCode plugin (v1 + v2 via
   capability detection), not a generic dictation tool bolted on.
2. **Local-first.** whisper-cpp + sox for STT, Piper/Chatterbox/VieNeu for TTS.
   Audio never leaves the machine unless you opt into a hosted endpoint.
3. **Insert, don't send.** Transcripts land at the focused cursor as editable
   text. Nothing is submitted unless explicitly requested.
4. **Bilingual code-switching.** VieNeu-TTS handles Vietnamese + English in a
   single utterance; per-sentence language routing picks the right voice.
5. **LLM normalization.** Homophones, camelCase splitting, code summarization,
   diagram/table summarization — speech that sounds like a person, not a
   compiler.
6. **Hands-free conversation mode.** Auto-silence finalize + auto-listen after
   reply, with barge-in.
7. **Streaming dictation.** Live waveform + live transcript with pause/auto-end
   toggles.

## Competitors

| Product                      | Relation | Gap we fill                                            |
| ---------------------------- | -------- | ------------------------------------------------------ |
| GitHub Copilot Voice         | Adjacent | GitHub-only, cloud, no terminal integration            |
| Cursor voice mode            | Adjacent | GUI IDE, cloud, English-focused                        |
| Superwhisper / MacWhisper    | Adjacent | Generic dictation, no OpenCode integration, no TTS-out |
| OS dictation (macOS/Windows) | Adjacent | No LLM normalization, no TTS, no code awareness        |
| OpenAI Realtime API          | Infra    | Cloud-only, paid, no terminal UX                       |

**No direct competitor** exists for terminal-native, local-first, bilingual
voice in/out specifically for OpenCode. The closest substitutes are generic
dictation apps used alongside (not inside) the editor.

## Suggested pricing / monetization (assumption)

The project is AGPL and free. Realistic paths:

- **GitHub Sponsors** for ongoing maintenance (primary, low-friction).
- **Optional paid hosted STT/TTS endpoint** for users who don't want to install
  whisper-cpp / Piper locally (freemium tier). Not implemented yet.
- **Consulting / custom voice models** for teams.

No paid tier exists today. Do not imply one in marketing.

## Recommended marketing channels

1. GitHub (README, topics, releases) — primary discovery for devs.
2. npm (keywords, README renders) — installation path.
3. Hacker News "Show HN" — developer tool audience.
4. Reddit: r/programming, r/LocalLLaMA, r/vietnamese (bilingual angle), r/commandline.
5. X/Twitter dev community — short demos.
6. OpenCode community / Discord — direct audience.
7. Vietnamese developer communities (Facebook groups, Zalo) — bilingual angle.
8. YouTube short demos — waveform + conversation mode.

## Assumptions (labeled)

- Audience size and growth targets are unknown; no analytics exist yet.
- No user testimonials or usage metrics exist; marketing must not fabricate them.
- Monetization is undecided; free/open-source is the current reality.
- Landing page does not exist yet; needs to be built.
