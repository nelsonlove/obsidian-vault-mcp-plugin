import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { splitLines, RelayState, BridgeRelay } from "../bridge/bridge.ts";

// --- splitLines: incremental NDJSON framing ---

test("splitLines: complete lines split, partial tail carried", () => {
  const r = splitLines("", '{"a":1}\n{"b":2}\n{"par');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.rest, '{"par');
});
test("splitLines: carried buffer joins next chunk", () => {
  const r = splitLines('{"par', 'tial":true}\n');
  assert.deepEqual(r.lines, ['{"partial":true}']);
  assert.equal(r.rest, "");
});
test("splitLines: blank lines dropped, CR stripped", () => {
  const r = splitLines("", '{"a":1}\r\n\n{"b":2}\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
});

// --- RelayState: handshake capture, replay, in-flight failure ---

const init = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
const initResp = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "vault-mcp" } } });
const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const call = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "obsidian_read" } });
const resp = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: {} });

function handshaken() {
  const s = new RelayState();
  s.onClientMessage(init);
  assert.equal(s.onServerMessage(initResp), true, "first initialize response is forwarded");
  s.onClientMessage(initialized);
  return s;
}

test("RelayState: replay after handshake resends initialize + initialized", () => {
  const s = handshaken();
  assert.deepEqual(s.replayMessages(), [init, initialized]);
});

test("RelayState: duplicate initialize response after replay is swallowed, once", () => {
  const s = handshaken();
  s.replayMessages();
  assert.equal(s.onServerMessage(initResp), false, "replayed handshake response must not reach the client");
  assert.equal(s.onServerMessage(initResp), true, "only one response is swallowed per replay");
});

test("RelayState: replay before any handshake is empty", () => {
  assert.deepEqual(new RelayState().replayMessages(), []);
});

test("RelayState: initialize still unanswered at disconnect — replayed, fresh response forwarded, not errored", () => {
  const s = new RelayState();
  s.onClientMessage(init); // server never answered
  assert.deepEqual(s.failOutstanding("lost"), [], "unanswered initialize is replayed, not failed");
  assert.deepEqual(s.replayMessages(), [init]);
  assert.equal(s.onServerMessage(initResp), true, "client never saw a response, so the fresh one goes through");
});

test("RelayState: failOutstanding errors in-flight requests with their method, then clears", () => {
  const s = handshaken();
  s.onClientMessage(call(7));
  const errs = s.failOutstanding("connection lost").map((l) => JSON.parse(l));
  assert.equal(errs.length, 1);
  assert.equal(errs[0].id, 7);
  assert.match(errs[0].error.message, /connection lost/);
  assert.match(errs[0].error.message, /tools\/call/);
  assert.deepEqual(s.failOutstanding("again"), [], "already-failed requests are not failed twice");
});

test("RelayState: answered requests are no longer outstanding", () => {
  const s = handshaken();
  s.onClientMessage(call(3));
  assert.equal(s.onServerMessage(resp(3)), true);
  assert.deepEqual(s.failOutstanding("lost"), []);
});

test("RelayState: server-initiated requests and notifications pass through untouched", () => {
  const s = handshaken();
  // server request whose id collides with the client's initialize id — has a method, so not a response
  assert.equal(s.onServerMessage(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "roots/list" })), true);
  assert.equal(s.onServerMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })), true);
});

test("RelayState: client responses to server requests are not tracked as outstanding", () => {
  const s = handshaken();
  s.onClientMessage(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { roots: [] } }));
  assert.deepEqual(s.failOutstanding("lost"), []);
});

test("RelayState: non-JSON lines are forwarded and ignored", () => {
  const s = new RelayState();
  s.onClientMessage("garbage");
  assert.equal(s.onServerMessage("garbage"), true);
});

test("RelayState: second replay after another disconnect works", () => {
  const s = handshaken();
  s.replayMessages();
  assert.equal(s.onServerMessage(initResp), false);
  assert.deepEqual(s.replayMessages(), [init, initialized]);
  assert.equal(s.onServerMessage(initResp), false);
  assert.equal(s.onServerMessage(initResp), true);
});

