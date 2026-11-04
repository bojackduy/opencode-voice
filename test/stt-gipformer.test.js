import test from "node:test";
import assert from "node:assert/strict";
import {
  GIPFORMER_HF_REPO,
  GIPFORMER_LICENSE,
  getSttEngine,
  getGipformerConfig,
  buildGipformerArgs,
  parseGipformerStdout,
  transcribeFileGipformer,
} from "../lib/stt/gipformer.js";

function mapKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    get: (k, fb) => (store.has(k) ? store.get(k) : fb),
    set: (k, v) => void store.set(k, v),
  };
}

test("engine defaults to whisper (no behavior change)", () => {
  assert.equal(getSttEngine(mapKv({}), {}), "whisper");
  assert.equal(getSttEngine(mapKv({}), null), "whisper");
});

test("engine kv wins over options; unknown falls back to whisper", () => {
  assert.equal(getSttEngine(mapKv({ "stt.engine": "gipformer" }), {}), "gipformer");
  assert.equal(
    getSttEngine(mapKv({ "stt.engine": "gipformer" }), { sttEngine: "whisper" }),
    "gipformer",
  );
  assert.equal(getSttEngine(mapKv({}), { sttEngine: "gipformer" }), "gipformer");
  assert.equal(getSttEngine(mapKv({ "stt.engine": "bogus" }), {}), "whisper");
});

test("gipformer config defaults: v1.5, int8, auto-download", () => {
  const cfg = getGipformerConfig(mapKv({}), {});
  assert.equal(cfg.version, "1.5");
  assert.equal(cfg.quantize, "int8");
  assert.equal(cfg.modelDir, null);
  assert.equal(cfg.repo, GIPFORMER_HF_REPO);
  assert.equal(GIPFORMER_LICENSE, "MIT");
});

test("gipformer config kv overrides win over options", () => {
  const cfg = getGipformerConfig(
    mapKv({ "stt.gipformer.version": "1", "stt.gipformer.quantize": "fp32" }),
    { sttGipformerVersion: "1.5", sttGipformerQuantize: "int8" },
  );
  assert.equal(cfg.version, "1");
  assert.equal(cfg.quantize, "fp32");
});

test("argv passes audio + version + quantize + model-dir", () => {
  const args = buildGipformerArgs("/tmp/x.wav", {
    version: "1.5",
    quantize: "int8",
    modelDir: "/models/gip",
    script: "infer_onnx.py",
  });
  assert.deepEqual(args, [
    "infer_onnx.py",
    "--audio",
    "/tmp/x.wav",
    "--version",
    "1.5",
    "--quantize",
    "int8",
    "--model-dir",
    "/models/gip",
  ]);
});

test("argv omits quantize/model-dir when unset", () => {
  const args = buildGipformerArgs("/tmp/x.wav", {
    version: "1",
    quantize: null,
    modelDir: null,
    script: "infer_onnx.py",
  });
  assert.deepEqual(args, ["infer_onnx.py", "--audio", "/tmp/x.wav", "--version", "1"]);
});

test("stdout parsing trims transcript", () => {
  assert.equal(parseGipformerStdout("  xin chào\n"), "xin chào");
  assert.equal(parseGipformerStdout("\n"), "");
});

test("stdout parsing extracts only the Text line from the upstream banner", () => {
  const stdout = [
    "Downloading int8 model from g-group-ai-lab/gipformer1.5-68M-rnnt...",
    "Model downloaded successfully.",
    "",
    "  File: /tmp/opencode-stt.wav",
    "  Text: XIN CHÀO BUỔI TỐI",
    "  Time: 0.10s | Audio: 10.24s | RTF: 0.010",
    "",
  ].join("\n");
  assert.equal(parseGipformerStdout(stdout), "XIN CHÀO BUỔI TỐI");
});

test("stdout parsing uses the last Text line when several audios ran", () => {
  const stdout = [
    "  File: /tmp/a.wav",
    "  Text: first",
    "  Time: 0.1s | Audio: 1.0s | RTF: 0.100",
    "  File: /tmp/b.wav",
    "  Text: second",
    "  Time: 0.1s | Audio: 1.0s | RTF: 0.100",
  ].join("\n");
  assert.equal(parseGipformerStdout(stdout), "second");
});

test("missing wav file errors without spawning", async () => {
  let spawned = false;
  const r = await transcribeFileGipformer("/tmp/opencode-voice-nope-missing.wav", {}, null, {
    spawn: () => ((spawned = true), null),
  });
  assert.ok(r.error);
  assert.equal(spawned, false);
});

test("spawn failure maps to readable error", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-spawn-"));
  const script = path.join(dir, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  const r = await transcribeFileGipformer(
    wav,
    { version: "1.5", quantize: null, modelDir: null, python: "python3", script },
    null,
    {
      spawn: () => {
        throw new Error("spawn python3 ENOENT");
      },
    },
  );
  assert.match(r.error, /Gipformer runner failed/);
});

test("missing gipformer script fails fast without spawning", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gip-noscript-")), "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  let spawned = false;
  const r = await transcribeFileGipformer(
    wav,
    { version: "1.5", quantize: null, script: "/tmp/definitely-not-here-infer_onnx.py" },
    null,
    { spawn: () => ((spawned = true), null) },
  );
  assert.equal(spawned, false);
  assert.match(r.error, /script not found/);
  assert.match(r.error, /stt\.gipformer\.script/);
});

