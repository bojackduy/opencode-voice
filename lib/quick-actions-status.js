// Persistent quick-action buttons above the composer (v2 only).
//
// Why a slot and not keybinds: the user wants a single click target that is
// always visible, so voice works on mobile / without memorising leader keys.
// Two actions: speak (toggle STT recording) and speak-reply (read the last
// assistant response). Mirrors lib/conversation-status.js.

export function quickActionSegments() {
  return [
    { key: "speak", text: "[mic speak]", action: "speak" },
    { key: "reply", text: "[speak reply]", action: "speakReply" },
  ];
}

export function createQuickActionsStatus(
  ctx,
  actions = {},
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let renderErrorShown = false;
  let renderCalls = 0;
  let timer = null;
  const nodes = new Set();
  let setContent = null;
  let lastTexts = new Map();

  function redraw() {
    const segMap = new Map(quickActionSegments().map((s) => [s.key, s.text]));
    for (const key of ["speak", "reply"]) {
      const text = segMap.has(key) ? segMap.get(key) : "";
      if (lastTexts.get(key) !== text) {
        lastTexts.set(key, text);
        for (const entry of nodes) {
          if (entry.key !== key || entry.node.isDestroyed) continue;
          setContent?.(entry.node, text);
        }
      }
    }
  }

  function loudRenderError(err) {
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Quick actions failed: ${err?.message || err}`,
        variant: "error",
        duration: 5000,
      });
    } catch {}
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  let unclaims = [];
  function clear() {
    generation += 1;
    active = false;
    lastTexts = new Map();
    renderCalls = 0;
    stopTimer();
    nodes.clear();
    setContent = null;
    for (const unclaim of unclaims.splice(0)) {
      try {
        unclaim();
      } catch {}
    }
  }

  function press(action) {
    if (!active) return;
    try {
      const fn = actions?.[action];
      if (typeof fn !== "function") {
        try {
          ctx.ui?.toast?.show?.({
            message: `Quick action "${action}" is not wired yet`,
            variant: "warning",
            duration: 3000,
          });
        } catch {}
        return;
      }
      fn();
    } catch (err) {
      try {
        ctx.ui?.toast?.show?.({
          message: `Quick action failed: ${err?.message || err}`,
          variant: "error",
          duration: 5000,
        });
      } catch {}
    }
  }

  return {
    async begin() {
      clear();
      active = true;
      renderErrorShown = false;
      const mine = generation;
      let createElement, setProp, insertNode, onCleanup;
      try {
        ({ createElement, setProp, insertNode, onCleanup } = await load());
      } catch (loadErr) {
        loudRenderError(loadErr);
        throw loadErr;
      }
      if (!active || mine !== generation) return false;
      setContent = (node, value) => setProp(node, "content", value);
      const themeText = ctx.theme?.text;
      const fg =
        typeof themeText === "string"
          ? themeText
          : themeText?.base || themeText?.muted || "#eeeeee";
      const render = () => {
        if (!active || mine !== generation) return null;
        renderCalls += 1;
        try {
          const box = createElement("box");
          setProp(box, "height", 1);
          setProp(box, "flexShrink", 0);
          setProp(box, "flexDirection", "row");
          setProp(box, "width", "100%");
          const segMap = new Map(quickActionSegments().map((s) => [s.key, s.text]));
          for (const key of ["speak", "reply"]) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            const text = segMap.has(key) ? segMap.get(key) : "";
            setProp(node, "content", text);
            lastTexts.set(key, text);
            try {
              setProp(node, "onMouseUp", () => {
                const seg = quickActionSegments().find((s) => s.key === key);
                if (seg?.action) press(seg.action);
              });
            } catch {}
            const entry = { key, node };
            nodes.add(entry);
            insertNode(box, node);
          }
          onCleanup?.(() => {
            for (const entry of nodes) nodes.delete(entry);
          });
          redraw();
          return box;
        } catch (renderErr) {
          loudRenderError(renderErr);
          return null;
        }
      };
      unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      return true;
    },
    update() {
      if (!active) return;
      redraw();
    },
    renderCalls: () => renderCalls,
    clear,
  };
}
