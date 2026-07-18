import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { splitLines, RelayState, BridgeRelay, envMs } from "../bridge/bridge.ts";

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

// --- envMs: environment knob parsing ---

test("envMs: unset and empty use the default (empty must not become 0)", () => {
  assert.equal(envMs(undefined, 300), 300);
  assert.equal(envMs("", 300), 300);
});
test("envMs: non-numeric uses the default (never NaN)", () => {
  assert.equal(envMs("5m", 300), 300);
});
test("envMs: explicit numbers win, including 0 as an opt-out", () => {
  assert.equal(envMs("1500", 300), 1500);
  assert.equal(envMs("0", 300), 0);
});

// --- RelayState: handshake capture, replay, in-flight failure ---

const init = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
const initResp = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "vault" } } });
const initErrResp = JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32602, message: "unsupported protocolVersion" } });
const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const call = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read" } });
const resp = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: {} });

function handshaken() {
  const s = new RelayState();
  s.onClientMessage(init);
  assert.equal(s.onServerMessage(initResp), "forward", "first initialize response is forwarded");
  s.onClientMessage(initialized);
  return s;
}

test("RelayState: replay after handshake resends initialize + initialized", () => {
  const s = handshaken();
  assert.deepEqual(s.replayMessages(), [init, initialized]);
});

test("RelayState: duplicate initialize SUCCESS after replay is dropped, once", () => {
  const s = handshaken();
  s.replayMessages();
  assert.equal(s.onServerMessage(initResp), "drop", "replayed handshake response must not reach the client");
  assert.equal(s.onServerMessage(initResp), "forward", "only one response is swallowed per replay");
});

test("RelayState: ERROR response to a replayed initialize is surfaced, not hidden", () => {
  const s = handshaken();
  s.replayMessages();
  assert.equal(s.onServerMessage(initErrResp), "replay-error");
});

test("RelayState: replay before any handshake is empty", () => {
  assert.deepEqual(new RelayState().replayMessages(), []);
});

test("RelayState: initialize still unanswered at disconnect — replayed, fresh response forwarded, not errored", () => {
  const s = new RelayState();
  s.onClientMessage(init); // server never answered
  assert.deepEqual(s.failOutstanding("lost"), [], "unanswered initialize is replayed, not failed");
  assert.deepEqual(s.replayMessages(), [init]);
  assert.equal(s.onServerMessage(initResp), "forward", "client never saw a response, so the fresh one goes through");
});

test("RelayState: id:null error response cannot poison the uncaptured initialize sentinel", () => {
  const s = new RelayState();
  // JSON-RPC parse-error responses carry id:null; before initialize is
  // captured the sentinel must not treat them as the initialize response.
  assert.equal(s.onServerMessage(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })), "forward");
  s.onClientMessage(init);
  assert.deepEqual(s.failOutstanding("lost"), [], "initialize must still be exempt (initResponseSeen must not be poisoned)");
  assert.deepEqual(s.replayMessages(), [init]);
  assert.equal(s.onServerMessage(initResp), "forward", "fresh response must be forwarded, not swallowed");
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

test("RelayState: batched requests are tracked and failed on disconnect", () => {
  const s = handshaken();
  s.onClientMessage(JSON.stringify([JSON.parse(call(8)), JSON.parse(call(9)), { jsonrpc: "2.0", method: "notifications/progress" }]));
  const errs = s.failOutstanding("lost").map((l) => JSON.parse(l));
  assert.deepEqual(errs.map((e) => e.id).sort(), [8, 9]);
});

test("RelayState: batched server responses resolve outstanding requests", () => {
  const s = handshaken();
  s.onClientMessage(JSON.stringify([JSON.parse(call(8)), JSON.parse(call(9))]));
  assert.equal(s.onServerMessage(JSON.stringify([JSON.parse(resp(8)), JSON.parse(resp(9))])), "forward");
  assert.deepEqual(s.failOutstanding("lost"), []);
});

test("RelayState: failRequest errors a single request and removes it from outstanding", () => {
  const s = handshaken();
  s.onClientMessage(call(5));
  const err = JSON.parse(s.failRequest(call(5), "gone"));
  assert.equal(err.id, 5);
  assert.match(err.error.message, /gone/);
  assert.deepEqual(s.failOutstanding("lost"), [], "failRequest must clear outstanding");
});