test("kv script override wins over options", () => {
  const cfg = getGipformerConfig(
    mapKv({ "stt.gipformer.script": "/x/infer_onnx.py" }),
    { sttGipformerScript: "/y/infer_onnx.py" },
  );
  assert.equal(cfg.script, "/x/infer_onnx.py");
});

test("bare script resolves ~/Code/gipformer checkout", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-home-"));
  const checkout = path.join(dir, "Code", "gipformer");
  fs.mkdirSync(checkout, { recursive: true });
  const script = path.join(checkout, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  let seen = null;
  const fakeChild = {
    pid: 1,
    stdout: {
      on: (ev, fn) => {
        if (ev === "data") fn("xin chào");
      },
    },
    stderr: { on: () => {} },
    on: (ev, fn) => {
      if (ev === "exit") setImmediate(() => fn(0));
    },
    kill: () => {},
  };
  const origHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const r = await transcribeFileGipformer(wav, { script: "infer_onnx.py" }, null, {
      spawn: (bin, args, opts) => {
        seen = { bin, args, opts };
        return fakeChild;
      },
    });
    assert.equal(r.text, "xin chào");
    assert.equal(seen.args[0], script);
    assert.equal(seen.opts.cwd, checkout);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

test("spawn runs in the script directory with the resolved path", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-cwd-"));
  const script = path.join(dir, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  let seen = null;
  const fakeChild = {
    pid: 1,
    stdout: {
      on: (ev, fn) => {
        if (ev === "data") fn("xin chào");
      },
    },
    stderr: { on: () => {} },
    on: (ev, fn) => {
      if (ev === "exit") setImmediate(() => fn(0));
    },
    kill: () => {},
  };
  const r = await transcribeFileGipformer(wav, { script }, null, {
    spawn: (bin, args, opts) => {
      seen = { bin, args, opts };
      return fakeChild;
    },
  });
  assert.equal(r.text, "xin chào");
  assert.equal(seen.args[0], script);
  assert.equal(seen.opts.cwd, dir);
});

test("chunked router accepts a gipformer-style transcribeFn (drop-in contract)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { wrapPcmAsWav } = await import("../lib/stt/audio-chunker.js");
  const { transcribeMaybeChunked } = await import("../lib/stt.js");
  const pcm = Buffer.alloc(16000 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(3000, i);
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gip-chunk-")), "s.wav");
  fs.writeFileSync(wav, wrapPcmAsWav(pcm, { sampleRate: 16000 }));
  let calls = 0;
  // Gipformer branch binds (wav, cfg, log): chunker passes (wav, model, lang,
  // logger) positionally, extras ignored - only the wav matters.
  const r = await transcribeMaybeChunked(wav, { version: "1.5" }, null, null, async (w) => {
    calls += 1;
    assert.equal(w, wav);
    return { text: "xin chào" };
  });
  assert.equal(calls, 1);
  assert.equal(r.text, "xin chào");
});

test("prefers the checkout .venv python over system python3", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-venv-"));
  const script = path.join(dir, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
  const venvPython = path.join(dir, ".venv", "bin", "python");
  fs.writeFileSync(venvPython, "#!/bin/sh\n");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  let bin = null;
  const fakeChild = {
    pid: 1,
    stdout: {
      on: (ev, fn) => {
        if (ev === "data") fn("xin chào");
      },
    },
    stderr: { on: () => {} },
    on: (ev, fn) => {
      if (ev === "exit") setImmediate(() => fn(0));
    },
    kill: () => {},
  };
  const r = await transcribeFileGipformer(wav, { script, python: "python3" }, null, {
    spawn: (b) => {
      bin = b;
      return fakeChild;
    },
  });
  assert.equal(r.text, "xin chào");
  assert.equal(bin, venvPython);
});

test("explicit kv python still wins over the venv", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-venv2-"));
  const script = path.join(dir, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  let bin = null;
  const fakeChild = {
    pid: 1,
    stdout: {
      on: (ev, fn) => {
        if (ev === "data") fn("ok");
      },
    },
    stderr: { on: () => {} },
    on: (ev, fn) => {
      if (ev === "exit") setImmediate(() => fn(0));
    },
    kill: () => {},
  };
  const r = await transcribeFileGipformer(wav, { script, python: "/custom/python" }, null, {
    spawn: (b) => {
      bin = b;
      return fakeChild;
    },
  });
  assert.equal(r.text, "ok");
  assert.equal(bin, "/custom/python");
});

test("missing module error names the package and the venv", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gip-mod-"));
  const script = path.join(dir, "infer_onnx.py");
  fs.writeFileSync(script, "# fake");
  const wav = path.join(dir, "t.wav");
  fs.writeFileSync(wav, Buffer.concat([Buffer.alloc(44), Buffer.alloc(100)]));
  const fakeChild = {
    pid: 1,
    stdout: { on: () => {} },
    stderr: {
      on: (ev, fn) => {
        if (ev === "data") fn("ModuleNotFoundError: No module named 'soundfile'\n");
      },
    },
    on: (ev, fn) => {
      if (ev === "exit") setImmediate(() => fn(1));
    },
    kill: () => {},
  };
  const r = await transcribeFileGipformer(wav, { script, python: "python3" }, null, {
    spawn: () => fakeChild,
  });
  assert.match(r.error, /missing "soundfile"/);
  assert.match(r.error, /uv sync/);
});
