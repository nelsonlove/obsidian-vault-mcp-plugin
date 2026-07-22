import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
  splitLines,
  RelayState,
  BridgeRelay,
  envMs,
} from "../bridge/bridge.ts";

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
  const { error, keep } = s.failRequest(call(5), "gone");
  const err = JSON.parse(error);
  assert.equal(err.id, 5);
  assert.match(err.error.message, /gone/);
  assert.equal(keep, null, "a request is answered, not kept");
  assert.deepEqual(s.failOutstanding("lost"), [], "failRequest must clear outstanding");
});

test("RelayState: failRequest keeps notifications and the unanswered initialize for re-queue", () => {
  const s = new RelayState();
  s.onClientMessage(init);
  assert.deepEqual(s.failRequest(initialized, "gone"), { error: null, keep: initialized });
  assert.deepEqual(
    s.failRequest(init, "gone"),
    { error: null, keep: init },
    "initialize is replayed, never failed",
  );
});

test("RelayState: failRequest answers a batch's requests AND keeps its notifications", () => {
  const s = handshaken();
  const batch = JSON.stringify([JSON.parse(call(8)), { jsonrpc: "2.0", method: "notifications/progress" }]);
  s.onClientMessage(batch);
  const { error, keep } = s.failRequest(batch, "gone");
  const errs = JSON.parse(error);
  assert.ok(Array.isArray(errs));
  assert.deepEqual(errs.map((e) => e.id), [8]);
  // Bug #54.3: the notification riding along in a partially-failed batch must
  // survive so it can be delivered once the vault returns — not dropped.
  const kept = JSON.parse(keep);
  assert.ok(Array.isArray(kept));
  assert.deepEqual(kept.map((m) => m.method), ["notifications/progress"]);
});

// Review finding #1: an unclassifiable line (unparseable / JSON primitive /
// empty batch) must be kept verbatim, not dropped — the client may await a
// response the fresh server would supply.
test("RelayState: failRequest keeps unparseable / primitive / empty-batch lines verbatim", () => {
  const s = handshaken();
  assert.deepEqual(s.failRequest("garbage", "gone"), { error: null, keep: "garbage" });
  assert.deepEqual(s.failRequest("42", "gone"), { error: null, keep: "42" });
  assert.deepEqual(s.failRequest("[]", "gone"), { error: null, keep: "[]" });
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

// Bug #54.1: client EOF during the reconnect grace window must not silently
// drop the queued requests the client is still awaiting.
test("BridgeRelay: client EOF mid-reconnect fails queued requests instead of dropping them", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  let resolveReconnect;
  const reconnect = () => new Promise((res) => { resolveReconnect = res; });
  const { relay, clientIn, out, exits, stop } = makeRelay(sockPath, { queueGraceMs: 60000, reconnect });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");

  await stopServer(s1);
  await until(() => resolveReconnect !== undefined, "reconnect in progress (socket down)");
  // A request queues while the vault is down (grace not yet expired).
  clientIn.write(call(5) + "\n");
  await sleep(30);
  assert.ok(!out.some((m) => m.id === 5), "request is queued, not yet answered");

  // Claude Code shuts down its stdin while we're still mid-reconnect.
  clientIn.end();
  await until(() => out.some((m) => m.id === 5 && m.error), "queued request answered on EOF, not dropped");
  await until(() => exits.length === 1, "clean exit after EOF");
  assert.deepEqual(exits, [0]);
  stop();
});

// Bug #54.2: shutdown() writes synthesized error responses then exits; with a
// real process.exit those async pipe writes are truncated and the client hangs.
// The relay must not signal exit until clientOut has flushed. We model an async
// pipe (write lands on a later tick) and assert the flush precedes the exit.
test("BridgeRelay: shutdown flushes error responses before signalling exit", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const clientIn = new PassThrough();
  const events = [];
  const clientOut = {
    write(chunk, cb) {
      setImmediate(() => { events.push("flush"); if (cb) cb(); });
      return true;
    },
  };
  let rejectReconnect;
  const relay = new BridgeRelay(
    { clientIn, clientOut, log: () => {}, exit: () => events.push("exit") },
    () => new Promise((_res, rej) => { rejectReconnect = rej; }),
    { queueGraceMs: 60000 },
  );
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => s1.received.some((m) => m.method === "initialize"), "init reached server");

  await stopServer(s1);
  await until(() => rejectReconnect !== undefined, "reconnect started");
  clientIn.write(call(5) + "\n"); // queued
  await sleep(30);
  events.length = 0; // discard handshake-response flushes
  rejectReconnect(new Error("reconnect deadline exhausted"));
  await until(() => events.includes("exit"), "shutdown exited");
  // The buggy code produced ["exit", "flush", …] (exit before the pipe drained,
  // truncating the response). The fix must put exit strictly last, after every
  // clientOut write has flushed.
  assert.equal(events.at(-1), "exit", "exit must be the final event");
  assert.ok(events.length >= 2 && events.slice(0, -1).every((e) => e === "flush"),
    "the id:5 error response must flush before exit");
  clientIn.destroy();
});

