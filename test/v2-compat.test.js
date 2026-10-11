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
// ACTUAL-v2 shapes (from `@opencode/client@2.0.26` generated types):
// SessionMessageInfo is a UNION with `type` (never `role`); assistant text in
// `content[]`, user text in `text`. `session.message.get` (not a callable
// `session.message`) fetches one message. Storage/dialog/keymap remain
// behavior fakes.
const V2_USER_MSG = {
  id: "m-user-1",
  time: { created: 1700000000000 },
  type: "user",
  text: "hello voice",
};
const V2_ASSISTANT_MSG = {
  id: "m-asst-1",
  time: { created: 1700000001000, completed: 1700000002000 },
  type: "assistant",
  agent: "default",
  model: { id: "m", providerID: "p" },
  content: [
    { type: "text", text: "Hello there. How can I help?" },
    { type: "reasoning", text: "internal thought" },
  ],
  finish: "stop",
};
function makeV2(overrides = {}) {
  const handlers = new Map();
  const toasts = [];
  const layers = [];
  const prompts = [];
  const creates = [];
  const navigations = [];
  const alerts = [];
  const dialogCalls = [];
  const dialogResolutions = [];
  const storeState = { values: {} };
  const providers = overrides.providers || [];
  // Live array ref, like the host's reactive view: tests may push messages.
  const v2messages = overrides.messages || [V2_USER_MSG, V2_ASSISTANT_MSG];
  const sessions = overrides.sessions || [{ id: "ses_V2", title: "V2 session" }];
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
        create: async (input) => {
          creates.push(input);
          return { id: "ses_NEW" };
        },
        prompt: async (input) => {
          prompts.push(input);
          return { data: {} };
        },
        // ACTUAL-v2: message is a {get} namespace, not a callable.
        message: {
          get: async ({ messageID }) => {
            const found = v2messages.find((m) => m?.id === messageID);
            if (!found) throw new Error(`message not found: ${messageID}`);
            return found;
          },
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
      session: {
        list: () => sessions,
        message: {
          // ACTUAL-v2: sync live view returning the union array.
          list: () => v2messages,
          get: (sessionID, messageID) => v2messages.find((m) => m?.id === messageID),
        },
      },
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
        alert: async (input) => {
          alerts.push(input);
        },
        select: async (o) => {
          dialogCalls.push(o);
          return dialogResolutions.length > 0 ? dialogResolutions.shift() : undefined;
        },
        clear: () => {},
      },
      // OBSERVED-v2: router.current() -> {type:'session',sessionID}.
      router: {
        current: () => ({ type: "session", sessionID: "ses_V2" }),
        navigate: (route) => {
          navigations.push(route);
          ctx.ui.router.current = () => route;
        },
      },
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
    creates,
    navigations,
    alerts,
    dialogCalls,
    dialogResolutions,
    storeState,
    v2messages,
    count,
    tick,
    slotClaims,
    renderSlots,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("v2 plugin keybind overrides retain custom leader syntax and disable none", async () => {
  const fake = makeV2();
  fake.ctx.options.keybinds = {
    "stt.record": "ctrl+alt+r",
    "tts.speak-last": "none",
    "voice.conversation": "<leader>j",
    "voice.cancel": false,
  };
  const cleanup = await plugin.setup(fake.ctx);
  fake.renderSlots();
  const layer = fake.layers[0];
  const byId = Object.fromEntries(layer.commands.map((c) => [c.id, c]));
  assert.equal(byId["stt.record"].bind, "ctrl+alt+r");
  assert.equal(byId["voice.conversation"].bind, "<leader>j");
  for (const id of ["tts.speak-last", "voice.cancel"]) {
    assert.equal(byId[id].bind, undefined);
    assert.ok(!layer.bindings.includes(id));
  }
  cleanup();
});

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
  // Binds pass through untouched: the v2 keymap resolves the `<leader>`
  // token itself (leader defaults to ctrl+x). Falsy binds are omitted, never
  // sent as bind:false.
  const byId = Object.fromEntries(commands.map((c) => [c.id, c]));
  assert.equal(byId["stt.record"]?.bind, "<leader>[");
  assert.equal(byId["voice.cancel"]?.bind, "<leader>.");
  assert.equal(byId["tts.speak-last"]?.bind, "<leader>]");
  assert.equal(byId["voice.conversation"]?.bind, "<leader>v");
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

test("v2 home creates and navigates only for final text, submits once with selected model", async () => {
  const fake = makeV2();
  fake.ctx.ui.router.current = () => ({ type: "home" });
  fake.ctx.ui.model = { current: () => ({ providerID: "p", modelID: "chosen", variant: "fast" }) };
  const adapted = adaptV2Context(fake.ctx);
  assert.equal(fake.creates.length, 0);
  const send = () => adapted.api.client.tui.appendPrompt({ text: "captured home turn" });
  await Promise.all([send(), send()]);
  const model = { providerID: "p", id: "chosen", variant: "fast" };
  assert.deepEqual(fake.creates, [{ location: fake.ctx.location, model }]);
  assert.deepEqual(fake.navigations, [{ type: "session", sessionID: "ses_NEW" }]);
  assert.deepEqual(fake.prompts, [{ sessionID: "ses_NEW", text: "captured home turn" }]);
  assert.equal(adapted.api.route.current.params.sessionID, "ses_NEW");
  await adapted.api.client.tui.appendPrompt({ text: "second turn" });
  assert.equal(fake.creates.length, 1);
  assert.equal(fake.prompts.length, 2);
  assert.equal(fake.prompts[1].sessionID, "ses_NEW");
});

test("v2 create failure retains complete transcript visibly and allows retry", async () => {
  const fake = makeV2();
  fake.ctx.ui.router.current = () => ({ type: "home" });
  const create = fake.ctx.client.session.create;
  fake.ctx.client.session.create = async () => {
    throw new Error("create unavailable");
  };
  const adapted = adaptV2Context(fake.ctx);
  const text = "Retained full transcript. ".repeat(30);
  await assert.rejects(() => adapted.api.client.tui.appendPrompt({ text }), /create unavailable/);
  assert.deepEqual(fake.alerts, [{ title: "Voice transcript — not submitted", message: text }]);
  assert.equal(fake.prompts.length, 0);
  assert.equal(fake.navigations.length, 0);
  fake.ctx.client.session.create = create;
  await adapted.api.client.tui.appendPrompt({ text });
  assert.equal(fake.prompts.length, 1);
});

test("v2 home submission cancellation and disposal fence a pending create", async () => {
  for (const dispose of [false, true]) {
    const fake = makeV2();
    fake.ctx.ui.router.current = () => ({ type: "home" });
    let resolveCreate;
    fake.ctx.client.session.create = () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      });
    const adapted = adaptV2Context(fake.ctx);
    let current = true;
    const sent = adapted.api.client.tui.appendPrompt({
      text: "must not send",
      isCurrent: () => current,
    });
    if (dispose) adapted.cleanup();
    else current = false;
    resolveCreate({ id: "ses_CANCELLED" });
    await assert.rejects(() => sent, /cancelled/);
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.navigations.length, 0);
    assert.equal(fake.alerts.length, 0);
  }
});

