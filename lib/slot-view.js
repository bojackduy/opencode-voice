// Shared slot lifecycle for v2 persistent status lines.
//
// The three *-status.js files (conversation, tts, quick-actions) used to
// each reimplement begin/update/clear/press/redraw, slot claims, onMouseUp
// wiring, and error toasts. This factory owns that lifecycle; a view keeps
// only its segments() definition and hands it here.
//
// Usage:
//   const view = createSlotView(ctx, {
//     segments: () => [{ key, text, action }],
//     actions: { ... },
//     keys: ["status", "cancel", ...],   // keys to track/redraw
//     interval: 500,                      // redraw timer (0 = none)
//     load: async () => ({...solid,...tui}),
//   });

export function createSlotView(ctx, opts = {}) {
  const segmentsFn = typeof opts.segments === "function" ? opts.segments : () => [];
  const actions = opts.actions || {};
  const keys = Array.isArray(opts.keys) && opts.keys.length ? opts.keys : null;
  const actionForKey = typeof opts.actionForKey === "function" ? opts.actionForKey : null;
  const interval = typeof opts.interval === "number" ? opts.interval : 500;
  const load = typeof opts.load === "function" ? opts.load : async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  };

  let generation = 0;
  let active = false;
  let renderErrorShown = false;
  let renderCalls = 0;
  let timer = null;
  const nodes = new Set();
  let setContent = null;
  let lastTexts = new Map();
  let unclaims = [];

  function allKeys() {
    if (keys) return keys;
    return [...new Set(segmentsFn().map((s) => s.key))];
  }

  function redraw() {
    const segMap = new Map(segmentsFn().map((s) => [s.key, s.text]));
    for (const key of allKeys()) {
      const text = segMap.has(key) ? segMap.get(key) : "";
      if (lastTexts.get(key) === text) continue;
      lastTexts.set(key, text);
      for (const entry of nodes) {
        if (entry.key !== key || entry.node.isDestroyed) continue;
        setContent?.(entry.node, text);
      }
    }
    for (const entry of nodes) {
      if (entry.node.isDestroyed) nodes.delete(entry);
    }
  }

  function loudRenderError(err) {
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `View failed: ${err?.message || err}`,
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
            message: `Action "${action}" is not wired yet`,
            variant: "warning",
            duration: 3000,
          });
        } catch {}
        return;
      }
      const r = fn();
      if (r && typeof r.catch === "function") {
        r.catch((err) => {
          try {
            ctx.ui?.toast?.show?.({
              message: `Action failed: ${err?.message || err}`,
              variant: "error",
              duration: 5000,
            });
          } catch {}
        });
      }
    } catch (err) {
      try {
        ctx.ui?.toast?.show?.({
          message: `Action failed: ${err?.message || err}`,
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
          const segMap = new Map(segmentsFn().map((s) => [s.key, s.text]));
          const actionMap = new Map(segmentsFn().map((s) => [s.key, s.action]));
          for (const key of allKeys()) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            const text = segMap.has(key) ? segMap.get(key) : "";
            setProp(node, "content", text);
            lastTexts.set(key, text);
            const action = actionMap.get(key) || (actionForKey ? actionForKey(key) : null);
            if (action) {
              try {
                setProp(node, "onMouseUp", () => {
                  const cur = segmentsFn().find((s) => s.key === key);
                  const a = cur?.action || (actionForKey ? actionForKey(key) : null);
                  if (a) press(a);
                });
              } catch {}
            }
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
      if (interval > 0) {
        stopTimer();
        timer = setInterval(() => {
          if (!active) return;
          try {
            redraw();
          } catch {}
        }, interval);
        if (typeof timer.unref === "function") timer.unref();
      }
      return true;
    },
    update() {
      if (!active) return;
      redraw();
    },
    renderCalls: () => renderCalls,
    nodes: () => {
      const keys = new Set();
      for (const entry of nodes) {
        if (!entry.node.isDestroyed) keys.add(entry.key);
      }
      return keys.size;
    },
    clear,
    press,
  };
}