// Bug #54, plausible C: the disconnected queue was unbounded (OOM on a long
// outage with streamed notifications). It must apply backpressure like the
// connected path — pause the client when the queue fills, resume after flush.
test("BridgeRelay: disconnected queue is bounded — clientIn pauses when it fills, resumes after reconnect", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  let resolveReconnect;
  const reconnect = () => new Promise((res) => { resolveReconnect = res; });
  const { relay, clientIn, exits, stop } = makeRelay(sockPath, { queueGraceMs: 60000, maxPending: 3, reconnect });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await sleep(30);

  await stopServer(s1);
  await until(() => resolveReconnect !== undefined, "reconnect started (socket down)");
  // Flood with notifications (kept in the queue, never failed) past the cap.
  for (let i = 0; i < 10; i++) {
    clientIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { i } }) + "\n");
  }
  await until(() => clientIn.isPaused(), "clientIn paused by queue backpressure");

  const s2 = await fakeServer(sockPath);
  resolveReconnect(await connectTo(sockPath));
  await until(
    () => s2.received.filter((m) => m.method === "notifications/progress").length === 10,
    "all queued notifications delivered after reconnect",
  );
  await until(() => !clientIn.isPaused(), "clientIn resumed after flush");
  assert.deepEqual(exits, []);
  stop();
  await stopServer(s2);
});

// Bug #54, plausible D: a reconnect that resolves AFTER the client has EOF'd
// must not attach + replay the handshake against the already-dead session.
test("BridgeRelay: a reconnect resolving after client EOF does not replay against the dead session", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  let resolveReconnect;
  const reconnect = () => new Promise((res) => { resolveReconnect = res; });
  const { relay, clientIn, exits, stop } = makeRelay(sockPath, { queueGraceMs: 60000, reconnect });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await sleep(30);

  await stopServer(s1);
  await until(() => resolveReconnect !== undefined, "reconnect started");
  clientIn.end();
  await until(() => exits.length === 1, "exit on EOF");
  assert.deepEqual(exits, [0]);

  // The vault finally returns and the pending reconnect resolves — into a dead session.
  const s2 = await fakeServer(sockPath);
  resolveReconnect(await connectTo(sockPath));
  await sleep(60);
  assert.equal(
    s2.received.filter((m) => m.method === "initialize").length,
    0,
    "no handshake replay after EOF",
  );
  assert.equal(exits.length, 1, "no second exit");
  stop();
  await stopServer(s2);
});

// A server whose accepted connections cleanly die `lifeMs` after connect.
// Unlike killOnAccept (which races the client's 'connect' event), this always
// completes the handshake first, so the client sees a short-LIVED connection.
function shortLivedServer(sockPath, lifeMs) {
  const state = { conns: [] };
  try { fs.rmSync(sockPath); } catch { /* first run */ }
  state.server = net.createServer((conn) => {
    state.conns.push(conn);
    conn.on("error", () => {});
    const t = setTimeout(() => conn.destroy(), lifeMs);
    t.unref?.();
  });
  return new Promise((res) => state.server.listen(sockPath, () => res(state)));
}

