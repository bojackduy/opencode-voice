import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createVieneuClient } from "../lib/sidecars/vieneu-server.js";

function fakeChild({ exitCode = 1 } = {}) {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setTimeout(() => proc.emit("exit", exitCode), 5);
  return proc;
}

function healthFetch({ healthy = true, wav = Buffer.from("RIFFwav"), ports = null } = {}) {
  return async (url) => {
    const parsed = new URL(String(url));
    if (ports && !ports.includes(Number(parsed.port))) throw new Error("ECONNREFUSED");
    if (parsed.pathname === "/health") {
      return healthy ? { ok: true, status: 200 } : { ok: false, status: 503 };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
    };
  };
}

test("adopts an already-running healthy sidecar instead of spawning", async () => {
  const spawned = [];
  const client = createVieneuClient({
    deps: {
      fetch: healthFetch(),
      spawn: (...args) => {
        spawned.push(args);
        return fakeChild();
      },
    },
    readyTimeoutMs: 200,
    readyPollMs: 20,
  });
  assert.equal(await client.start(), true, "existing sidecar is usable");
  assert.equal(client.getPort(), 8000);
  assert.equal(client.isRunning(), true);
  assert.deepEqual(spawned, [], "must not spawn a second sidecar");
  const result = await client.synthesize("xin chào");
  assert.equal(result.ok, true);
  client.stop();
  assert.equal(client.isRunning(), false);
});

test("a port that answers without a healthy /health is still a conflict", async () => {
  const spawned = [];
  const client = createVieneuClient({
    deps: {
      fetch: healthFetch({ healthy: false, ports: [8000] }),
      spawn: (bin, args) => {
        spawned.push([bin, ...args]);
        return fakeChild();
      },
    },
    readyTimeoutMs: 100,
    readyPollMs: 10,
  });
  assert.equal(await client.start(), false);
  assert.equal(client.getLastError()?.code, "MODEL_LOAD_FAILED");
  assert.equal(spawned.length, 1, "advanced to the next port and tried to start there");
});

test("object error bodies render as text, never [object Object]", async () => {
  const client = createVieneuClient({
    deps: {
      fetch: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/health") return { ok: true, status: 200 };
        // OpenAI-compatible error shape: { error: { message, type } }.
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "voice is required", type: "invalid_request" } }),
        };
      },
      spawn: () => fakeChild(),
    },
    readyTimeoutMs: 200,
    readyPollMs: 20,
  });
  assert.equal(await client.start(), true);
  const result = await client.synthesize("xin chào");
  assert.equal(result.ok, false);
  assert.equal(result.code, "BAD_STATUS");
  assert.equal(typeof result.message, "string");
  assert.ok(!result.message.includes("[object Object]"), "must not leak [object Object]");
  assert.ok(result.message.includes("voice is required"), "keeps the server's message");
  client.stop();
});
