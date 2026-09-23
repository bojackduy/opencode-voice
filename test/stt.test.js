import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearProcessingToastState,
  __setProcessingToastFn,
  buildAudioHint,
  buildOpenRouterTranscriptionRequest,
  buildRecordArgs,
  buildWhisperArgs,
  clearProcessingToast,
  insertIntoFocusedInput,
  isOpenRouterEndpoint,
  isProcessingToastActive,
  isWSL,
  needsContext,
  parsePactlSources,
  parsePactlSourcesShort,
  showProcessingToast,
  updateProcessingToast,
} from "../lib/stt.js";

test("detects transcripts that need conversation context", () => {
  assert.equal(needsContext("ask him about it"), true);
  assert.equal(needsContext("Cristina đi đâu?"), true);
  assert.equal(needsContext("fix this file"), true);
  assert.equal(needsContext("run the tests"), false);
  assert.equal(needsContext("mở file log"), false);
  assert.equal(needsContext(""), false);
  assert.equal(needsContext(null), false);
});

test("inserts transcription into the focused OpenTUI input", () => {
  const calls = [];
  const input = {
    insertText(text) {
      calls.push(["insert", text]);
    },
    submit() {
      calls.push(["submit"]);
    },
  };

  assert.equal(insertIntoFocusedInput({ currentFocusedRenderable: input }, "hello", true), true);
  assert.deepEqual(calls, [["insert", "hello"], ["submit"]]);
});

test("does not claim non-editable focused renderables", () => {
  assert.equal(
    insertIntoFocusedInput({ currentFocusedRenderable: { focus() {} } }, "hello"),
    false,
  );
  assert.equal(insertIntoFocusedInput({ currentFocusedRenderable: null }, "hello"), false);
});

test("processing toast stays active until cleared", () => {
  const seen = [];
  __setProcessingToastFn((input) => seen.push(input));
  try {
    showProcessingToast("Transcribing...");
    assert.equal(isProcessingToastActive(), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].message, "Transcribing...");

    updateProcessingToast("Normalizing...");
    assert.equal(isProcessingToastActive(), true);
    assert.equal(seen.at(-1).message, "Normalizing...");

    clearProcessingToast();
    assert.equal(isProcessingToastActive(), false);
  } finally {
    __clearProcessingToastState();
  }
});

test("detects OpenRouter STT endpoints", () => {
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouterEndpoint("https://api.openai.com/v1"), false);
});

test("builds OpenRouter STT requests as JSON with base64 audio", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildOpenRouterTranscriptionRequest(
    "openai/whisper-large-v3-turbo",
    audioBuffer,
    "secret",
  );

  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });

  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "openai/whisper-large-v3-turbo",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  });
});

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source (RDPSource)" },
    { name: "alsa_input.usb-mic", label: "alsa_input.usb-mic" },
  ]);
});

test("parses pactl short sources and filters out monitors", () => {
  const short = [
    "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED",
    "2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED",
    "",
  ].join("\n");
  assert.deepEqual(parsePactlSourcesShort(short), [{ name: "RDPSource", label: "RDPSource" }]);
});

test("builds sox record args per audio backend", () => {
  assert.deepEqual(buildRecordArgs("pulseaudio", "RDPSource"), ["-t", "pulseaudio", "RDPSource"]);
  assert.deepEqual(buildRecordArgs("pulseaudio", null), ["-t", "pulseaudio", "default"]);
  assert.deepEqual(buildRecordArgs("coreaudio", "USB Microphone"), [
    "-t",
    "coreaudio",
    "USB Microphone",
  ]);
  assert.deepEqual(buildRecordArgs("coreaudio", null), ["-d"]);
  assert.deepEqual(buildRecordArgs("default", null), ["-d"]);
});

test("builds audio hints per backend and server state", () => {
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: true }),
    /wsl --shutdown/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: false }),
    /PipeWire\/PulseAudio/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: true, isWsl: false }),
    /input source configuration/,
  );
  assert.equal(
    buildAudioHint({ backend: "coreaudio", serverOk: false, isWsl: false }),
    "No input devices found",
  );
});

test("detects WSL via environment variables", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;
  try {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    assert.equal(isWSL(), false);
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    assert.equal(isWSL(), true);
  } finally {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  }
});

test("builds whisper-cli args with language", () => {
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "zh"), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "zh",
    "-np",
    "-nt",
  ]);
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", null), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "auto",
    "-np",
    "-nt",
  ]);
});