// Review finding #1: the client-EOF exit path (onSocketClose, clientEnded) must
// also flush before exit — a final vault response written just before close was
// truncated by the old synchronous io.exit(0), same hazard as shutdown(). The
// server uses allowHalfOpen so it can still send after the client half-closes.
test("BridgeRelay: connected-EOF path flushes a final response before exiting", async () => {
  const sockPath = tmpSock();
  const events = [];
  const clientIn = new PassThrough();
  // Model the async stdout pipe with a timers-phase flush (setTimeout), NOT
  // setImmediate: the socket 'close' that drives this exit runs in the
  // close-callback phase, which is AFTER the check phase — a setImmediate flush
  // would always beat a synchronous exit and mask the bug. A timers-phase flush
  // lands next iteration, so a synchronous io.exit(0) races ahead of it (the
  // truncation this fix prevents).
  const clientOut = {
    write(chunk, cb) {
      setTimeout(() => { events.push("flush"); if (cb) cb(); }, 0);
      return true;
    },
  };
  let serverConn;
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    serverConn = conn;
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      for (const line of splitLines("", chunk.toString()).lines) {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          conn.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        }
      }
    });
  });
  await new Promise((res) => server.listen(sockPath, res));
  const relay = new BridgeRelay(
    { clientIn, clientOut, log: () => {}, exit: () => events.push("exit") },
    () => new Promise(() => {}), // reconnect never resolves; the EOF path returns first
    {},
  );
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => events.length >= 1, "initialize response forwarded");
  clientIn.end();          // clientEnded = true; bridge half-closes its write side
  await until(() => serverConn, "server accepted the connection");
  await sleep(20);
  events.length = 0;       // ignore the handshake flush
  serverConn.write(JSON.stringify({ jsonrpc: "2.0", id: 77, result: { ok: true } }) + "\n");
  serverConn.end();        // flush the response, then FIN → onSocketClose(clientEnded)
  await until(() => events.includes("exit"), "exit after connected EOF", 3000);
  assert.equal(events.at(-1), "exit", "exit must be the final event");
  assert.ok(events.length >= 2 && events.slice(0, -1).every((e) => e === "flush"),
    "the final response must flush before exit");
  clientIn.destroy();
  await new Promise((res) => server.close(res));
});

// The give-up guard is keyed on per-connection lifetime, so a crash-loop with
// SLOW reconnects (deaths far apart in wall-clock time) still trips it — the
// signal is "connections keep dying young", independent of reconnect latency.
test("BridgeRelay: slow-reconnect crash-loop trips the give-up guard on lifetime", async () => {
  const sockPath = tmpSock();
  const srv = await shortLivedServer(sockPath, 10); // each connection dies ~10ms after connect
  const reconnect = async () => { await sleep(150); return connectTo(sockPath); };
  // Deaths are ~150ms+ apart, but each connection lived only ~10ms < 40ms
  // window → the consecutive-short-lived counter trips regardless of spacing.
  const { relay, exits, logs, stop } = makeRelay(sockPath, {
    rapidFailMax: 3, rapidFailWindowMs: 40, reconnect,
  });
  relay.start(await connectTo(sockPath));
  await until(() => exits.length === 1, "give up on slow crash-loop", 5000);
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((m) => /unhealthy/.test(m)));
  stop();
  await new Promise((r) => srv.server.close(r));
});

// Review-2 finding #0: a HEALTHY vault merely restarted several times in quick
// succession (each reconnect serving traffic) must NOT be torn down — only
// young-death crash loops are. The death-spacing signal was removed for this.
test("BridgeRelay: rapid healthy restarts do not trip the give-up guard", async () => {
  const sockPath = tmpSock();
  // Each connection lives 80ms (> the 40ms window) → healthy; 5 of them within
  // ~1s would have tripped a death-spacing guard, but must not trip this one.
  const srv = await shortLivedServer(sockPath, 80);
  const reconnect = async () => { await sleep(5); return connectTo(sockPath); };
  const { relay, exits, stop } = makeRelay(sockPath, {
    rapidFailMax: 3, rapidFailWindowMs: 40, reconnect,
  });
  relay.start(await connectTo(sockPath));
  await sleep(600); // ~6 connect/serve/die cycles
  assert.deepEqual(exits, [], "a healthy but frequently-restarted vault must not be torn down");
  stop();
  await new Promise((r) => srv.server.close(r));
});

