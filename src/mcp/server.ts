import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";

export function buildMcpServer(app: App, ctx: ServerCtx): McpServer {
  const server = new McpServer({ name: "vault-mcp", version: ctx.pluginVersion });
  registerCoreTools(server, app, ctx);
  return server;
}
