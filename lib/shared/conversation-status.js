// @ts-nocheck - dynamic imports of optional host modules (solid-js, @opentui/solid) that tsc cannot resolve; runtime behavior unaffected.
import { createSlotView } from "./slot-view.js";
// Persistent conversation status line for v2 (mirrors lib/tts-status.js).
//
// Why a slot and not a toast: v2 Toast.show is fire-and-forget text with no
// update or buttons, so polling would stack. This is one bounded line showing
// the current phase and the 2-3 actions that matter right now.
//
// Phase-aware buttons (see README): recording -> cancel/send-now; processing ->
// cancel; waiting -> cancel/barge-in; speaking -> stop/talk-now/pause-TTS;
// paused -> talk/end. Only the relevant subset renders per phase.

export function phaseGlyph(phase) {
  switch (phase) {
    case "recording":
      return "●";
    case "processing":
      return "…";
    case "waiting":
      return "…";
    case "speaking":
      return "▶";
    case "paused":
      return "⏸";
    default:
      return "○";
  }
}

export function phaseLabel(phase) {
  switch (phase) {
    case "recording":
      return "Listening";
    case "processing":
      return "Transcribing";
    case "waiting":
      return "Agent working";
    case "speaking":
      return "Speaking";
    case "paused":
      return "Paused";
    default:
      return "Conversation off";
  }
}

// Returns the segments for the current phase. Static segments carry no
// action; button segments do. The renderer maps each to its own text node
// so mouse hits land on exactly one action.
export const PHASE_COLORS = {
  recording: "#f87171",
  processing: "#fbbf24",
  waiting: "#facc15",
  speaking: "#4ade80",
  paused: "#9ca3af",
  idle: "#9ca3af",
};

export function conversationSegments(phase) {
  const glyph = phaseGlyph(phase);
  const label = phaseLabel(phase);
  const base = [
    {
      key: "status",
      text: `${glyph} ${label}`,
      action: null,
      fg: PHASE_COLORS[phase] || PHASE_COLORS.idle,
    },
  ];
  switch (phase) {
    case "recording":
      return [
        ...base,
        { key: "cancel", text: "[cancel]", action: "cancel" },
        { key: "send", text: "[send now]", action: "send" },
        { key: "autoEnd", text: "[auto-end]", action: "autoEnd" },
      ];
    case "processing":
      return [...base, { key: "cancel", text: "[cancel]", action: "cancel" }];
    case "waiting":
      return [
        ...base,
        { key: "cancel", text: "[cancel]", action: "cancel" },
        { key: "barge", text: "[talk now]", action: "barge" },
      ];
    case "speaking":
      return [
        ...base,
        { key: "stop", text: "[stop]", action: "stop" },
        { key: "talk", text: "[talk now]", action: "barge" },
        { key: "pause", text: "[pause]", action: "pauseTts" },
      ];
    case "paused":
      return [
        ...base,
        { key: "talk", text: "[talk]", action: "talk" },
        { key: "end", text: "[end]", action: "end" },
      ];
    default:
      return base;
  }
}

export function formatConversationStatus(phase) {
  if (!phase || phase === "idle") return "";
  return conversationSegments(phase)
    .map((seg) => seg.text)
    .join(" ");
}

export function createConversationStatus(
  ctx,
  readPhase,
  actions = {},
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  const rp = typeof readPhase === "function" ? readPhase : () => "idle";
  const ALL_KEYS = ["status", "cancel", "send", "barge", "stop", "talk", "end", "pause", "autoEnd"];
  return createSlotView(ctx, {
    segments: () => conversationSegments(rp() || "idle"),
    actions,
    keys: ALL_KEYS,
    actionForKey: (key) => {
      const seg = conversationSegments(rp() || "idle").find((s) => s.key === key);
      return seg?.action ?? null;
    },
    interval: 500,
    load,
  });
}
