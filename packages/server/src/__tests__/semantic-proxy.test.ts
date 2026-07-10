/**
 * semantic-proxy.test.ts — Phase 2b Task 1: connectLiveBackend
 *
 * Uses two linked InMemoryTransports: one end wired to a tiny real McpServer
 * registering two dummy tools (a stand-in for the plugin behind bridge.mjs),
 * the other end injected via the makeTransport test seam. Real MCP handshake,
 * no child process.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectLiveBackend, type LiveBackend } from "../semantic-proxy.js";

describe("connectLiveBackend (Task 1)", () => {
  let backend: LiveBackend | null = null;
  let dummyServer: McpServer | null = null;

  after(async () => {
    await backend?.close().catch(() => {});
    await dummyServer?.close().catch(() => {});
  });

  test("mirrors the live server's tools and forwards tools/call", async () => {
    // A stand-in "plugin": a real McpServer advertising two dummy tools.
    dummyServer = new McpServer(
      { name: "dummy-plugin", version: "0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    dummyServer.registerTool(
      "obsidian_dummy_read",
      { description: "dummy read", inputSchema: { path: z.string() } },
      async ({ path }) => ({
        content: [{ type: "text", text: `read:${path}` }],
      }),
    );
    dummyServer.registerTool(
      "obsidian_dummy_ping",
      { description: "dummy ping", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );

    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await dummyServer.connect(serverEnd);

    backend = await connectLiveBackend({
      bridgePath: "/unused/bridge.mjs",
      makeTransport: () => clientEnd,
    });

    // 1. Tool list mirrored
    const names = backend.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["obsidian_dummy_ping", "obsidian_dummy_read"]);

    // 2. tools/call round-trips
    const res = await backend.client.callTool({
      name: "obsidian_dummy_read",
      arguments: { path: "A.md" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].text, "read:A.md");
  });
});

// ── Tasks 2+3: mode-aware session + mid-session flip ─────────────────────────

import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createSemanticProxy } from "../semantic-proxy.js";

function makeDummyServer(names: string[]): McpServer {
  const s = new McpServer(
    { name: "dummy", version: "0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  for (const n of names) {
    s.registerTool(
      n,
      { description: `dummy ${n}`, inputSchema: {} },
      async () => ({ content: [{ type: "text", text: `ok:${n}` }] }),
    );
  }
  return s;
}

describe("createSemanticProxy (Tasks 2+3)", () => {
  test("FS mode serves FS tools; LIVE mirrors; flip emits list_changed and swaps", async () => {
    let live = false;
    const cbs: Record<string, Array<() => void>> = {};
    const presence = {
      isLive: () => live,
      on(ev: "up" | "down", cb: () => void) {
        (cbs[ev] ??= []).push(cb);
      },
      fire(ev: "up" | "down") {
        for (const cb of cbs[ev] ?? []) cb();
      },
    };

    // Seams: dummy FS server (1 tool) + dummy LIVE server (2 tools)
    const fsServer = makeDummyServer(["fs_read"]);
    const liveServer = makeDummyServer(["live_read", "live_ping"]);

    const proxy = createSemanticProxy({
      bridgePath: "/unused",
      presence,
      makeFsServer: () => fsServer,
      makeLiveTransport: () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        void liveServer.connect(s);
        return c;
      },
    });

    // Session over an in-memory pair (test seam bypasses HTTP routing)
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const session = await proxy._createSessionForTest();
    await session.server.connect(serverEnd);

    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified++;
    });
    await client.connect(clientEnd);

    // 1. FS mode: 1 FS tool, call round-trips
    let list = await client.listTools();
    assert.deepEqual(list.tools.map((t: Tool) => t.name), ["fs_read"]);
    const r1 = await client.callTool({ name: "fs_read", arguments: {} });
    assert.equal((r1.content as Array<{ text: string }>)[0].text, "ok:fs_read");

    // 2. Flip UP → list_changed emitted, list now mirrors live
    live = true;
    presence.fire("up");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(notified >= 1, "list_changed must be emitted on up");
    list = await client.listTools();
    assert.deepEqual(list.tools.map((t: Tool) => t.name).sort(), ["live_ping", "live_read"]);
    const r2 = await client.callTool({ name: "live_ping", arguments: {} });
    assert.equal((r2.content as Array<{ text: string }>)[0].text, "ok:live_ping");

    // 3. Flip DOWN → list_changed again, back to FS
    live = false;
    presence.fire("down");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(notified >= 2, "list_changed must be emitted on down");
    list = await client.listTools();
    assert.deepEqual(list.tools.map((t: Tool) => t.name), ["fs_read"]);

    await client.close();
    await proxy.stop();
    await fsServer.close().catch(() => {});
    await liveServer.close().catch(() => {});
  });
});
