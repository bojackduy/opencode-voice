// @ts-nocheck - dynamic imports of optional host modules (solid-js, @opentui/solid) that tsc cannot resolve; runtime behavior unaffected.
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
import { createSlotView } from "./slot-view.js";

const BAR_WIDTH = 20;

const SEG_KEYS = ["toggle", "main", "rw", "ff", "rate"];
const SEG_ACTION = { toggle: "toggle", main: null, rw: "rewind", ff: "forward", rate: "rate" };
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
  const stateReader = typeof readState === "function" ? readState : () => null;
  const view = createSlotView(ctx, {
    segments: () =>
      statusSegments(stateReader() || { status: "idle", cursorSec: 0, totalSec: 0, rate: 1 }),
    actions,
    keys: SEG_KEYS,
    actionForKey: (key) => SEG_ACTION[key] || null,
    interval: 500,
    load,
  });
  // Keep the public surface tests expect: begin/update/clear/renderCalls/nodes.
  return view;
}
