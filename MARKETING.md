# Marketing Content Calendar — opencode-voice

**Status:** Draft v1 (2026-10-30). All posts are drafts; do not publish without approval.

## Positioning (one-liner)

Voice in and voice out for OpenCode: local-first STT + TTS, bilingual vi+en,
hands-free conversation mode. AGPL, free.

## 30-day calendar

| Day | Channel              | Type          | Topic                                              | CTA             |
| --- | -------------------- | ------------- | -------------------------------------------------- | --------------- |
| 1   | X/Twitter            | Launch        | "Stop typing prompts. Start talking." demo GIF     | GitHub star     |
| 2   | Reddit r/programming | Show          | "I added voice in/out to my terminal AI assistant" | GitHub          |
| 3   | Blog                 | Tutorial      | "How I built local STT for a terminal AI tool"     | Docs            |
| 4   | X                    | Tip           | Streaming dictation: live waveform + transcript    | Try it          |
| 5   | OpenCode Discord     | Announce      | v0.11.3 release, new TTS engines                   | Install         |
| 6   | Reddit r/LocalLLaMA  | Technical     | Local whisper + Piper, no cloud                    | GitHub          |
| 7   | Blog                 | Deep-dive     | "LLM normalization for natural speech"             | Docs            |
| 8   | X                    | Demo          | Hands-free conversation mode (video)               | GitHub          |
| 9   | LinkedIn             | Professional  | Accessibility angle: voice for devs                | GitHub          |
| 10  | Hacker News          | Show HN       | "Show HN: opencode-voice"                          | GitHub          |
| 11  | X                    | Feature       | Bilingual vi+en code-switching (VieNeu)            | Try it          |
| 12  | Reddit r/vietnamese  | Community     | Công cụ voice cho dev VN                           | GitHub          |
| 13  | Blog                 | Comparison    | "opencode-voice vs generic dictation"              | Install         |
| 14  | X                    | Behind-scenes | Streaming partials + silence detection             | GitHub          |
| 15  | YouTube              | Short         | 60s demo: speak → transcribe → speak back          | GitHub          |
| 16  | X                    | Tip           | /tts-engine: switch Piper/Chatterbox/VieNeu        | Try it          |
| 17  | Reddit r/commandline | Show          | Terminal-native voice workflow                     | GitHub          |
| 18  | Blog                 | Tutorial      | "Set up local TTS in 5 minutes"                    | Docs            |
| 19  | X                    | Demo          | Now-playing line: pause/rewind/speed               | GitHub          |
| 20  | OpenCode community   | Update        | Conversation mode walkthrough                      | Install         |
| 21  | X                    | Metric        | (only after real metrics exist)                    | —               |
| 22  | Reddit r/programming | AMA-ish       | "Building a voice plugin for an AI CLI"            | GitHub          |
| 23  | Blog                 | Case study    | Real workflow: voice-coding a feature              | GitHub          |
| 24  | X                    | Tip           | Insert-don't-send: why it matters                  | Try it          |
| 25  | LinkedIn             | Update        | Week-4 progress + roadmap                          | GitHub          |
| 26  | Hacker News          | Comment       | Engage on voice/AI dev threads                     | —               |
| 27  | X                    | Demo          | Mic selection + model picker                       | GitHub          |
| 28  | Reddit r/LocalLLaMA  | Update        | New engine + bilingual support                     | GitHub          |
| 29  | Blog                 | Roadmap       | "What's next for opencode-voice"                   | GitHub          |
| 30  | All                  | Recap         | Month-1 recap + thank you                          | GitHub Sponsors |

## Launch post drafts

### X/Twitter (Day 1)

> Stop typing prompts. Start talking.
>
> opencode-voice adds voice in + voice out to OpenCode:
> • Local whisper STT, inserts at cursor (never auto-sends)
> • Piper/Chatterbox/VieNeu TTS, code-aware
> • Bilingual vi+en code-switching
> • Hands-free conversation mode
>
> AGPL, free. Demo 👇
> [demo.gif]
> github.com/bojackduy/opencode-voice

### Hacker News (Day 10) — Show HN

Title: Show HN: opencode-voice – voice in and voice out for OpenCode
Body:

> I built a plugin that adds speech-to-text and text-to-speech to OpenCode (the terminal AI coding assistant). STT uses local whisper-cpp, TTS uses Piper/Chatterbox/VieNeu. Transcripts insert at the cursor as editable text (no auto-send). Responses are spoken aloud with LLM normalization that summarizes code, diagrams, and tables. Bilingual Vietnamese+English via VieNeu-TTS. Hands-free conversation mode included.
>
> Local-first: audio never leaves your machine unless you opt into a hosted endpoint.
>
> Repo: https://github.com/bojackduy/opencode-voice

### Reddit r/programming (Day 2)

Title: I added voice input/output to my terminal AI coding assistant
Body: (longer, problem-focused, link to repo + demo)

### Reddit r/LocalLLaMA (Day 6)

Title: Local-first STT+TTS for a terminal AI tool (whisper-cpp + Piper/VieNeu, no cloud)
Body: technical focus on local models, bilingual vi+en.

## SEO keyword targets

Primary: "opencode voice plugin", "voice to text opencode", "text to speech opencode"
Secondary: "local speech to text cli", "whisper opencode", "bilingual tts vietnamese english"
Long-tail: "hands free coding voice assistant terminal", "piper tts opencode plugin"

## Assets needed (not yet created)

- 60s demo video (screen + audio) — use scripts/record-with-audio.sh
- Vietnamese-language demo post for r/vietnamese
- GitHub Sponsors page setup
  EOF
  echo written; wc -l MARKETING.md
