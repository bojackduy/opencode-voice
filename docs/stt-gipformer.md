# STT engine option: Gipformer 1.5 (Vietnamese)

Non-breaking alternate local transcription engine behind `stt.engine`.
Default stays `whisper`; nothing changes unless you opt in.

## What it is

- Model: `g-group-ai-lab/gipformer1.5-68M-rnnt` (68M params).
- Type: Zipformer Transducer = RNN-T (transducer) architecture. RNN-T is a
  streaming-capable design (frame-synchronous joint network); this plugin
  uses it in one-shot batch mode per recording, same as whisper-cli.
  True frame-streaming (partial hypotheses while recording) is future work.
- Language: Vietnamese only, 16kHz.
- License: MIT (model weights + `gipformer` code). No license friction.
- Accuracy: best Vietnamese WER in its class on the upstream benchmarks
  (call-center tele-medium/hard, vi-asr tech/edu/finance/pubadmin,
  VietMed/MultiMED, ViMD). English / multilingual dictation stays on whisper.

## Requirements

1. Clone the runner once:
   `git clone https://github.com/ggroup-ai-lab/gipformer && cd gipformer && uv sync`
   (installs ONNX runtime via `uv`; needs network on first run).
2. `python3` on PATH with that venv activated (or point
   `stt.gipformer.python` at the venv binary — not yet exposed; uses
   plain `python3` today).
3. First transcription auto-downloads weights from Hugging Face; or pass
   `--model-dir` via `stt.gipformer.modelDir` to reuse a local copy.

## Configuration (options + kv only, no dotfiles)

| Key       | Via                                                      | Default       | Notes                                        |
| --------- | -------------------------------------------------------- | ------------- | -------------------------------------------- |
| engine    | kv `stt.engine` / opt `sttEngine`                        | `whisper`     | kv wins; unknown values fall back to whisper |
| version   | kv `stt.gipformer.version` / opt `sttGipformerVersion`   | `1.5`         | `1` selects the older 68M checkpoint         |
| quantize  | kv `stt.gipformer.quantize` / opt `sttGipformerQuantize` | `int8`        | `null` = fp32; int8 is smaller/faster on CPU |
| model dir | kv `stt.gipformer.modelDir` / opt `sttGipformerModelDir` | auto-download | local model directory                        |

Switch in the TUI: `/stt-engine` (also flips the warm whisper-server lease
like `/stt-model` does). Check current engine: `getSttEngine()` on the STT
context.

## How it fits the code

- `lib/stt/gipformer.js` — pure resolvers (`getSttEngine`,
  `getGipformerConfig`), argv builder (`buildGipformerArgs`), stdout parser,
  and `transcribeFileGipformer(wav, cfg, logger)` with the same
  `{text} | {error}` contract as `transcribeFileLocal`.
- `lib/stt.js` `transcribe()` routes by engine; chunked long-turn splitting
  (`transcribeMaybeChunked`) is reused unchanged via a bound transcribeFn.
  The transducer is Vietnamese-only, so whisper model/language args are
  ignored in the gipformer branch.
- Empty recording / missing file / runner failure / timeout map to distinct
  `{error}` strings (same discipline as the whisper path).

## Tradeoffs

- Pro: much smaller (68M vs 244M–1.5B PhoWhisper), faster on CPU with int8,
  better Vietnamese accuracy, fully offline after weights fetch, MIT.
- Con: Vietnamese-only; needs a repo checkout + python env (whisper needs
  only the `whisper-cli` binary); per-span LLM normalization still runs
  downstream (unchanged latency there); no live partials yet.