// Review finding #3: maxPending=0 is an opt-out (unbounded), not "pause on the
// first line and never resume".
test("BridgeRelay: maxPending=0 disables the cap and never pauses the client", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  let resolveReconnect;
  const reconnect = () => new Promise((res) => { resolveReconnect = res; });
  const { relay, clientIn, stop } = makeRelay(sockPath, { queueGraceMs: 60000, maxPending: 0, reconnect });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await sleep(30);
  await stopServer(s1);
  await until(() => resolveReconnect !== undefined, "reconnect started");
  for (let i = 0; i < 20; i++) {
    clientIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { i } }) + "\n");
  }
  await sleep(50);
  assert.equal(clientIn.isPaused(), false, "maxPending=0 must never pause the client");
  stop();
});

// Review finding #5: shutdown must still terminate even if the client stops
// draining stdout (the flush callback would never fire) — a timeout backstop.
test("BridgeRelay: shutdown force-exits when the client stops draining stdout", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const clientIn = new PassThrough();
  const exits = [];
  // A stalled pipe: writes never invoke their callback.
  const clientOut = { write() { return false; } };
  let rejectReconnect;
  const relay = new BridgeRelay(
    { clientIn, clientOut, log: () => {}, exit: (c) => exits.push(c) },
    () => new Promise((_res, rej) => { rejectReconnect = rej; }),
    { queueGraceMs: 60000, exitFlushTimeoutMs: 40 },
  );
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await stopServer(s1);
  await until(() => rejectReconnect !== undefined, "reconnect started");
  rejectReconnect(new Error("reconnect deadline exhausted"));
  await until(() => exits.length === 1, "force-exit despite a stalled stdout", 2000);
  assert.deepEqual(exits, [1]);
  clientIn.destroy();
});

// Review-2 finding #2: past the grace budget, a request must still be fast-failed
// even when the client is streaming a notification flood — the flood must not
// pause stdin (backpressure) and starve the fast-fail path.
test("BridgeRelay: post-grace, a request is fast-failed behind a notification flood", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  // Small cap + short grace: without the fix, the flood would pause stdin at 3.
  const { relay, clientIn, out, stop } = makeRelay(sockPath, {
    queueGraceMs: 40, maxPending: 3, reconnect: () => new Promise(() => {}),
  });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  await stopServer(s1);
  // Let the grace window expire (nothing queued yet).
  await until(() => clientIn.isPaused() === false, "still reading");
  await sleep(80); // > queueGraceMs → graceExpired
  for (let i = 0; i < 20; i++) {
    clientIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { i } }) + "\n");
  }
  clientIn.write(call(99) + "\n");
  await until(() => out.some((m) => m.id === 99 && m.error), "request fast-failed despite the flood");
  assert.equal(clientIn.isPaused(), false, "the notification flood must not pause the client");
  stop();
});

// Review-3 finding #1: a flood that pauses stdin BEFORE grace expiry must not
// leave it paused afterwards — otherwise the client can't send the request that
// grace-expiry exists to fast-fail, and it hangs for the whole reconnect window.
test("BridgeRelay: stdin paused by a pre-grace flood is resumed at grace expiry", async () => {
  const sockPath = tmpSock();
  const s1 = await fakeServer(sockPath);
  const { relay, clientIn, out, stop } = makeRelay(sockPath, {
    queueGraceMs: 150, maxPending: 3, reconnect: () => new Promise(() => {}),
  });
  relay.start(await connectTo(sockPath));
  clientIn.write(init + "\n");
  await until(() => out.length === 1, "initialize response");
  await stopServer(s1);
  // Flood DURING the grace window → pending fills to the cap → stdin pauses.
  for (let i = 0; i < 12; i++) {
    clientIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { i } }) + "\n");
  }
  await until(() => clientIn.isPaused(), "stdin paused by the pre-grace flood");
  // Grace expires: the retained notification queue is still full, but stdin must
  // resume anyway so the client's next request can be fast-failed.
  await until(() => clientIn.isPaused() === false, "stdin resumed at grace expiry", 2000);
  clientIn.write(call(99) + "\n");
  await until(() => out.some((m) => m.id === 99 && m.error), "post-grace request fast-failed, not hung");
  stop();
});
