// @ts-nocheck - dynamic imports of optional host modules (solid-js, @opentui/solid) that tsc cannot resolve; runtime behavior unaffected.
// Persistent quick-action buttons above the composer (v2 only).
//
// Why a slot and not keybinds: the user wants a single click target that is
// always visible, so voice works on mobile / without memorising leader keys.
// Two actions: speak (toggle STT recording) and speak-reply (read the last
// assistant response). Segment definitions only; lifecycle is shared via
// lib/slot-view.js.

import { createSlotView } from "./slot-view.js";

export function quickActionSegments(state = {}) {
  // Big padded tap targets with distinct colors: green = talk (red while
  // recording, so the button itself proves the tap landed), blue = hear,
  // amber/gray = auto-submit toggle with live on/off.
  // `pressed` is the instant tap-acknowledgement shown by the shared slot
  // factory while the engine spins up. Glyphs stay in the terminal-safe set
  // (same family as the conversation/TTS status lines).
  const auto = state.autoSubmit === true;
  const recording = state.recording === true;
  const correcting = state.correcting === true;
  const speaking = state.speaking === true;
  return [
    recording
      ? { key: "speak", text: "[ ■  Stop  ]", pressed: "[ ■  …  ]", fg: "#f87171", action: "speak" }
      : {
          key: "speak",
          text: "[ ●  Speak  ]",
          pressed: "[ ●  …  ]",
          fg: "#4ade80",
          action: "speak",
        },
    speaking
      ? {
          key: "reply",
          text: "[ ■  Stop  ]",
          pressed: "[ ■  …  ]",
          fg: "#f87171",
          action: "speakReply",
        }
      : {
          key: "reply",
          text: "[ ▶  Reply  ]",
          pressed: "[ ▶  …  ]",
          fg: "#60a5fa",
          action: "speakReply",
        },
    correcting
      ? {
          key: "correct",
          text: "[ ■  Stop  ]",
          pressed: "[ ■  …  ]",
          fg: "#f87171",
          action: "correct",
        }
      : {
          key: "correct",
          text: "[ ✎  Fix  ]",
          pressed: "[ ✎  …  ]",
          fg: "#fbbf24",
          action: "correct",
        },
    {
      key: "auto",
      text: auto ? "[ ⇄  Auto:on  ]" : "[ ⇄  Auto:off ]",
      pressed: "[ ⇄  …  ]",
      fg: auto ? "#4ade80" : "#9ca3af",
      action: "toggleAutoSubmit",
    },
  ];
}

export function createQuickActionsStatus(ctx, actions = {}, load, readState) {
  return createSlotView(ctx, {
    segments: quickActionSegments,
    readState,
    actions,
    keys: ["speak", "reply", "auto", "correct"],
    interval: 1500,
    load,
  });
}
