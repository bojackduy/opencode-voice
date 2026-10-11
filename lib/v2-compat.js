// OpenCode v2 compatibility shim (submit-only mode).
//
// WHY this file exists: v2's TUI plugin `Context` renamed or replaced every
// v1 `TuiPluginApi` surface this plugin uses (see the drift table in the
// research goal's progress.md). Rather than forking every lib module, this
// adapter presents a v1-shaped `api` over a v2 `Context` so the SAME core
// modules run unmodified. Every mapping is capability-detected (feature
// presence, never version strings), and every surface with no v2 path
// degrades loudly (warn log + honest toast), never silently.
//
// Non-negotiable product decision (user-accepted): v2 2.0.26 has no
// plugin-reachable append-to-composer API (`tui.prompt.append` exists only
// as a server→TUI event type, not a client method). So on v2, STT
// transcribes and SUBMITS immediately via `session.prompt`. The adapted api
// passes `renderer: null` so `appendTranscription` skips the focused-input
// insert path and lands on the client shim below, which submits.

// Event renames with no same-named v2 equivalent. Values are the v2 event
// type to subscribe to instead (both verified present in the v2
// `OpenCodeEvent` union; `question.asked` has NO v2 counterpart —
// `form.created` is the closest gate signal and is best-effort, see below).
const EVENT_REMAP = {
  "message.part.delta": "session.text.delta",
  "question.asked": "form.created",
};

// Capability probe: v2 TUI `Context` has all three of these; v1 `api` has
// none under these paths. Never version-sniff.
export function isV2Context(ctx) {
  return (
    !!ctx &&
    typeof ctx?.keymap?.layer === "function" &&
    typeof ctx?.ui?.toast?.show === "function" &&
    !!ctx?.storage
  );
}

// Wrap a v2 event envelope `{type, data}` so v1-style handlers reading
// `event.properties` keep working. v1 handlers also read renamed fields,
// normalized per remapped type below.
function wrapHandler(type, fn) {
  return (event) => {
    const data = event?.data ?? event?.properties ?? {};
    let properties = { ...data };
    if (type === "message.part.delta") {
      // v2 `session.text.delta` data: {sessionID, assistantMessageID, delta}.
      // v1 handler expects {sessionID, messageID, delta, field}.
      properties = {
        ...properties,
        messageID: data.assistantMessageID ?? data.messageID,
        field: "text",
      };
    }
    if (type === "question.asked") {
      // v2 `form.created` data: {form}. The form may not carry a sessionID;
      // an absent sessionID matches the current session in our handlers
      // (`forSession` treats missing as match), which is correct for the
      // common single-session case. Multi-session over-triggering is
      // possible and documented in the README caveat list.
      properties = { ...data, ...data?.form, sessionID: data?.sessionID ?? data?.form?.sessionID };
    }
    try {
      fn({ ...event, properties });
    } catch {
      // Handlers are already internally guarded; never let a mapping throw.
    }
  };
}

// Sync `kv` facade over v2 async `storage`. v2 `storage.store` is a
// solid-store pair; our lib modules need synchronous get/set, so the facade
// mirrors values in memory and persists fire-and-forget. Worst case (persist
// fails or storage shape differs) the in-memory values still work for the
// session — settings just don't survive restart.
function createKv(storage, warn) {
  const mem = new Map();
  let update = null;
  try {
    const pair = storage.store("opencode-voice", { initial: { values: {} } });
    const store = pair?.[0];
    update = typeof pair?.[1] === "function" ? pair[1] : null;
    for (const [k, v] of Object.entries(store?.values ?? {})) mem.set(k, v);
  } catch (err) {
    warn?.(`kv seed from v2 storage failed, using memory only: ${err?.message || err}`);
  }
  return {
    get(k, fb) {
      return mem.has(k) ? mem.get(k) : fb;
    },
    set(k, v) {
      mem.set(k, v);
      if (update) {
        const snapshot = Object.fromEntries(mem);
        void Promise.resolve()
          .then(() => update((draft) => void (draft.values = snapshot)))
          .catch(() => {});
      }
    },
  };
}

