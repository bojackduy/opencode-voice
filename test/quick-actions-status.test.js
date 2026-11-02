import test from "node:test";
import assert from "node:assert/strict";
import {
  createQuickActionsStatus,
  quickActionSegments,
} from "../lib/shared/quick-actions-status.js";

function host(actions = {}, readState) {
  const claims = [];
  const nodes = [];
  const toasts = [];
  const ctx = {
    ui: {
      toast: { show: (t) => toasts.push(t) },
      slot: (claim) => {
        claims.push(claim);
        return () => claims.splice(claims.indexOf(claim), 1);
      },
    },
  };
  const runtime = {
    createElement: () => {
      const node = {};
      nodes.push(node);
      return node;
    },
    insertNode() {},
    setProp(node, key, value) {
      node[key] = value;
    },
    onCleanup() {},
  };
  const status = createQuickActionsStatus(ctx, actions, async () => runtime, readState);
  const byContent = (text) => nodes.find((n) => n.content === text);
  return { ctx, claims, nodes, toasts, byContent, status };
}

test("quick actions declare speak and speak-reply buttons", () => {
  const segs = quickActionSegments();
  assert.deepEqual(
    segs.map((s) => [s.key, s.action]),
    [
      ["speak", "speak"],
      ["reply", "speakReply"],
      ["auto", "toggleAutoSubmit"],
    ],
  );
});

test("button clicks dispatch speak and speakReply", async () => {
  const pressed = [];
  const h = host({
    speak: () => pressed.push("speak"),
    speakReply: () => pressed.push("speakReply"),
  });
  await h.status.begin();
  for (const c of h.claims) c.render();
  h.byContent("[ ●  Speak  ]").onMouseUp();
  h.byContent("[ ▶  Reply  ]").onMouseUp();
  assert.deepEqual(pressed, ["speak", "speakReply"]);
  h.status.clear();
});

test("unwired action toasts instead of failing silently", async () => {
  const h = host({});
  await h.status.begin();
  for (const c of h.claims) c.render();
  h.byContent("[ ●  Speak  ]").onMouseUp();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /not wired yet/);
  h.status.clear();
});

test("throwing action toasts the error", async () => {
  const h = host({
    speak: () => {
      throw new Error("boom");
    },
  });
  await h.status.begin();
  for (const c of h.claims) c.render();
  h.byContent("[ ●  Speak  ]").onMouseUp();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /boom/);
  h.status.clear();
});

test("clear removes slot claims so re-setup leaves no dead buttons", async () => {
  const h = host({ speak: () => {} });
  await h.status.begin();
  assert.equal(h.claims.length, 2);
  h.status.clear();
  assert.equal(h.claims.length, 0);
});

test("rapid double-tap fires the action only once", async () => {
  const pressed = [];
  const h = host({ speak: () => pressed.push("speak") });
  await h.status.begin();
  for (const c of h.claims) c.render();
  h.byContent("[ ●  Speak  ]").onMouseUp();
  // Second tap lands inside the debounce window: swallowed, no double toggle.
  const flashNode = h.nodes.find((n) => n.content === "[ ●  …  ]");
  assert.ok(flashNode, "tap shows instant pressed state");
  flashNode.onMouseUp();
  assert.deepEqual(pressed, ["speak"]);
  h.status.clear();
});

test("buttons carry distinct colors", async () => {
  const h = host({ speak: () => {}, speakReply: () => {} });
  await h.status.begin();
  for (const c of h.claims) c.render();
  const speak = h.nodes.find((n) => n.content === "[ ●  Speak  ]");
  const reply = h.nodes.find((n) => n.content === "[ ▶  Reply  ]");
  assert.ok(speak && reply);
  assert.ok(speak.fg && reply.fg && speak.fg !== reply.fg, "colors differ per button");
  h.status.clear();
});

test("auto button reflects live state and dispatches toggle", async () => {
  let on = false;
  const pressed = [];
  const h = host(
    {
      speak: () => {},
      speakReply: () => {},
      toggleAutoSubmit: () => {
        pressed.push("auto");
        on = !on;
      },
    },
    () => ({ autoSubmit: on }),
  );
  await h.status.begin();
  for (const c of h.claims) c.render();
  const off = h.nodes.find((n) => n.content === "[ ⇄  Auto:off ]");
  assert.ok(off, "auto toggle renders with off state");
  off.onMouseUp();
  assert.deepEqual(pressed, ["auto"]);
  await new Promise((r) => setTimeout(r, 950));
  h.status.update();
  const onBtn = h.nodes.find((n) => n.content === "[ ⇄  Auto:on  ]");
  assert.ok(onBtn, "label follows live state after update");
  h.status.clear();
});
