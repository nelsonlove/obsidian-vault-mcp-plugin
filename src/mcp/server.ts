import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultReadTools } from "./tools-vault-read.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerComplementaryTools } from "./tools-complementary.js";

export function buildMcpServer(app: App, ctx: ServerCtx): McpServer {
  const server = new McpServer({ name: "vault-mcp", version: ctx.pluginVersion });
  registerCoreTools(server, app, ctx);
  registerVaultReadTools(server, app);
  registerVaultWriteTools(server, app);
  registerComplementaryTools(server, app, ctx);
  return server;
}
