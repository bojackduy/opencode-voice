# Bug: long batch turn fails with `error: 1 input file(s) failed`, whole record discarded

Date: 2026-11-04. Plugin version: 0.12.0.
OS: Linux CachyOS x86_64 (VMware VM, CPU-only, whisper.cpp 1.9.5-1.1, no mic input).

## What happened

A 524s one-shot batch recording ended with error toast
`Transcription failed: error: 1 input file(s) failed`.
`kept 0/18 spans`. Nothing was inserted; the whole record was lost.
An earlier turn the same day showed the same symptom with a different error:
`Model not found: .../ggml-large-v3-turbo-q5_0.bin`.

## Root cause

1. `error: 1 input file(s) failed` is `whisper-cli` stderr, not a plugin
   message. The plugin surfaces the last stderr line on nonzero exit
   (`lib/stt.js:1288-1291`). Reproduced locally: running `whisper-cli`
   on an undecodable (44-byte header-only) wav prints
   `failed to read the frames of the audio data` then
   `error: 1 input file(s) failed`, exit 11.
   All 18 chunk spans failed fast (~5s wall, no inference ran), so the
   source audio or its extracted chunks were undecodable.
2. Zero surviving spans: `transcribeMaybeChunked` returns `firstError`
   (`lib/stt.js:1458-1461`). The pipeline error branch toasts and inserts
   nothing (`lib/stt.js:2059-2066`). Per-span fallback only helps when at
   least one span succeeds.

## Evidence (`/tmp/opencode-voice-stt.log`)

```text
2026-11-04T14:06:27Z STT chunked transcription kept 0/18 spans
2026-11-04T14:06:27Z STT Transcription failed: Model not found: .../ggml-large-v3-turbo-q5_0.bin ...
2026-11-04T14:10:37Z STT chunked transcription kept 0/18 spans
2026-11-04T14:10:37Z STT Transcription failed: error: 1 input file(s) failed
```

`/tmp/opencode-stt.wav` was 44 bytes (WAV header, zero samples) after the
session: empty capture. This VM exposes no audio input, so `sox -d`
records nothing.

## Status

- Model dir now holds `ggml-base.en.bin` (142M) + `ggml-small.bin` (466M);
  the 548M `large-v3-turbo-q5_0` file was removed (unusable on this CPU-only VM).
- `/stt-engine` now chains into the whisper model picker, so a small
  variant is one flow instead of two palette commands.
- Open: surface per-chunk errors earlier (fail fast on first span), and warn
  when the captured wav is header-only before spending chunks on it.