test("RelayState: failRequest returns null for notifications and unanswered initialize", () => {
  const s = new RelayState();
  s.onClientMessage(init);
  assert.equal(s.failRequest(initialized, "gone"), null);
  assert.equal(s.failRequest(init, "gone"), null, "initialize is replayed, never failed");
});

test("RelayState: failRequest answers a batch with a batch of errors", () => {
  const s = handshaken();
  const batch = JSON.stringify([JSON.parse(call(8)), { jsonrpc: "2.0", method: "notifications/progress" }]);
  s.onClientMessage(batch);
  const errs = JSON.parse(s.failRequest(batch, "gone"));
  assert.ok(Array.isArray(errs));
  assert.deepEqual(errs.map((e) => e.id), [8]);
});

test("RelayState: answered requests are no longer outstanding", () => {
  const s = handshaken();
  s.onClientMessage(call(3));
  assert.equal(s.onServerMessage(resp(3)), "forward");
  assert.deepEqual(s.failOutstanding("lost"), []);
});

test("RelayState: server-initiated requests and notifications pass through untouched", () => {
  const s = handshaken();
  // server request whose id collides with the client's initialize id — has a method, so not a response
  assert.equal(s.onServerMessage(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "roots/list" })), "forward");
  assert.equal(s.onServerMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })), "forward");
});

test("RelayState: client responses to server requests are not tracked as outstanding", () => {
  const s = handshaken();
  s.onClientMessage(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { roots: [] } }));
  assert.deepEqual(s.failOutstanding("lost"), []);
});

test("RelayState: non-JSON lines are forwarded and ignored", () => {
  const s = new RelayState();
  s.onClientMessage("garbage");
  assert.equal(s.onServerMessage("garbage"), "forward");
});

test("RelayState: second replay after another disconnect works", () => {
  const s = handshaken();
  s.replayMessages();
  assert.equal(s.onServerMessage(initResp), "drop");
  assert.deepEqual(s.replayMessages(), [init, initialized]);
  assert.equal(s.onServerMessage(initResp), "drop");
  assert.equal(s.onServerMessage(initResp), "forward");
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

// Short socket paths: macOS caps unix socket paths at 104 bytes.
let sockCounter = 0;
function tmpSock() {
  const dir = fs.mkdtempSync("/tmp/relay-");
  return path.join(dir, `${sockCounter++}.sock`);
}

// A fake MCP server: answers initialize and any request except ids in `ignore`.
// `killOnAccept` destroys every new connection immediately (crash-loop mode).
function fakeServer(sockPath, { ignore = new Set() } = {}) {
  const state = { received: [], conns: [], killOnAccept: false };
  try { fs.rmSync(sockPath); } catch { /* first run */ }
  state.server = net.createServer((conn) => {
    if (state.killOnAccept) { conn.destroy(); return; }
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
    conn.on("error", () => {});
  });
  return new Promise((res) => state.server.listen(sockPath, () => res(state)));
}

async function stopServer(s) {
  for (const c of s.conns) c.destroy();
  await new Promise((res) => s.server.close(res));
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

// Collect parsed NDJSON lines written to a stream.
function collect(stream) {
  const out = [];
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines.filter(Boolean)) out.push(JSON.parse(l));
  });
  return out;
}

function makeRelay(sockPath, opts = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const out = collect(clientOut);
  const exits = [];
  const logs = [];
  // Stoppable reconnect: a relay left mid-reconnect at test end would
  // otherwise poll forever and keep the test runner's event loop alive.
  const torn = { down: false };
  const reconnect =
    opts.reconnect ??
    (async () => {
      for (;;) {
        if (torn.down) throw new Error("test torn down");
        try { return await connectTo(sockPath); } catch { await sleep(20); }
      }
    });
  const relay = new BridgeRelay(
    { clientIn, clientOut, log: (m) => logs.push(m), exit: (c) => exits.push(c) },
    reconnect,
    opts,
  );
  return { relay, clientIn, out, exits, logs, stop: () => { torn.down = true; } };
}

