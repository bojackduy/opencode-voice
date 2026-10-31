import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createVieneuClient } from "../lib/vieneu-server.js";

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