test("v2 empty or already cancelled text never creates a session", async () => {
  const fake = makeV2();
  fake.ctx.ui.router.current = () => ({ type: "home" });
  const adapted = adaptV2Context(fake.ctx);
  await assert.rejects(() => adapted.api.client.tui.appendPrompt({ text: "" }), /No transcript/);
  await assert.rejects(
    () => adapted.api.client.tui.appendPrompt({ text: "stale", isCurrent: () => false }),
    /cancelled/,
  );
  assert.equal(fake.creates.length, 0);
  assert.equal(fake.prompts.length, 0);
});

test("real STT cancel invalidates v2 submit while home creation awaits", async () => {
  const fake = makeV2();
  fake.ctx.ui.router.current = () => ({ type: "home" });
  let resolveCreate;
  fake.ctx.client.session.create = () =>
    new Promise((resolve) => {
      resolveCreate = resolve;
    });
  const adapted = adaptV2Context(fake.ctx);
  const { registerSTT } = await import("../lib/stt.js");
  const stt = registerSTT(
    adapted.api,
    adapted.api.kv,
    async () => ({ text: null }),
    {},
    {},
    { log: () => {} },
  );
  const sent = stt.controller.submitTurnText("cancelled home turn");
  stt.controller.cancel();
  resolveCreate({ id: "ses_NOT_SUBMITTED" });
  assert.match((await sent).error, /cancelled/);
  assert.equal(fake.prompts.length, 0);
  assert.equal(fake.navigations.length, 0);
  adapted.cleanup();
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
    data: { sessionID: "ses_V2", assistantMessageID: "m1", ordinal: 0, delta: "hi" },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].properties.sessionID, "ses_V2");
  assert.equal(seen[0].properties.messageID, "m1");
  assert.equal(seen[0].properties.delta, "hi");
  // v2 `ordinal` synthesizes the v1 `partID` the stream guards read.
  assert.equal(seen[0].properties.partID, "m1:0");
  // question.asked has no v2 equivalent: best-effort form.created + warning.
  adapted.api.event.on("question.asked", () => {});
  assert.ok(fake.handlers.has("form.created"));
  assert.ok(adapted.warnMessages.some((m) => /no v2 equivalent/.test(m)));
});

