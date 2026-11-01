// Persistent batch-recording status line (mirrors conversation-status.js).
// Shows while a one-shot batch recording is active, with clickable toggles
// for auto-end and auto-submit.

export function batchSegments(recording) {
  const base = [{ key: "status", text: recording ? "● Recording" : "", action: null }];
  if (!recording) return base;
  return [
    ...base,
    { key: "cancel", text: "[cancel]", action: "cancel" },
    { key: "send", text: "[send now]", action: "send" },
    { key: "autoEnd", text: "[auto-end]", action: "autoEnd" },
    { key: "autoSubmit", text: "[auto-submit]", action: "autoSubmit" },
  ];
}

export function createBatchStatus(
  ctx,
  readRecording,
  actions = {},
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let lastTexts = new Map();
  let renderErrorShown = false;
  let renderCalls = 0;
  let timer = null;
  const nodes = new Set();
  let setContent = null;

  function segments() {
    return batchSegments(readRecording?.() || false);
  }

  function redraw() {
    const segMap = new Map(segments().map((seg) => [seg.key, seg.text]));
    let changed = false;
    for (const key of ["status", "cancel", "send", "autoEnd", "autoSubmit"]) {
      const text = segMap.has(key) ? segMap.get(key) : "";
      if (lastTexts.get(key) !== text) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const entry of nodes) if (entry.node.isDestroyed) nodes.delete(entry);
      return;
    }
    for (const key of ["status", "cancel", "send", "autoEnd", "autoSubmit"]) {
      const text = segMap.has(key) ? segMap.get(key) : "";
      lastTexts.set(key, text);
      for (const entry of nodes) {
        if (entry.key !== key || entry.node.isDestroyed) continue;
        setContent?.(entry.node, text);
      }
    }
  }

  function loudRenderError(err) {
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Batch status failed: ${err?.message || err}`,
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
    for (const unclaim of unclaims.splice(0)) unclaim();
  }

  function press(action) {
    if (!active) return;
    try {
      actions?.[action]?.();
    } catch {}
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
          const segMap = new Map(segments().map((seg) => [seg.key, seg.text]));
          const mountEntries = [];
          for (const key of ["status", "cancel", "send", "autoEnd", "autoSubmit"]) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            const text = segMap.has(key) ? segMap.get(key) : "";
            setProp(node, "content", text);
            lastTexts.set(key, text);
            const action = segMap.has(key)
              ? (segments().find((s) => s.key === key)?.action ?? null)
              : null;
            try {
              setProp(node, "onMouseUp", () => {
                const seg = segments().find((s) => s.key === key);
                if (seg?.action) press(seg.action);
              });
            } catch {}
            const entry = { key, node };
            nodes.add(entry);
            mountEntries.push(entry);
            insertNode(box, node);
          }
          onCleanup?.(() => {
            for (const entry of mountEntries) nodes.delete(entry);
          });
          redraw();
          return box;
        } catch (renderErr) {
          loudRenderError(renderErr);
          return null;
        }
      };
      const unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      unclaims.forEach((u) => {}); // keep reference
      this._unclaims = unclaims;
      stopTimer();
      timer = setInterval(() => {
        if (!active) return;
        try {
          redraw();
        } catch {}
      }, 500);
      if (typeof timer.unref === "function") timer.unref();
      return true;
    },
    clear() {
      // unclaim slots
      if (this._unclaims) {
        for (const u of this._unclaims) {
          try {
            u();
          } catch {}
        }
        this._unclaims = [];
      }
      generation += 1;
      active = false;
      lastTexts = new Map();
      renderCalls = 0;
      stopTimer();
      nodes.clear();
      setContent = null;
    },
    renderCalls: () => renderCalls,
    nodes: () => {
      const keys = new Set();
      for (const entry of nodes) if (!entry.node.isDestroyed) keys.add(entry.key);
      return keys.size;
    },
  };
}
