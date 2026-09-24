import assert from "node:assert/strict";
import test from "node:test";

import { buildWhisperServerArgs } from "../lib/whisper-server.js";

test("builds whisper-server args with model, language, host, port", () => {
  assert.deepEqual(
    buildWhisperServerArgs({
      modelPath: "/models/ggml.bin",
      language: "en",
      host: "127.0.0.1",
      port: 8090,
    }),
    ["-m", "/models/ggml.bin", "-l", "en", "--host", "127.0.0.1", "--port", "8090"],
  );
});

test("defaults language to auto and includes threads when given", () => {
  assert.deepEqual(
    buildWhisperServerArgs({
      modelPath: "/models/ggml.bin",
      host: "127.0.0.1",
      port: 8090,
      threads: 4,
    }),
    ["-m", "/models/ggml.bin", "-l", "auto", "--host", "127.0.0.1", "--port", "8090", "-t", "4"],
  );
});
