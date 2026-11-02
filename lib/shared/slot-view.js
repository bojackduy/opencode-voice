// @ts-nocheck - dynamic imports of optional host modules (solid-js, @opentui/solid) that tsc cannot resolve; runtime behavior unaffected.
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
  const load =
    typeof opts.load === "function"
      ? opts.load
      : async () => {
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
  let setFg = null;
  let lastTexts = new Map();
  let lastFgs = new Map();
  let unclaims = [];
  // Transient pressed-state overrides: key -> { text, until }. Applied on top
  // of segmentsFn() so a tap shows *instant* feedback without waiting for the
  // engine, then fades back on the next redraw.
  const flashes = new Map();
  const DEBOUNCE_MS = 700;
  const lastPressAt = new Map();

  function visibleSegments() {
    const now = Date.now();
    for (const [key, f] of [...flashes]) {
      if (f.until <= now) flashes.delete(key);
    }
    const base = segmentsFn();
    if (flashes.size === 0) return base;
    return base.map((seg) => {
      const f = flashes.get(seg.key);
      return f ? { ...seg, text: f.text } : seg;
    });
  }

  function flash(key, ms = 900) {
    const seg = segmentsFn().find((x) => x.key === key);
    const text = seg?.pressed ?? `[ ${key} … ]`;
    flashes.set(key, { text, until: Date.now() + ms });
    redraw();
    setTimeout(() => {
      flashes.delete(key);
      try {
        redraw();
      } catch {}
    }, ms).unref?.();
  }

  function allKeys() {
    if (keys) return keys;
    return [...new Set(segmentsFn().map((s) => s.key))];
  }

  function redraw() {
    const segs = visibleSegments();
    const segMap = new Map(segs.map((s) => [s.key, s.text]));
    const fgMap = new Map(segs.map((s) => [s.key, s.fg ?? null]));
    for (const key of allKeys()) {
      const text = segMap.has(key) ? segMap.get(key) : "";
      const fgVal = fgMap.has(key) ? fgMap.get(key) : null;
      const textChanged = lastTexts.get(key) !== text;
      const fgChanged = lastFgs.get(key) !== fgVal;
      if (!textChanged && !fgChanged) continue;
      lastTexts.set(key, text);
      lastFgs.set(key, fgVal);
      for (const entry of nodes) {
        if (entry.key !== key || entry.node.isDestroyed) continue;
        if (textChanged) setContent?.(entry.node, text);
        if (fgChanged && fgVal) setFg?.(entry.node, fgVal);
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
    lastFgs = new Map();
    flashes.clear();
    lastPressAt.clear();
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

  // Tap entry point: debounces double-taps (small phone buttons) and
  // flashes the pressed state instantly so the tap feels answered even
  // while the engine is still spinning up.
  function pressKey(key) {
    if (!active) return;
    const now = Date.now();
    if (now - (lastPressAt.get(key) ?? 0) < DEBOUNCE_MS) return;
    lastPressAt.set(key, now);
    const cur = visibleSegments().find((x) => x.key === key);
    const a = cur?.action || (actionForKey ? actionForKey(key) : null);
    if (!a) return;
    flash(key);
    press(a);
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
    setFg = (node, value) => {
      try {
        setProp(node, "fg", value);
      } catch {}
    };
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
          const segMap = new Map(visibleSegments().map((s) => [s.key, s.text]));
          const segDefs = new Map(visibleSegments().map((s) => [s.key, s]));
          for (const key of allKeys()) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            const def = segDefs.get(key);
            setProp(node, "fg", def?.fg || fg);
            const text = segMap.has(key) ? segMap.get(key) : "";
            setProp(node, "content", text);
            lastTexts.set(key, text);
            lastFgs.set(key, def?.fg || null);
            const action = def?.action || (actionForKey ? actionForKey(key) : null);
            if (action) {
              try {
                setProp(node, "onMouseUp", () => pressKey(key));
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
