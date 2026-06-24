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
  fs.unlinkSync(sock);
});
