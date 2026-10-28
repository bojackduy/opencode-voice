// Persistent TTS "now playing" line for v2 (mirrors lib/v2-preview.js).
//
// Why a slot and not a toast: v2 Toast.show is fire-and-forget text with no
// update or buttons, so a polling progress toast would stack like the old STT
// storm. This is one bounded line above the composer showing state, exact
// position/total, a bar, and speed. It renders ONLY while audio is live:
// readState returning null renders nothing, so idle TTS leaves no trace.
//
// Totals are measured from real audio frames by lib/tts-player.js (exact);
// the cursor is wall-clock derived (approximate) and marked as such only in
// tests - the line shows position plainly, like any media player.

import { sttLog } from "./stt-log.js";

const BAR_WIDTH = 20;
const BAR_FULL = "█";
const BAR_EMPTY = "░";

export function fmtClock(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function progressBar(cursorSec, totalSec, width = BAR_WIDTH) {
  const total = Number(totalSec) || 0;
  const cursor = Math.max(0, Math.min(Number(cursorSec) || 0, total));
  const ratio = total > 0 ? cursor / total : 0;
  const full = Math.round(ratio * width);
  return BAR_FULL.repeat(full) + BAR_EMPTY.repeat(Math.max(0, width - full));
}

export const RATE_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function nextRate(current) {
  const cur = Number(current);
  for (const step of RATE_STEPS) {
    if (step > cur + 1e-9) return step;
  }
  return RATE_STEPS[0];
}

export function formatTtsStatus(state) {
  if (!state) return "";
  return statusSegments(state)
    .map((seg) => seg.text)
    .join(" ");
}

// One segment per clickable or static chunk. Static chunks carry no action;
// buttons do. The renderer maps each segment to its own text node so mouse
// hits land on exactly one action.
export function statusSegments(state) {
  if (!state) return [];
  if (state.status === "loading") {
    // No buttons while nothing is playable yet; the animated dots prove the
    // plugin is working through a slow model load or long synthesis.
    const dots = ".".repeat(1 + (Math.floor(Date.now() / 500) % 3));
    return [{ key: "main", text: `… Loading voice${dots}`, action: null }];
  }
  const playing = state.status !== "paused";
  const rate = Number(state.rate) || 1;
  return [
    { key: "toggle", text: playing ? "[⏸]" : "[▶]", action: "toggle" },
    {
      key: "main",
      text: `${fmtClock(state.cursorSec)} / ${fmtClock(state.totalSec)} ${progressBar(state.cursorSec, state.totalSec)}`,
      action: null,
    },
    { key: "rw", text: "[-5s]", action: "rewind" },
    { key: "ff", text: "[+5s]", action: "forward" },
    { key: "rate", text: `[${rate}x]`, action: "rate" },
  ];
}

export function createTtsStatus(
  ctx,
  readState,
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
  const nodes = new Map();
  let setContent = null;

  function segments() {
    return statusSegments(readState?.() || { status: "idle", cursorSec: 0, totalSec: 0, rate: 1 });
  }

  function redraw() {
    const segs = segments();
    if (!redraw.shapeLogged && segs.length > 0 && nodes.size > 0) {
      redraw.shapeLogged = true;
      try {
        sttLog("tts.status", `render segs=${segs.map((s) => s.key).join(",")} nodes=${nodes.size}`);
      } catch {}
    }
    let changed = false;
    for (const seg of segs) {
      if (lastTexts.get(seg.key) !== seg.text) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      // Drop destroyed nodes even when nothing changed.
      for (const [key, node] of nodes) {
        if (node.isDestroyed) {
          nodes.delete(key);
          lastTexts.delete(key);
        }
      }
      return;
    }
    for (const seg of segs) {
      lastTexts.set(seg.key, seg.text);
      const node = nodes.get(seg.key);
      if (!node) continue;
      if (node.isDestroyed) {
        nodes.delete(seg.key);
        continue;
      }
      setContent?.(node, seg.text);
    }
  }

  function loudRenderError(err) {
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Voice media display failed: ${err?.message || err}`,
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
    redraw.shapeLogged = false;
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
      let createElement;
      let setProp;
      let insertNode;
      let onCleanup;
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
          for (const seg of segments()) {
            const node = createElement("text");
            setProp(node, "maxHeight", 1);
            setProp(node, "minHeight", 1);
            setProp(node, "fg", fg);
            setProp(node, "content", seg.text);
            lastTexts.set(seg.key, seg.text);
            if (seg.action) {
              const action = seg.action;
              try {
                setProp(node, "onMouseUp", () => press(action));
              } catch {}
            }
            nodes.set(seg.key, node);
            insertNode(box, node);
            onCleanup?.(() => {
              if (nodes.get(seg.key) === node) nodes.delete(seg.key);
            });
          }
          return box;
        } catch (renderErr) {
          loudRenderError(renderErr);
          return null;
        }
      };
      // Same proven vertical slots as the voice preview: prompt.footer is a
      // horizontal row and is absent on the home screen.
      unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      // Cursor moves on wall-clock time; re-read state twice a second so the
      // line advances without toast spam. Redraw is a no-op when unchanged.
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
    update() {
      if (!active) return;
      redraw();
    },
    renderCalls: () => renderCalls,
    nodes: () => nodes.size,
    clear,
  };
}
