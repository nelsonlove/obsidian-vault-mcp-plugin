import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { UnixSocketServerTransport } from "../src/socket-transport.ts";

test("frames JSON-RPC newline-delimited and round-trips", async () => {
  const sock = path.join(os.tmpdir(), `vmcp-test-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch {}
  const t = new UnixSocketServerTransport(sock);
  const received = [];
  t.onmessage = (m) => {
    received.push(m);
    // echo a response back through the transport
    t.send({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
  };
  await t.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  const out = [];
  client.setEncoding("utf8");
  client.on("data", (d) => out.push(d));
  client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "ping");
  assert.match(out.join(""), /"result":\{"ok":true\}/);

  client.destroy();
  await t.close();
  try { fs.unlinkSync(sock); } catch { /* already gone */ }
});

test("two messages in one write are both delivered", async () => {
  const sock = path.join(os.tmpdir(), `vmcp-test-framing1-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch {}
  const t = new UnixSocketServerTransport(sock);
  const received = [];
  t.onmessage = (m) => received.push(m);
  await t.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  const m1 = { jsonrpc: "2.0", id: 1, method: "ping" };
  const m2 = { jsonrpc: "2.0", id: 2, method: "pong" };
  client.write(JSON.stringify(m1) + "\n" + JSON.stringify(m2) + "\n");

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 2);
  assert.equal(received[0].method, "ping");
  assert.equal(received[1].method, "pong");

  client.destroy();
  await t.close();
  try { fs.unlinkSync(sock); } catch { /* already gone */ }
});

test("one message split across two writes is reassembled", async () => {
  const sock = path.join(os.tmpdir(), `vmcp-test-framing2-${process.pid}.sock`);
  try { fs.unlinkSync(sock); } catch {}
  const t = new UnixSocketServerTransport(sock);
  const received = [];
  t.onmessage = (m) => received.push(m);
  await t.listen();

  const client = net.createConnection(sock);
  await new Promise((r) => client.once("connect", r));
  const msg = { jsonrpc: "2.0", id: 3, method: "split" };
  const full = JSON.stringify(msg) + "\n";
  const mid = Math.floor(full.length / 2);
  client.write(full.slice(0, mid));
  await new Promise((r) => setTimeout(r, 20));
  client.write(full.slice(mid));

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "split");

  client.destroy();
  await t.close();
  try { fs.unlinkSync(sock); } catch { /* already gone */ }
});
