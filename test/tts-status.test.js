import test from "node:test";
import assert from "node:assert/strict";
import { createTtsStatus, formatTtsStatus, fmtClock, progressBar } from "../lib/tts-status.js";

function host(stateHolder) {
  const claims = [];
  const frames = [];
  const ctx = {
    ui: {
      toast: { show() {} },
      slot: (claim) => {
        claims.push(claim);
        return () => claims.splice(claims.indexOf(claim), 1);
      },
    },
  };
  const runtime = {
    createElement: () => ({}),
    insertNode() {},
    setProp(node, key, value) {
      node[key] = value;
      if (key === "content") frames.push(value);
    },
  };
  const status = createTtsStatus(
    ctx,
    () => stateHolder.state,
    async () => runtime,
  );
  return { ctx, claims, frames, status };
}

test("clock formats m:ss", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(65), "1:05");
  assert.equal(fmtClock(600), "10:00");
});

test("progress bar fills proportionally", () => {
  assert.equal(progressBar(0, 10, 4), "░░░░");
  assert.equal(progressBar(10, 10, 4), "████");
  assert.equal(progressBar(5, 10, 4), "████".slice(0, 2) + "░░");
  assert.equal(progressBar(0, 0, 4), "░░░░");
});

test("status line shows state, clocks, bar, and non-1x rate", () => {
  const line = formatTtsStatus({ status: "playing", cursorSec: 7, totalSec: 42, rate: 1 });
  assert.match(line, /^▶ 0:07 \/ 0:42 /);
  assert.ok(!line.includes("1x"), "neutral rate stays hidden");
  const paused = formatTtsStatus({ status: "paused", cursorSec: 7, totalSec: 42, rate: 1.5 });
  assert.match(paused, /^⏸ 0:07 \/ 0:42 /);
  assert.ok(paused.endsWith("1.5x"));
  assert.equal(formatTtsStatus(null), "");
});

test("slot renders the line, updates on tick, clears on stop", async () => {
  const holder = { state: { status: "playing", cursorSec: 1, totalSec: 10, rate: 1 } };
  const h = host(holder);
  await h.status.begin();
  assert.equal(h.claims.length, 2);
  for (const c of h.claims) c.render();
  assert.match(h.frames.at(-1), /^▶ 0:01 \/ 0:10 /);
  holder.state = { status: "playing", cursorSec: 2, totalSec: 10, rate: 1 };
  h.status.update();
  assert.match(h.frames.at(-1), /^▶ 0:02 \/ 0:10 /);
  // No state change: no new frame (redraw is a no-op when unchanged).
  const before = h.frames.length;
  h.status.update();
  assert.equal(h.frames.length, before);
  h.status.clear();
  assert.equal(h.claims.length, 0);
  const frozen = h.frames.length;
  holder.state = { status: "playing", cursorSec: 9, totalSec: 10, rate: 1 };
  h.status.update();
  assert.equal(h.frames.length, frozen);
});

test("begin cancelled during runtime import never mounts stale UI", async () => {
  const h = host({ state: null });
  let loaded;
  const status = createTtsStatus(
    h.ctx,
    () => null,
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  const started = status.begin();
  status.clear();
  loaded({});
  assert.equal(await started, false);
  assert.equal(h.claims.length, 0);
});