test("v2 route/state/kv shims keep v1 call shapes working", async () => {
  const fake = makeV2({
    providers: [{ id: "p1", name: "P1", models: {}, env: [] }],
    messages: [],
    sessions: [{ id: "ses_V2", title: "V2 session" }],
  });
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
  const fake = makeV2({ messages: [] });
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

test("v2 messages normalize union type->role with v1-like parts", async () => {
  // The user-reported TTS/conversation failures: v2 messages carry `type`,
  // never `role`, with assistant text embedded in `content[]`.
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  const list = adapted.api.state.session.messages("ses_V2");
  assert.equal(list.length, 2);
  const [user, assistant] = list;
  assert.equal(user.role, "user");
  assert.equal(assistant.role, "assistant");
  assert.equal(user.parts.length, 1);
  assert.deepEqual(user.parts[0], { id: "m-user-1:0", type: "text", text: "hello voice" });
  // Text content becomes a text part; reasoning stays non-text typed.
  assert.equal(assistant.parts.length, 2);
  assert.equal(assistant.parts[0].type, "text");
  assert.equal(assistant.parts[0].text, "Hello there. How can I help?");
  assert.equal(assistant.parts[0].id, "m-asst-1:0");
  assert.equal(assistant.parts[1].type, "reasoning");
});

test("v2 client.session.message shim serves the exact v1 tts.js call shape", async () => {
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  // lib/tts.js getTurnAssistantText calls exactly this, then reads .parts.
  const full = await adapted.api.client.session
    .message({ sessionID: "ses_V2", messageID: "m-asst-1" }, { throwOnError: true })
    .then((r) => r.data);
  const text = (full?.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join("\n\n")
    .trim();
  assert.equal(text, "Hello there. How can I help?");
  await assert.rejects(
    () => adapted.api.client.session.message({ sessionID: "ses_V2", messageID: "nope" }),
    /not found/,
  );
});

test("v2 state.part resolves text parts through the current session", async () => {
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  // Read order matches lib/session.js: messages() first, then part().
  adapted.api.state.session.messages("ses_V2");
  const parts = adapted.api.state.part("m-asst-1");
  assert.ok(parts.some((p) => p?.type === "text" && /Hello there/.test(p?.text || "")));
  // Text changes are read live, even without another messages() call.
  fake.v2messages[1] = {
    ...V2_ASSISTANT_MSG,
    content: [{ type: "text", text: "Updated streamed reply." }],
  };
  assert.equal(adapted.api.state.part("m-asst-1")[0].text, "Updated streamed reply.");
  // An id resolves directly via the session view; unknown stays [].
  const fresh = makeV2();
  const freshApi = adaptV2Context(fresh.ctx).api;
  assert.ok(freshApi.state.part("m-user-1").some((p) => p?.text === "hello voice"));
  assert.deepEqual(freshApi.state.part("missing"), []);
});

test("v2 TTS turn extraction finds assistant text in actual union shapes", async () => {
  // Regression for "TTS says no assistant to speak despite an assistant
  // reply": exercise the shared lookup used by both manual and turn TTS.
  // No synthesis is requested, regardless of locally installed Piper/models.
  const fake = makeV2();
  const adapted = adaptV2Context(fake.ctx);
  const { getTurnAssistantText } = await import("../lib/tts.js");
  assert.deepEqual(await getTurnAssistantText(adapted.api.client, adapted.api), {
    lastMessageID: "m-asst-1",
    text: "Hello there. How can I help?",
  });
  fake.v2messages.push({
    ...V2_ASSISTANT_MSG,
    id: "m-asst-2",
    content: [{ type: "text", text: "Next step." }],
  });
  assert.deepEqual(await getTurnAssistantText(adapted.api.client, adapted.api), {
    lastMessageID: "m-asst-2",
    text: "Hello there. How can I help?\n\nNext step.",
  });
  // A new user message terminates the previous assistant turn.
  fake.v2messages.push({ ...V2_USER_MSG, id: "m-user-2" });
  assert.equal(await getTurnAssistantText(adapted.api.client, adapted.api), null);
  const empty = makeV2({ messages: [] });
  const emptyAdapted = adaptV2Context(empty.ctx);
  assert.equal(await getTurnAssistantText(emptyAdapted.api.client, emptyAdapted.api), null);
});

for (const fastReply of [false, true]) {
  test(`v2 conversation home turn speaks ${fastReply ? "before prompt resolves" : "after submit"}`, async () => {
    // Regression for "conversation mode does not work": REAL registerConversation
    // over the adapted api with stub STT/TTS (no mic, no audio, no model).
    const fake = makeV2({ messages: [] });
    fake.ctx.ui.router.current = () => ({ type: "home" });
    const adapted = adaptV2Context(fake.ctx);
    const { registerConversation } = await import("../lib/conversation.js");
    const { registerSTT } = await import("../lib/stt.js");
    const submitter = registerSTT(
      adapted.api,
      adapted.api.kv,
      async () => ({ text: null }),
      {},
      {},
      { log: () => {} },
    );
    const spoken = [];
    let turnSpoken = 0;
    let recording = false;
    const stt = {
      isRecording: () => recording,
      isProcessing: () => false,
      start: () => {
        recording = true;
        return true;
      },
      setStopHint: () => {},
      transcribeTurn: async () => ({ text: "hello there" }),
      submitTurnText: async (text) => {
        recording = false;
        return submitter.controller.submitTurnText(text);
      },
      discard: () => {},
      cancel: () => {
        recording = false;
      },
    };
    const tts = {
      speak: async (sentence) => void spoken.push(sentence),
      speakAssistantTurn: async () => {
        turnSpoken += 1;
        return { spoken: true };
      },
      stop: () => {},
      setConversationActive: () => {},
      isSpeaking: () => false,
    };
    const convo = registerConversation(
      adapted.api,
      { conversationRestartDelayMs: 5 },
      { log: () => {} },
      { stt, tts },
    );
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const prompt = fake.ctx.client.session.prompt;
    fake.ctx.client.session.prompt = async (input) => {
      await prompt(input);
      if (fastReply) emitReply();
    };
    convo.controller.start();
    assert.equal(convo.controller.isActive(), true);
    convo.controller.onKey(); // paused -> recording
    convo.controller.onKey(); // recording -> submit flow (async)
    await sleep(50); // let transcribe+submit resolve so waiting subscribes
    assert.equal(fake.creates.length, 1);
    assert.deepEqual(fake.prompts, [{ sessionID: "ses_NEW", text: "hello there" }]);
    // Assistant reply arrives as an ACTUAL v2 union message + text delta.
    function emitReply() {
      fake.v2messages.push(
        { id: "m-u2", time: { created: Date.now() }, type: "user", text: "hello there" },
        {
          id: "m-a2",
          time: { created: Date.now() },
          type: "assistant",
          agent: "default",
          model: { id: "m", providerID: "p" },
          content: [{ type: "text", text: "Hello there." }],
          finish: "stop",
        },
      );
      const fire = (type, data) => {
        for (const fn of fake.handlers.get(type) || []) fn({ type, data });
      };
      fire("session.text.delta", {
        sessionID: "ses_NEW",
        assistantMessageID: "m-a2",
        ordinal: 0,
        delta: "Hello there. ",
      });
      fire("session.idle", { sessionID: "ses_NEW" });
    }
    if (!fastReply) emitReply();
    await sleep(50);
    assert.ok(
      spoken.some((s) => /Hello there/.test(s)),
      `expected streamed sentence spoken, got ${JSON.stringify(spoken)}`,
    );
    await sleep(100);
    // Streamed path flushes the tail; the full-turn fallback must NOT run.
    assert.equal(turnSpoken, 0);
    assert.ok(
      fake.toasts.some((t) => /to talk/.test(t?.message || "")),
      "expected paused resting toast after spoken reply",
    );
    assert.equal(convo.controller.isActive(), true);
    adapted.cleanup();
    assert.equal(convo.controller.isActive(), false);
  });
}