// `api.ui.dialog.replace(() => api.ui.DialogSelect(props))` over v2 promise
// `dialog.select`. Our 7 call sites all use option-level `onSelect` (no
// top-level `onSelect`), but both are honored. `dialog.clear()` inside an
// option handler is a no-op on v2 (promise dialogs close on resolve).
function createDialog(dialog, warn) {
  async function runSelect(props) {
    const options = (props?.options || []).map((o) => ({
      title: o?.title,
      value: o?.value,
      description: o?.description,
      footer: o?.footer,
      category: o?.category,
      disabled: o?.disabled,
    }));
    let chosen;
    try {
      chosen = await dialog.select({
        title: props?.title,
        placeholder: props?.placeholder,
        options,
        current: props?.current,
      });
    } catch (err) {
      warn?.(`dialog.select failed: ${err?.message || err}`);
      return;
    }
    if (chosen === undefined) return; // dismissed
    const match = (props?.options || []).find((o) => o?.value === chosen);
    try {
      if (match?.onSelect) await match.onSelect();
      else if (typeof props?.onSelect === "function") await props.onSelect(chosen);
    } catch (err) {
      warn?.(`dialog option handler failed: ${err?.message || err}`);
    }
  }
  return {
    replace(render) {
      let rendered;
      try {
        rendered = render();
      } catch (err) {
        warn?.(`dialog.replace render failed: ${err?.message || err}`);
        return;
      }
      const props = rendered?.__v2DialogSelect ? rendered.props : null;
      if (!props) {
        warn?.("dialog.replace called with non-DialogSelect content (no v2 path), ignored");
        return;
      }
      void runSelect(props);
    },
    clear() {},
  };
}

function DialogSelect(props) {
  return { __v2DialogSelect: true, props: props || {} };
}

