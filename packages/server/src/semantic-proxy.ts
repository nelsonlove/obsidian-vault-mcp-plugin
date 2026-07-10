/**
 * semantic-proxy.ts — Phase 2b: MCP-semantic proxy building blocks.
 *
 * Phase 2a's LIVE mode is a transport-level byte passthrough — it never sees
 * tool schemas, so it cannot re-advertise a changed tool list into an existing
 * session. Phase 2b's semantic proxy instead runs its own MCP client against
 * the plugin socket (via bridge.mjs), mirrors the plugin's tools, and forwards
 * tools/call — which lets a per-session McpServer flip its tool surface and
 * emit notifications/tools/list_changed mid-session.
 *
 * Task 1 (this file's first slice): connectLiveBackend — connect to the live
 * plugin as an MCP client, fetch its tool list, expose callTool + close.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface LiveBackend {
  /** Connected MCP client — use client.callTool() to forward calls. */
  client: Client;
  /** The plugin's advertised tools at connect time. */
  tools: Tool[];
  close(): Promise<void>;
}

export async function connectLiveBackend(opts: {
  bridgePath: string;
  /** TEST SEAM: inject a client Transport; defaults to spawning bridge.mjs. */
  makeTransport?: () => Transport;
}): Promise<LiveBackend> {
  const transport =
    opts.makeTransport?.() ??
    new StdioClientTransport({
      command: process.execPath, // node
      args: [opts.bridgePath],
      // "ignore", NOT "inherit": inheriting a redirected stderr under launchd
      // EBADFs the spawn (see the Phase 2a lazy-FS fix + deploy notes).
      stderr: "ignore",
    });

  const client = new Client(
    { name: "vault-mcp-front", version: "0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client,
    tools,
    close: () => client.close(),
  };
}
