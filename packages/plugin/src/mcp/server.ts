import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { registerFsTools } from "@vault-mcp/core";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerExternalTools } from "./external-tools.js";
import { guardCall } from "../guard.js";
import { ObsidianBackend } from "./obsidian-backend.js";

export function buildMcpServer(app: App, ctx: ServerCtx): McpServer {
  const server = new McpServer({ name: "vault-mcp", version: ctx.pluginVersion });

  // Wrap registerTool so every tool handler is guarded before registration.
  // This monkeypatch fires for ALL registerTool calls that follow, including the
  // 17 fs-expressible tools registered via registerFsTools below — because
  // registerFsTools calls server.registerTool, which is this patched version.
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

  // ── 17 fs-expressible tools — shared registry + live ObsidianBackend ────────
  // decodeHtml: false — no HTML entities expected from in-process calls.
  // includeIndexStatus omitted — Obsidian's cache is always live; read tools
  // don't need an index_status block.
  registerFsTools(server, new ObsidianBackend(app), { decodeHtml: false });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  registerVaultWriteTools(server, app);
  registerComplementaryTools(server, app, ctx);
  registerNavTools(server, app);
  registerIntegrationTools(server, app, ctx);
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  registerExternalTools(server, app, ctx);
  return server;
}
