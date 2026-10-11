// OpenCode v2 submit-only compatibility: adapter + setup entry tests.
//
// Surface fakes below are CONTRACT-F AKES (shaped from the v2
// `@opencode/plugin@2.0.26` + `@opencode/client@2.0.26` .d.ts in the research
// sandbox), not recordings of a live v2 host — see header comments marking
// each OBSERVED-v2 fact (verified in types) vs fake choice. No mic, audio,
// model downloads, or real host involved: `session.prompt` and
// `dialog.select` are faked, transcription/synthesis never run.

import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../index.js";
import { adaptV2Context, isV2Context } from "../lib/v2-compat.js";

// OBSERVED-v2: Context carries keymap.layer + ui.toast.show + storage;
// a v1 api carries none of those paths.
function makeV2(overrides = {}) {
  const handlers = new Map();
  const toasts = [];
  const layers = [];
  const prompts = [];
  const dialogCalls = [];
  const dialogResolutions = [];
  const storeState = { values: {} };
  const providers = overrides.providers || [];
  const messages = overrides.messages || [];
  const ctx = {
    options: { endpoint: "http://localhost:11434/v1", model: "fake-test-model" },
    // Fake choice: LocationRef shape is opaque to us; the adapter only reads
    // `.directory` with a cwd fallback.
    location: { directory: "/tmp" },
    app: { version: "2.0.26-test", channel: "test" },
    renderer: {},
    client: {
      session: {
        list: async () => ({ data: [] }),
        prompt: async (input) => {
          prompts.push(input);
          return { data: {} };
        },
      },
    },
    data: {
      on: (type, fn) => {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
        return () => {
          const arr = handlers.get(type) || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      session: { message: { list: () => messages } },
      location: { provider: { list: () => providers } },
    },
    // OBSERVED-v2: keymap.layer(factory) with KeymapCommand
    // {id,title,group,bind,palette,slash,run} + layer bindings.
    keymap: {
      layer: (factory) => void layers.push(factory()),
    },
    // OBSERVED-v2: storage.store(key, {initial}) -> [Store, update].
    storage: {
      store: () => {
        const update = async (mut) => void mut(storeState);
        return [{ ...storeState }, update];
      },
    },
    ui: {
      // OBSERVED-v2: toast.show({title?,message,variant?,duration?,sessionID?}).
      toast: { show: (o) => void toasts.push(o) },
      // OBSERVED-v2: promise dialog.select(options) -> value|undefined.
      dialog: {
        select: async (o) => {
          dialogCalls.push(o);
          return dialogResolutions.length > 0 ? dialogResolutions.shift() : undefined;
        },
        clear: () => {},
      },
      // OBSERVED-v2: router.current() -> {type:'session',sessionID}.
      router: { current: () => ({ type: "session", sessionID: "ses_V2" }) },
    },
  };
  const count = () => {
    let n = 0;
    for (const arr of handlers.values()) n += arr.length;
    return n;
  };
  const tick = () => new Promise((r) => setImmediate(r));
  // OBSERVED-v2: ui.slot(claim) -> unclaim; layer() must run inside a
  // component render (ambient Keymap provider), so the adapter claims the
  // always-mounted "app" slot with a null render and registers from there.
  const slotClaims = [];
  ctx.ui.slot = (claim) => {
    slotClaims.push(claim);
    return () => {
      const i = slotClaims.indexOf(claim);
      if (i >= 0) slotClaims.splice(i, 1);
    };
  };
  const renderSlots = () => {
    for (const claim of slotClaims) claim.render();
  };
  return {
    ctx,
    handlers,
    toasts,
    layers,
    prompts,
    dialogCalls,
    dialogResolutions,
    storeState,
    count,
    tick,
    slotClaims,
    renderSlots,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("isV2Context detects v2 by capability, not version", () => {
  const { ctx } = makeV2();
  assert.equal(isV2Context(ctx), true);
  assert.equal(isV2Context({ command: { register: () => {} } }), false);
  assert.equal(isV2Context(null), false);
  assert.equal(isV2Context({}), false);
});

test("v2 setup registers every header-block command by name", async () => {
  const fake = makeV2();
  const cleanup = await plugin.setup(fake.ctx);
  assert.equal(typeof cleanup, "function");
  // The keymap layer registers from the app-slot render, not during setup.
  assert.equal(fake.layers.length, 0);
  assert.equal(fake.slotClaims.length, 1);
  assert.equal(fake.slotClaims[0].append, "app");
  fake.renderSlots();
  fake.renderSlots(); // reactive re-renders must not duplicate the layer
  assert.equal(fake.layers.length, 1);
  const commands = fake.layers.flatMap((l) => l.commands || []);
  const slashNames = commands.map((c) => c?.slash?.name).filter(Boolean);
  // The 17 header-block commands from index.js docs must all be reachable.
  for (const name of [
    "stt-record",
    "stt-submit",
    "stt-stop",
    "stt-model",
    "stt-language",
    "stt-mic",
    "tts-speak",
    "tts-mode",
    "tts-stop",
    "tts-voice",
    "voice-conversation",
    "voice-conversation-stop",
    "voice-notes-start",
    "voice-notes-stop",
    "voice-notes-cancel",
    "voice-notes-status",
    "voice-cancel",
  ]) {
    assert.ok(slashNames.includes(name), `missing slash command /${name}`);
  }
  // Plus the voice-model pair, also palette + slash reachable.
  assert.ok(slashNames.includes("voice-model"));
  assert.ok(slashNames.includes("voice-model-clear"));
  // v1→v2 field mapping on every command: value→id, category→group,
  // keybind→bind, onSelect→run, palette:true.
  for (const c of commands) {
    assert.ok(c?.id, `command missing id: ${c?.title}`);
    assert.equal(c?.palette, true);
    assert.equal(typeof c?.run, "function");
    assert.ok(c?.bind === undefined || typeof c?.bind === "string", `bad bind for ${c?.id}`);
  }
  // Keybinds parse: ids unique, layer is global-mode (reachable in every
  // input mode, like v1 commands), bound ids join bindings (binds only
  // become active when listed).
  const ids = commands.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate command ids");
  for (const layer of fake.layers) {
    assert.equal(layer.mode, "global");
    for (const id of layer.bindings || []) {
      assert.ok(ids.includes(id), `binding references unknown command ${id}`);
    }
    assert.ok(layer.bindings.includes("stt.record"), "bound id must join bindings");
    assert.ok(!layer.bindings.includes("stt.model"), "unbound id must not join bindings");
  }
  // v1 `<leader>X` binds translate to v2 `ctrl+x X` (v2 has no leader
  // token); falsy binds are omitted, never sent as bind:false.
  const byId = Object.fromEntries(commands.map((c) => [c.id, c]));
  assert.equal(byId["stt.record"]?.bind, "ctrl+x [");
  assert.equal(byId["voice.cancel"]?.bind, "ctrl+x .");
  assert.ok(!("bind" in (byId["stt.model"] || {})), "unbound command must omit bind");
  // First-run submit-only notice: toast (up front, not buried) + log path.
  assert.ok(
    fake.toasts.some((t) => /submit-only/i.test(t?.message || "")),
    "expected submit-only first-run toast",
  );
  await cleanup();
});

test("v2 STT smoke: append becomes session.prompt submit (marker, quiet shim)", async () => {
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  // Both v1 call shapes used by stt.js must submit and report the marker.
  const r1 = await adapted.api.client.tui.appendPrompt({ body: { text: "hello v2" } });
  const r2 = await adapted.api.client.tui.appendPrompt({ text: "second shape" });
  assert.equal(r1?.submitted, true);
  assert.equal(r2?.submitted, true);
  assert.equal(fake.prompts.length, 2);
  assert.deepEqual(fake.prompts[0], { sessionID: "ses_V2", text: "hello v2" });
  assert.deepEqual(fake.prompts[1], { sessionID: "ses_V2", text: "second shape" });
  // The shim itself stays quiet: the caller's turn toast reports the submit
  // (one toast per turn, keyed off the marker above).
  assert.equal(fake.toasts.length, 0);
  // Renderer is null by construction so the focused-input insert path is
  // skipped and nothing can fake an edit step.
  assert.equal(adapted.api.renderer, null);
});

test("v2 STT turn toast: real stt.js submit path prompts + toasts submit", async () => {
  // End-to-end minus mic: drive the real registerSTT controller over the
  // adapted api and prove session.prompt is called and the user-facing toast
  // says submitted (not "added to prompt"). The /stt-record append path
  // shares the same shim marker; its toast branch ("submitted as-is
  // (submit-only mode)") is selected off that marker in appendTurnText.
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  const { registerSTT } = await import("../lib/stt.js");
  const complete = async () => ({ text: null, error: "unavailable" });
  const stt = registerSTT(adapted.api, adapted.api.kv, complete, {}, {}, { log: () => {} });
  const result = await stt.controller.submitTurnText("hello turn");
  assert.equal(result?.text, "hello turn");
  assert.equal(fake.prompts.length, 1);
  assert.deepEqual(fake.prompts[0], { sessionID: "ses_V2", text: "hello turn" });
  assert.ok(
    fake.toasts.some((t) => /Transcription submitted/.test(t?.message || "")),
    "expected submitted toast from real stt.js turn path",
  );
  assert.ok(
    fake.toasts.every((t) => !/added to prompt/i.test(t?.message || "")),
    "must never claim an edit-step append on v2",
  );
});

test("v2 STT submit with no active session warns loudly and throws", async () => {
  const fake = makeV2();
  fake.ctx.ui.router.current = () => ({ type: "home" });
  const adapted = adaptV2Context(fake.ctx);
  await assert.rejects(
    () => adapted.api.client.tui.appendPrompt({ text: "lost" }),
    /No active session/,
  );
  assert.equal(fake.prompts.length, 0);
  assert.ok(
    fake.toasts.some(
      (t) => t?.variant === "warning" && /no active session/i.test(t?.message || ""),
    ),
    "expected loud warning toast",
  );
});

test("v2 dialog facade: option onSelect runs, kv persists, toast shows", async () => {
  const fake = makeV2();
  await plugin.setup(fake.ctx);
  fake.renderSlots();
  const commands = fake.layers.flatMap((l) => l.commands || []);
  const voice = commands.find((c) => c.id === "tts.voice");
  assert.ok(voice, "tts.voice command registered");
  fake.dialogResolutions.push("bryce");
  voice.run();
  await tick();
  await tick();
  assert.equal(fake.dialogCalls.length, 1, "expected one dialog.select call");
  assert.equal(fake.dialogCalls[0].title, "Select voice (auto vi/en)");
  // kv.set persisted through the storage facade (fire-and-forget flush).
  await tick();
  assert.equal(fake.storeState.values["tts.voice"], "bryce");
  assert.ok(
    fake.toasts.some((t) => /Voice:/.test(t?.message || "")),
    "expected voice confirmation toast",
  );
});

test("v2 event remap: v1 names subscribe to v2 types with properties envelope", async () => {
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  const seen = [];
  adapted.api.event.on("message.part.delta", (event) => void seen.push(event));
  assert.ok(fake.handlers.has("session.text.delta"), "expected remap to session.text.delta");
  assert.ok(
    adapted.warnMessages.some((m) => /remapped/.test(m)),
    "expected loud remap warning",
  );
  // OBSERVED-v2 envelope {type, data}; v1 handlers read event.properties.
  const [handler] = fake.handlers.get("session.text.delta");
  handler({
    type: "session.text.delta",
    data: { sessionID: "ses_V2", assistantMessageID: "m1", delta: "hi" },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].properties.sessionID, "ses_V2");
  assert.equal(seen[0].properties.messageID, "m1");
  assert.equal(seen[0].properties.delta, "hi");
  // question.asked has no v2 equivalent: best-effort form.created + warning.
  adapted.api.event.on("question.asked", () => {});
  assert.ok(fake.handlers.has("form.created"));
  assert.ok(adapted.warnMessages.some((m) => /no v2 equivalent/.test(m)));
});

test("v2 route/state/kv shims keep v1 call shapes working", async () => {
  const fake = makeV2({ providers: [{ id: "p1", name: "P1", models: {}, env: [] }] });
  const adapted = adaptV2Context(fake.ctx);
  assert.deepEqual(adapted.api.route.current, { name: "session", params: { sessionID: "ses_V2" } });
  assert.deepEqual(adapted.api.state.session.messages("ses_V2"), []);
  assert.equal(adapted.api.state.part("m1").length, 0);
  assert.ok(adapted.api.state.path.directory.length > 0);
  assert.equal(adapted.api.state.provider.length, 1);
  assert.equal(adapted.api.kv.get("missing.key", "fb"), "fb");
  adapted.api.kv.set("voice.providerID", "p1");
  assert.equal(adapted.api.kv.get("voice.providerID"), "p1");
});

test("v2 TTS smoke: speak command degrades honestly with no content", async () => {
  const fake = makeV2();
  await plugin.setup(fake.ctx);
  fake.renderSlots();
  const commands = fake.layers.flatMap((l) => l.commands || []);
  const speak = commands.find((c) => c.id === "tts.speak-last");
  assert.ok(speak, "tts.speak-last command registered");
  speak.run();
  await tick();
  await tick();
  // Fake sidecar/outcome: no messages exist, so no synthesis is attempted
  // and the user gets an honest warning instead of silence.
  assert.ok(
    fake.toasts.some((t) => /No assistant response to speak/.test(t?.message || "")),
    "expected honest no-content toast",
  );
});

test("v2 dispose clean: setup cleanup removes all handlers", async () => {
  const fake = makeV2();
  const cleanup = await plugin.setup(fake.ctx);
  const initCount = fake.count();
  assert.ok(initCount > 0, "expected v2 setup to subscribe to events");
  assert.equal(fake.slotClaims.length, 1, "expected one app-slot claim");
  await cleanup();
  assert.equal(fake.count(), 0, "v2 handlers survive dispose");
  assert.equal(fake.slotClaims.length, 0, "v2 slot claim survives dispose");
  // Re-registration settles at the same count (no leak across reloads).
  const second = makeV2();
  const cleanup2 = await plugin.setup(second.ctx);
  assert.equal(second.count(), initCount, "re-registration changed handler count");
  await cleanup2();
  assert.equal(second.count(), 0);
});
