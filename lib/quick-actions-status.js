// @ts-nocheck - dynamic imports of optional host modules (solid-js, @opentui/solid) that tsc cannot resolve; runtime behavior unaffected.
// Persistent quick-action buttons above the composer (v2 only).
//
// Why a slot and not keybinds: the user wants a single click target that is
// always visible, so voice works on mobile / without memorising leader keys.
// Two actions: speak (toggle STT recording) and speak-reply (read the last
// assistant response). Segment definitions only; lifecycle is shared via
// lib/slot-view.js.

import { createSlotView } from "./shared/slot-view.js";

export function quickActionSegments() {
  return [
    { key: "speak", text: "[mic speak]", action: "speak" },
    { key: "reply", text: "[speak reply]", action: "speakReply" },
  ];
}

export function createQuickActionsStatus(ctx, actions = {}, load) {
  return createSlotView(ctx, {
    segments: quickActionSegments,
    actions,
    keys: ["speak", "reply"],
    interval: 0,
    load,
  });
}