// --- BridgeRelay integration: real unix sockets, real restart ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// A fake MCP server: answers initialize and any request except ids in `ignore`.
function fakeServer(sockPath, { ignore = new Set() } = {}) {
  const state = { received: [], conns: [] };
  try { fs.rmSync(sockPath); } catch { /* first run */ }
  state.server = net.createServer((conn) => {
    state.conns.push(conn);
    let buf = "";
    conn.on("data", (chunk) => {
      const r = splitLines(buf, chunk.toString());
      buf = r.rest;
      for (const line of r.lines) {
        const msg = JSON.parse(line);
        state.received.push(msg);
        if (msg.id !== undefined && msg.method !== undefined && !ignore.has(msg.id)) {
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } }) + "\n");
        }
      }
    });
  });
  return new Promise((res) => state.server.listen(sockPath, () => res(state)));
}

function connectTo(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function pollConnect(sockPath) {
  for (;;) {
    try { return await connectTo(sockPath); } catch { await sleep(20); }
  }
}

test("BridgeRelay: survives a server restart — in-flight failed, handshake replayed, queued call flushed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-relay-"));
  const sockPath = path.join(dir, "v.sock");
  const s1 = await fakeServer(sockPath, { ignore: new Set([1]) }); // id 1 stays in flight

  const clientIn = new PassThrough();
  const out = [];
  const exits = [];
  const relay = new BridgeRelay(
    { clientIn, writeToClient: (l) => out.push(JSON.parse(l)), log: () => {}, exit: (c) => exits.push(c) },
    () => pollConnect(sockPath),
  );
  relay.start(await connectTo(sockPath));

  // Handshake, then a request the server never answers.
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  clientIn.write(initialized + "\n" + call(1) + "\n");
  await until(() => s1.received.some((m) => m.id === 1), "in-flight request to reach server");

  // Obsidian "restarts": server gone, connections severed.
  for (const c of s1.conns) c.destroy();
  await new Promise((res) => s1.server.close(res));

  // The in-flight request fails fast instead of hanging.
  await until(() => out.some((m) => m.id === 1 && m.error), "in-flight failure response");

  // A request issued while down is queued, not lost.
  clientIn.write(call(2) + "\n");
  await sleep(50);
  assert.ok(!out.some((m) => m.id === 2), "queued request must not be answered while down");

  // Server comes back; relay reconnects, replays handshake, flushes the queue.
  const s2 = await fakeServer(sockPath);
  await until(() => out.some((m) => m.id === 2 && m.result), "queued request answered after restart");

  const methods = s2.received.map((m) => m.method);
  assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"], "fresh server gets the handshake first");
  assert.ok(methods.includes("tools/call"), "queued call reaches the fresh server");
  assert.equal(out.filter((m) => m.id === 0).length, 1, "client sees exactly one initialize response");

  // Live again end to end.
  clientIn.write(call(3) + "\n");
  await until(() => out.some((m) => m.id === 3 && m.result), "post-restart request answered");
  assert.deepEqual(exits, [], "relay must not exit across a restart");

  for (const c of s2.conns) c.destroy();
  await new Promise((res) => s2.server.close(res));
  clientIn.end();
  await until(() => exits.length === 1, "exit after client EOF");
  assert.deepEqual(exits, [0]);
});

test("BridgeRelay: client EOF with live socket half-closes and exits cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-relay-"));
  const sockPath = path.join(dir, "v.sock");
  const s1 = await fakeServer(sockPath);
  const clientIn = new PassThrough();
  const out = [];
  const exits = [];
  const relay = new BridgeRelay(
    { clientIn, writeToClient: (l) => out.push(JSON.parse(l)), log: () => {}, exit: (c) => exits.push(c) },
    () => pollConnect(sockPath),
  );
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  clientIn.end();
  await until(() => exits.length === 1, "exit after client EOF");
  assert.deepEqual(exits, [0]);
  await new Promise((res) => s1.server.close(res));
});

test("BridgeRelay: reconnect failure exits 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-relay-"));
  const sockPath = path.join(dir, "v.sock");
  const s1 = await fakeServer(sockPath);
  const clientIn = new PassThrough();
  const exits = [];
  const logs = [];
  const relay = new BridgeRelay(
    { clientIn, writeToClient: () => {}, log: (m) => logs.push(m), exit: (c) => exits.push(c) },
    () => Promise.reject(new Error("reconnect deadline exhausted")),
  );
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => s1.received.length === 1, "initialize to reach server");
  for (const c of s1.conns) c.destroy();
  await new Promise((res) => s1.server.close(res));
  await until(() => exits.length === 1, "exit after failed reconnect");
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((m) => /deadline/.test(m)));
});
