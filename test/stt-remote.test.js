import test from "node:test";
import assert from "node:assert/strict";
import { createCommands } from "../lib/stt/commands.js";

test("normal batch finish passes a live submit reader, not the boot snapshot", () => {
  const { ctx, store } = fakeCtx({ kvInit: { "stt.autoSubmit": true } });
  let submitPolicy;
  Object.assign(ctx, {
    currentSttMode: () => "batch",
    getStreamingActive: () => false,
    processing: () => false,
    recording: () => true,
    clearRecordingToast() {},
    autoSubmit: true,
    autoSubmitNow: () => store.get("stt.autoSubmit") === true,
    doTranscribePipeline(...args) {
      submitPolicy = args[6];
    },
  });
  createCommands(ctx)
    .find((command) => command.value === "stt.record")
    .onSelect();
  assert.equal(typeof submitPolicy, "function");
  store.set("stt.autoSubmit", false);
  assert.equal(submitPolicy(), false, "off during ASR wins over initial true");
  store.set("stt.autoSubmit", true);
  assert.equal(submitPolicy(), true, "on during ASR wins over initial false");
});

function fakeCtx({ sshOk = true, kvInit = {} } = {}) {
  const store = new Map(Object.entries(kvInit));
  const toasts = [];
  return {
    ctx: {
      sttApiEndpoint: null,
      autoSubmit: false,
      kb: () => null,
      sttLog: () => {},
      conversationActive: () => false,
      liveNotesActive: () => false,
      getRemoteConfig: () => ({ host: "h", port: 22, key: "k", rate: 16000 }),
      execSync: () => {
        if (!sshOk) throw new Error("nope");
        return "OK\n";
      },
      toast: (m) => toasts.push(typeof m === "string" ? m : (m?.message ?? String(m))),
      kv: {
        get: (k, fb) => (store.has(k) ? store.get(k) : fb),
        set: (k, v) => void store.set(k, v),
      },
      api: { ui: { dialog: {}, DialogSelect: () => null } },
    },
    store,
    toasts,
  };
}

test("remote setup flips mic + output + batch mode in one click", () => {
  const { ctx, store, toasts } = fakeCtx({ kvInit: { "stt.mode": "streaming" } });
  const cmd = createCommands(ctx).find((c) => c.value === "stt.remote-setup");
  assert.ok(cmd, "command exists");
  cmd.onSelect();
  assert.equal(store.get("stt.mic"), "remote");
  assert.equal(store.get("tts.output"), "remote");
  assert.equal(store.get("stt.mode"), "batch");
  assert.equal(store.get("stt.prevMode"), "streaming");
  assert.ok(toasts.some((t) => /batch mode/.test(t)));
});

test("remote setup failure saves config but flips nothing", () => {
  const { ctx, store } = fakeCtx({ sshOk: false, kvInit: { "stt.mic": "" } });
  createCommands(ctx)
    .find((c) => c.value === "stt.remote-setup")
    .onSelect();
  assert.equal(store.get("stt.remoteHost"), "h");
  assert.equal(store.get("stt.mic"), "");
  assert.equal(store.has("stt.mode") ? store.get("stt.mode") : undefined, undefined);
});

test("remote forget restores local mic + speaker + prior mode", () => {
  const { ctx, store, toasts } = fakeCtx({
    kvInit: {
      "stt.mic": "remote",
      "tts.output": "remote",
      "stt.mode": "batch",
      "stt.prevMode": "streaming",
    },
  });
  createCommands(ctx)
    .find((c) => c.value === "stt.remote-forget")
    .onSelect();
  assert.equal(store.get("stt.mic"), "");
  assert.equal(store.get("tts.output"), "local");
  assert.equal(store.get("stt.mode"), "streaming");
  assert.ok(toasts.some((t) => /local/i.test(t)));
});

test("remote-host presets switch machine with one click", () => {
  const { ctx, store, toasts } = fakeCtx({});
  ctx.api.ui.DialogSelect = (props) => props;
  const cmd = createCommands(ctx).find((c) => c.value === "stt.remote-host");
  assert.ok(cmd, "stt.remote-host command exists");
  let shown = null;
  ctx.api.ui.dialog.replace = (node) => {
    shown = node;
  };
  ctx.api.ui.dialog.clear = () => {};
  ctx.api.ui.DialogSelect = (props) => props;
  cmd.onSelect();
  assert.ok(shown, "dialog opens");
  const dialog = typeof shown === "function" ? shown() : shown;
  assert.equal(dialog.options.length, 3);
  const laptop = dialog.options.find((o) => o.value === "remote:laptop");
  laptop.onSelect();
  assert.equal(store.get("stt.remoteHost"), "bojack@100.67.7.5");
  assert.equal(store.get("stt.remotePort"), 22);
  assert.equal(store.get("stt.mic"), "remote");
  assert.equal(store.get("tts.output"), "remote");
  assert.equal(store.get("stt.mode"), "batch");
  assert.ok(toasts.some((t) => /remote/i.test(t)));
});

test("remote-usb forwards via argv adb and keeps verified login", () => {
  const { ctx, store, toasts } = fakeCtx({});
  const seen = [];
  ctx.spawnSync = (bin, args, opts) => {
    seen.push([bin, args, opts?.timeout]);
    if (args[0] === "devices") {
      return { status: 0, stdout: "List of devices attached\nQV710TEC3E\tdevice\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  createCommands(ctx)
    .find((c) => c.value === "stt.remote-usb")
    .onSelect();
  assert.equal(store.get("stt.remoteHost"), "u0_a368@127.0.0.1");
  assert.equal(store.get("stt.remotePort"), 8022);
  assert.equal(store.get("stt.mic"), "remote");
  assert.ok(seen.length > 0, "adb was invoked");
  assert.ok(
    seen.every(([b, a]) => b === "adb" && Array.isArray(a)),
    "argv only, no shell string",
  );
  assert.ok(
    seen.some(([, a]) => a.includes("forward")),
    "forward ran",
  );
  assert.ok(toasts.some((t) => /remote voice ready/i.test(t)));
});

test("remote-usb aborts cleanly when adb is missing", () => {
  const { ctx, store, toasts } = fakeCtx({});
  ctx.spawnSync = () => {
    const err = new Error("spawnSync adb ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  createCommands(ctx)
    .find((c) => c.value === "stt.remote-usb")
    .onSelect();
  assert.equal(store.get("stt.mic"), undefined);
  assert.ok(toasts.some((t) => /adb not found/i.test(t)));
});
