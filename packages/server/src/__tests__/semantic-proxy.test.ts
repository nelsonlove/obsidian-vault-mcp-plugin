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
