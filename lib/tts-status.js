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

export function formatTtsStatus(state) {
  if (!state) return "";
  const glyph = state.status === "paused" ? "⏸" : "▶";
  const clock = `${fmtClock(state.cursorSec)} / ${fmtClock(state.totalSec)}`;
  const bar = progressBar(state.cursorSec, state.totalSec);
  const rate = Number(state.rate) && Number(state.rate) !== 1 ? ` ${state.rate}x` : "";
  return `${glyph} ${clock} ${bar}${rate}`;
}

export function createTtsStatus(
  ctx,
  readState,
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let lastText = "";
  let renderErrorShown = false;
  let renderCalls = 0;
  let timer = null;
  const nodes = new Set();
  let setContent = null;

  function display() {
    return formatTtsStatus(readState?.());
  }

  function redraw() {
    const text = display();
    if (text === lastText) return;
    lastText = text;
    for (const node of nodes) {
      if (node.isDestroyed) nodes.delete(node);
      else setContent?.(node, text);
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
    lastText = "";
    renderCalls = 0;
    stopTimer();
    nodes.clear();
    setContent = null;
    for (const unclaim of unclaims.splice(0)) unclaim();
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
          setProp(box, "width", "100%");
          const node = createElement("text");
          setProp(node, "maxHeight", 1);
          setProp(node, "minHeight", 1);
          setProp(node, "width", "100%");
          setProp(node, "fg", fg);
          const text = display();
          lastText = text;
          setProp(node, "content", text);
          nodes.add(node);
          insertNode(box, node);
          onCleanup?.(() => nodes.delete(node));
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