export function adaptV2Context(ctx) {
  const disposers = [];
  const warned = new Set();
  const warnMessages = [];
  // Loud degradation: warn logs are collected for evidence and also sent
  // through the real logger once boot creates it (wired via onWarn below).
  let warnSink = null;
  const warn = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    warnMessages.push(message);
    try {
      warnSink?.(`v2-compat: ${message}`);
    } catch {}
  };

  const toast = (input) => {
    try {
      const options = typeof input === "string" ? { message: input } : input || {};
      ctx.ui.toast.show({
        title: options.title,
        message: options.message ?? "",
        variant: options.variant,
        duration: options.duration,
        sessionID: options.sessionID,
      });
    } catch {}
  };

  function currentSessionID() {
    try {
      const route = ctx.ui.router.current();
      return route?.type === "session" ? route?.sessionID : undefined;
    } catch {
      return undefined;
    }
  }

  async function submitTextAsPrompt(text) {
    const sessionID = currentSessionID();
    if (!sessionID) {
      const kept = String(text || "").slice(0, 120);
      toast({
        message: `Voice: no active session — transcript kept on screen, nothing submitted (${kept})`,
        variant: "warning",
        duration: 5000,
      });
      warn("submit attempted with no active session; transcript not submitted");
      throw new Error("No active session to submit to");
    }
    await ctx.client.session.prompt({ sessionID, text: String(text || "") });
    // No toast here: the caller's turn toast (appendTurnText/submitTurnText)
    // reports the submit, keyed off the `submitted` marker below. One toast
    // per turn, never a faked edit step.
  }

  // `Object.create` (not spread) so client methods keep their `this`.
  const client = Object.create(ctx.client, {
    // `client.app.log` has no v2 path — silent no-op (pre-existing `?.`
    // tolerance in createLogger already expects absence).
    app: { value: { log: async () => {} } },
    tui: {
      value: {
        // Submit-only: append-for-edit is unimplementable on v2, so append
        // becomes submit. Accepts both v1 call shapes ({body:{text}} and
        // {text}) used by stt.js. The `submitted` marker lets the caller's
        // toast report a submit instead of an edit-step append.
        appendPrompt: async (input) => {
          await submitTextAsPrompt(input?.body?.text ?? input?.text ?? "");
          return { data: null, submitted: true };
        },
        submitPrompt: async () => {},
      },
    },
  });

  const dialog = createDialog(ctx.ui.dialog, warn);

  const api = {
    client,
    // Submit-only enforcement: with no renderer, `appendTranscription`
    // skips `insertIntoFocusedInput` and lands on the client shim above,
    // which submits via `session.prompt`. v2 renderer streaming previews
    // are therefore disabled by construction, not by flag.
    renderer: null,
    ui: { toast, dialog, DialogSelect },
    event: {
      on: (type, fn) => {
        const remapped = EVENT_REMAP[type];
        if (remapped) warn(`event "${type}" remapped to v2 "${remapped}"`);
        if (type === "question.asked") {
          warn(
            'event "question.asked" has no v2 equivalent; best-effort mapping to "form.created" ' +
              "(may over-trigger with multiple sessions)",
          );
        }
        try {
          return ctx.data.on(remapped || type, wrapHandler(type, fn));
        } catch (err) {
          warn(`event subscribe "${type}" failed: ${err?.message || err}`);
          return () => {};
        }
      },
    },
    lifecycle: {
      onDispose: (fn) => void disposers.push(fn),
    },
    kv: createKv(ctx.storage, warn),
    route: {
      get current() {
        const route = ctx.ui.router.current();
        if (route?.type === "session") {
          return { name: "session", params: { sessionID: route.sessionID } };
        }
        return { name: route?.type || "home", params: {} };
      },
    },
    state: {
      session: {
        messages: (sessionID) => {
          try {
            return ctx.data.session.message.list(sessionID) || [];
          } catch {
            return [];
          }
        },
      },
      // v1 `state.part(messageID)` (message parts) has no v2 data path;
      // callers treat a missing part as "not non-text" and proceed.
      part: () => [],
      path: {
        // v2 `location` is a LocationRef, not a directory string.
        get directory() {
          try {
            return ctx.location?.directory || process.cwd();
          } catch {
            return process.cwd();
          }
        },
      },
    },
    command: {
      register: (getCommands) => {
        let commands = [];
        try {
          commands = getCommands() || [];
        } catch (err) {
          warn(`command registration failed: ${err?.message || err}`);
          return;
        }
        // v1 `{title, value, category, description, keybind?, slash?, onSelect}`
        // → v2 `KeymapCommand {id, title, group, bind, palette, slash, run}`
        // + layer `bindings`. Every command joins palette + slash so all
        // stay reachable; keybinds are translated below (invalid binds are
        // reported by the host parser, not here).
        // v1 bind strings use a `<leader>X` token for two-key sequences; v2
        // bind strings have no leader token — sequences are space-separated
        // keys with +-joined modifiers, and the leader is literally ctrl+x
        // (cf the builtin "Switch model ctrl+x m"). Anything else passes
        // through untouched (v2-native "ctrl+r" style binds need no mapping).
        const toV2Bind = (bind) => {
          if (typeof bind !== "string" || bind.length === 0) return false;
          const leader = bind.match(/^<leader>(.+)$/);
          if (leader) return `ctrl+x ${leader[1]}`;
          return bind;
        };
        const mapped = commands.map((c) => ({
          id: c?.value,
          title: c?.title,
          description: c?.description,
          group: c?.category,
          bind: toV2Bind(c?.keybind),
          palette: true,
          slash: c?.slash ? { name: c.slash.name, aliases: c.slash.aliases } : undefined,
          run: (...args) => c?.onSelect?.(...args),
        }));
        const registerLayer = () => {
          try {
            ctx.keymap.layer(() => ({
              mode: "global",
              commands: mapped.map((c) => {
                const cmd = {
                  id: c.id,
                  title: c.title,
                  group: c.group,
                  palette: true,
                  slash: c.slash,
                  run: c.run,
                };
                if (c.description) cmd.description = c.description;
                if (typeof c.bind === "string" && c.bind.length > 0) cmd.bind = c.bind;
                return cmd;
              }),
              // Binds are displayed from command.bind but only become
              // ACTIVE when listed here — verified live: without this the
              // palette shows the shortcut yet the keystroke does nothing.
              // Only ids with a real bind string join (binding a bind-less
              // id is contradictory).
              bindings: mapped
                .filter((c) => typeof c.bind === "string" && c.bind.length > 0)
                .map((c) => c.id),
            }));
          } catch (err) {
            warn(`keymap.layer rejected commands: ${err?.message || err}`);
          }
        };
        // layer() must run inside a component: the host resolves the layer
        // against the ambient Keymap provider, and a direct call in setup()
        // never registers (the failure surfaces only as missing commands,
        // never as an error). So claim the always-mounted "app" slot with
        // a null-render component as the mount point and register once
        // from its render. Unclaiming on dispose removes the layer.
        if (typeof ctx.ui?.slot === "function") {
          let claimed = false;
          try {
            const unclaim = ctx.ui.slot({
              append: "app",
              render: () => {
                if (!claimed) {
                  claimed = true;
                  registerLayer();
                }
                return null;
              },
            });
            disposers.push(() => {
              try {
                unclaim();
              } catch {}
            });
            return;
          } catch (err) {
            warn(`slot claim for keymap failed, trying direct layer: ${err?.message || err}`);
          }
        }
        registerLayer();
      },
    },
  };

  // v1 reads `api.state.provider` as an array (`resolveVoiceProviderModel`
  // does `api?.state?.provider || []` then `.find`); v2 lists per location.
  // A getter keeps the array shape without touching callers.
  Object.defineProperty(api.state, "provider", {
    get() {
      try {
        return ctx.data.location.provider.list() || [];
      } catch {
        return [];
      }
    },
    enumerable: true,
  });

  function cleanup() {
    for (const fn of disposers.splice(0)) {
      try {
        const r = fn();
        if (r?.then) void r.catch(() => {});
      } catch {}
    }
  }

  return {
    api,
    cleanup,
    submitOnly: true,
    warnMessages,
    onWarn: (sink) => void (warnSink = sink),
  };
}
