import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { UnixSocketListener } from "../src/socket-transport.ts";

function tmpSock(tag) {
  return path.join(os.tmpdir(), `vmcp-test-${tag}-${process.pid}.sock`);
}

// Wires each accepted connection to a transport that echoes a result for any
// message it receives — mimics what main.ts does (one server per connection).
function echoListener(sock, onReceived) {
  return new UnixSocketListener(sock, (t) => {
    t.onmessage = (m) => {
      onReceived?.(m);
      t.send({ jsonrpc: "2.0", id: m.id, result: { ok: true, who: m.params?.who } });
    };
    t.start();
  });
}

function readOneMessage(client) {
  return new Promise((resolve) => {
    let buf = "";
    client.setEncoding("utf8");
    client.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
}

test("frames JSON-RPC newline-delimited and round-trips", async () => {
  const sock = tmpSock("roundtrip");
  try { fs.unlinkSync(sock); } catch {}
  const received = [];
  const listener = echoListener(sock, (m) => received.push(m));
  await listener.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  const replyP = readOneMessage(client);
  client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  const reply = await replyP;

  assert.equal(received.length, 1);
  assert.equal(received[0].method, "ping");
  assert.deepEqual(reply.result, { ok: true });

  client.destroy();
  await listener.close();
  try { fs.unlinkSync(sock); } catch {}
});

test("two messages in one write are both delivered", async () => {
  const sock = tmpSock("framing1");
  try { fs.unlinkSync(sock); } catch {}
  const received = [];
  const listener = echoListener(sock, (m) => received.push(m));
  await listener.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  client.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "pong" }) + "\n",
  );

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 2);
  assert.equal(received[0].method, "ping");
  assert.equal(received[1].method, "pong");

  client.destroy();
  await listener.close();
  try { fs.unlinkSync(sock); } catch {}
});

test("one message split across two writes is reassembled", async () => {
  const sock = tmpSock("framing2");
  try { fs.unlinkSync(sock); } catch {}
  const received = [];
  const listener = echoListener(sock, (m) => received.push(m));
  await listener.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  const full = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "split" }) + "\n";
  const mid = Math.floor(full.length / 2);
  client.write(full.slice(0, mid));
  await new Promise((r) => setTimeout(r, 20));
  client.write(full.slice(mid));

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "split");

  client.destroy();
  await listener.close();
  try { fs.unlinkSync(sock); } catch {}
});

test("CRLF line endings and blank lines are handled (shared NDJSON framer)", async () => {
  // Locks in the framing edge behavior now that the transport and the bridge
  // share one splitLines: a `\r` before the newline is stripped so JSON.parse
  // succeeds, and blank lines between messages are ignored — no divergence.
  const sock = tmpSock("crlf");
  try { fs.unlinkSync(sock); } catch {}
  const received = [];
  const errors = [];
  const listener = new UnixSocketListener(sock, (t) => {
    t.onmessage = (m) => received.push(m);
    t.onerror = (e) => errors.push(e);
    t.start();
  });
  await listener.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  client.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "crlf" }) + "\r\n" +
    "\n" +        // empty line: dropped
    "   \t\n" +   // whitespace-only line: dropped, must NOT reach JSON.parse
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "after" }) + "\r\n",
  );

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received.map((m) => m.method), ["crlf", "after"]);
  assert.deepEqual(errors, [], "blank/whitespace-only frames must not surface parse errors");

  client.destroy();
  await listener.close();
  try { fs.unlinkSync(sock); } catch {}
});

test("serves multiple concurrent clients independently (no eviction)", async () => {
  const sock = tmpSock("multiclient");
  try { fs.unlinkSync(sock); } catch {}
  const listener = echoListener(sock);
  await listener.listen();

  function pingAs(who, id) {
    return new Promise((resolve) => {
      const c = net.createConnection(sock);
      c.once("connect", () => {
        const replyP = readOneMessage(c);
        c.write(JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { who } }) + "\n");
        replyP.then((reply) => { c.destroy(); resolve(reply); });
      });
    });
  }

  // Two clients connected at the same time. With the old single-client transport
  // the second connection would destroy the first; here both must get replies.
  const [a, b] = await Promise.all([pingAs("alice", 1), pingAs("bob", 2)]);
  assert.equal(a.id, 1);
  assert.equal(a.result.who, "alice");
  assert.equal(b.id, 2);
  assert.equal(b.result.who, "bob");

  await listener.close();
  try { fs.unlinkSync(sock); } catch {}
});

test("close() drains a live connection and resolves promptly (no unload hang)", async () => {
  const sock = tmpSock("drain");
  try { fs.unlinkSync(sock); } catch {}
  const listener = echoListener(sock);
  await listener.listen();

  // A client stays connected (does not disconnect on its own).
  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));

  // net.Server.close() alone would wait for this peer to end → hang. The
  // drain in close() must destroy it so close() resolves within the timeout.
  const closed = await Promise.race([
    listener.close().then(() => "closed"),
    new Promise((r) => setTimeout(() => r("timeout"), 2000)),
  ]);
  assert.equal(closed, "closed", "listener.close() hung with a live connection");

  client.destroy();
  try { fs.unlinkSync(sock); } catch {}
});