test("BridgeRelay: survives a server restart — in-flight failed, handshake replayed, queued call flushed", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath, { ignore: new Set([1]) }); // id 1 stays in flight
  const { relay, clientIn, out, exits, stop } = makeRelay(sockPath);
  relay.start(await connectTo(sockPath));

  // Handshake, then a request the server never answers.
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  clientIn.write(initialized + "\n" + call(1) + "\n");
  await until(() => s1.received.some((m) => m.id === 1), "in-flight request to reach server");

  // Obsidian "restarts": server gone, connections severed.
  await stopServer(s1);

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

  clientIn.end();
  await until(() => exits.length === 1, "exit after client EOF");
  assert.deepEqual(exits, [0]);
  stop();
  await stopServer(s2);
});

test("BridgeRelay: multi-byte characters split across socket chunks arrive intact", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, stop } = makeRelay(sockPath);
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");

  // Send a response whose emoji straddles a write boundary.
  const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 42, result: { text: "café 📎 βeta" } }) + "\n");
  const cut = line.indexOf(Buffer.from("📎")) + 2; // split INSIDE the 4-byte emoji
  const conn = s1.conns[0];
  conn.write(line.subarray(0, cut));
  await sleep(30);
  conn.write(line.subarray(cut));
  await until(() => out.some((m) => m.id === 42), "split response");
  assert.equal(out.find((m) => m.id === 42).result.text, "café 📎 βeta");
  stop();
  await stopServer(s1);
});

test("BridgeRelay: handshake sent while the vault is down is delivered exactly once", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, stop } = makeRelay(sockPath);
  relay.start(await connectTo(sockPath));

  // Vault dies BEFORE the client ever sends initialize.
  await stopServer(s1);
  clientIn.write(init + "\n");
  await sleep(50);

  const s2 = await fakeServer(sockPath);
  await until(() => out.some((m) => m.id === 0), "initialize answered after reconnect");
  assert.equal(s2.received.filter((m) => m.method === "initialize").length, 1, "initialize must not be sent twice (replay + queue)");
  assert.equal(out.filter((m) => m.id === 0).length, 1, "client sees exactly one response");
  stop();
  await stopServer(s2);
});

test("BridgeRelay: queued requests fail after the grace budget, then recover on reconnect", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, stop } = makeRelay(sockPath, { queueGraceMs: 100 });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");

  await stopServer(s1);
  clientIn.write(call(5) + "\n");
  await until(() => out.some((m) => m.id === 5 && m.error), "queued request failed after grace", 2000);

  // Past the grace budget, NEW requests fail immediately.
  clientIn.write(call(6) + "\n");
  await until(() => out.some((m) => m.id === 6 && m.error), "post-grace request failed fast");

  // The vault returns; traffic flows again.
  const s2 = await fakeServer(sockPath);
  await until(() => s2.received.some((m) => m.method === "initialize"), "handshake replayed");
  clientIn.write(call(7) + "\n");
  await until(() => out.some((m) => m.id === 7 && m.result), "request answered after recovery");
  stop();
  await stopServer(s2);
});

test("BridgeRelay: crash-looping server trips the rapid-failure guard and exits 1", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, exits, logs, stop } = makeRelay(sockPath, { rapidFailMax: 3 });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");

  // Listener stays up but murders every connection: reconnects "succeed" then die.
  s1.killOnAccept = true;
  for (const c of s1.conns) c.destroy();

  await until(() => exits.length === 1, "exit after repeated rapid failures", 10000);
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((m) => /giving up/.test(m)));
  stop();
  await stopServer(s1);
});

test("BridgeRelay: unterminated final client line is flushed on EOF, then clean exit", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, exits, stop } = makeRelay(sockPath);
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  clientIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" })); // no trailing newline
  clientIn.end();
  await until(() => s1.received.some((m) => m.method === "notifications/cancelled"), "unterminated line delivered");
  await until(() => exits.length === 1, "exit after client EOF");
  assert.deepEqual(exits, [0]);
  stop();
  await stopServer(s1);
});

test("BridgeRelay: reconnect failure exits 1 and answers queued requests", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, exits, logs } = makeRelay(sockPath, {
    reconnect: () => Promise.reject(new Error("reconnect deadline exhausted")),
  });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  // Race-free queueing isn't possible here (the reject fires immediately), but
  // shutdown() must still answer anything that made it into the queue.
  await stopServer(s1);
  await until(() => exits.length === 1, "exit after failed reconnect");
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((m) => /deadline/.test(m)));
});
