import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultReadTools } from "./tools-vault-read.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { guardCall } from "../guard.js";

export function buildMcpServer(app: App, ctx: ServerCtx): McpServer {
  const server = new McpServer({ name: "vault-mcp", version: ctx.pluginVersion });

  // Wrap registerTool so every tool handler is guarded before registration.
  // Cast origRegister to any to bypass overload signature checking on the wrapped handler.
  const origRegister: any = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, def: any, handler: any) =>
    origRegister(name, def, async (args: any, extra: any) => {
      const isMutating = def?.annotations?.readOnlyHint === false;
      const blocked = guardCall({ isMutating, args: args ?? {}, settings: ctx.getSettings() });
      if (blocked) {
        return { content: [{ type: "text" as const, text: `Error [${blocked.code}]: ${blocked.message}` }], isError: true as const };
      }
      return handler(args, extra);
    });

  registerCoreTools(server, app, ctx);
  registerVaultReadTools(server, app);
  registerVaultWriteTools(server, app);
  registerComplementaryTools(server, app, ctx);
  registerNavTools(server, app);
  registerIntegrationTools(server, app, ctx);
  return server;
}
