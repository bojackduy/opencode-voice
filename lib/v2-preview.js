// Host-owned Solid/OpenTUI modules are loaded only when a v2 recording starts.
// No composer mutation: this bounded display is an additive, documented slot.
//
// Renders the live transcript and the live input waveform together: the same
// 16-column bar style used by the batch recording toast, sourced from the
// streaming capture's newest PCM tail. The waveform timer lives here so every
// stop path (`clear()`) cancels it in one place.
import { sttLog } from "./stt-log.js";

const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function createV2Preview(
  ctx,
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let partial = { stableText: "", tentativeText: "" };
  let levels = null;
  let waveProvider = null;
  let waveTimer = null;
  const nodes = new Set();
  let setContent = null;

  function display() {
    const stable = partial.stableText || "";
    const tentative = partial.tentativeText || "";
    const body =
      `Voice live · ${stable ? `${stable} ` : ""}${tentative ? `[${tentative}]` : stable ? "" : "Listening…"}`.slice(
        -1580,
      );
    const wave = levels
      ? `${levels.map((level) => WAVE_CHARS[level] ?? WAVE_CHARS[0]).join("")}  `
      : "";
    return `${wave}${body}`;
  }

  function redraw() {
    for (const node of nodes) {
      if (node.isDestroyed) nodes.delete(node);
      else setContent?.(node, display());
    }
  }

  function applyLevels(next) {
    if (!active || !Array.isArray(next) || next.length === 0) return;
    levels = next.map((value) => {
      const level = Math.trunc(Number(value));
      if (!Number.isFinite(level)) return 0;
      return Math.max(0, Math.min(WAVE_CHARS.length - 1, level));
    });
    redraw();
  }

  function stopWave() {
    if (waveTimer) {
      clearInterval(waveTimer);
      waveTimer = null;
    }
    waveProvider = null;
  }

  function startWave(provider, intervalMs = 80) {
    stopWave();
    sttLog("preview.wave", active && typeof provider === "function" ? "start" : "rejected");
    if (!active || typeof provider !== "function") return;
    waveProvider = provider;
    const timer = setInterval(
      () => {
        if (!active || !waveProvider) return;
        try {
          const next = waveProvider();
          if (next) applyLevels(next);
        } catch {}
      },
      Math.max(20, Math.floor(Number(intervalMs) || 80)),
    );
    if (typeof timer.unref === "function") timer.unref();
    waveTimer = timer;
  }

  let unclaims = [];
  function clear() {
    generation += 1;
    active = false;
    partial = { stableText: "", tentativeText: "" };
    levels = null;
    stopWave();
    nodes.clear();
    setContent = null;
    renderCalls = 0;
    for (const unclaim of unclaims.splice(0)) unclaim();
  }
  let renderErrorShown = false;
  let renderCalls = 0;
  function loudRenderError(err) {
    sttLog("preview.render-error", err?.message || String(err));
    if (renderErrorShown) return;
    renderErrorShown = true;
    try {
      ctx.ui?.toast?.show?.({
        message: `Voice live preview failed: ${err?.message || err}`,
        variant: "error",
        duration: 5000,
      });
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
        sttLog("preview.begin-failed", loadErr?.message || String(loadErr));
        loudRenderError(loadErr);
        throw loadErr;
      }
      if (!active || mine !== generation) return false;
      sttLog("preview.begin-ok");
      setContent = (node, value) => setProp(node, "content", value);
      const themeText = ctx.theme?.text;
      const fg =
        typeof themeText === "string"
          ? themeText
          : themeText?.base || themeText?.muted || "#eeeeee";
      const render = () => {
        if (!active || mine !== generation) return null;
        renderCalls += 1;
        if (renderCalls === 1) sttLog("preview.render-first");
        try {
          const box = createElement("box");
          setProp(box, "height", 3);
          setProp(box, "flexShrink", 0);
          setProp(box, "width", "100%");
          const node = createElement("text");
          setProp(node, "maxHeight", 5);
          setProp(node, "minHeight", 1);
          setProp(node, "width", "100%");
          setProp(node, "fg", fg);
          setProp(node, "content", display());
          nodes.add(node);
          insertNode(box, node);
          onCleanup?.(() => nodes.delete(node));
          return box;
        } catch (renderErr) {
          loudRenderError(renderErr);
          return null;
        }
      };
      // Vertical slots only: prompt.footer is a horizontal row (zero-width
      // text) and is absent on the home screen.
      unclaims = [
        ctx.ui.slot({ before: "session.composer.top", render }),
        ctx.ui.slot({ before: "home.footer", render }),
      ];
      return true;
    },
    applyPartial(p) {
      if (!active) return;
      partial = { stableText: p?.stableText || "", tentativeText: p?.tentativeText || "" };
      sttLog(
        "preview.partial",
        `stable=${partial.stableText.length} tentative=${partial.tentativeText.length} nodes=${nodes.size}`,
      );
      redraw();
    },
    applyLevels,
    startWave,
    stopWave,
    getTranscript: () => [partial.stableText, partial.tentativeText].filter(Boolean).join(" "),
    finalize(text) {
      clear();
      return { text, inserted: false };
    },
    cancel: clear,
    clear,
  };
}
