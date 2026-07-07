// obsidian_resolve and obsidian_get_backlinks have been migrated to
// registerFsTools + ObsidianBackend in server.ts (fs-expressible tools).
// This file retains only obsidian_doctor and obsidian_get_active_note
// (live-only: they use workspace/app state not expressible on the filesystem).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import type { ExternalToolEntry } from "./external-tools.js";

export interface ServerCtx {
  pluginVersion: string;
  socketPath: string;
  vaultName: string;
  enabledPlugins: () => string[];
  getSettings: () => GuardSettings;
  /** Externally-published tools (other Obsidian plugins via plugin.api). Optional: absent in tests that don't exercise it. */
  getExternalTools?: () => ExternalToolEntry[];
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerCoreTools(server: McpServer, app: App, ctx: ServerCtx) {
  server.registerTool(
    "obsidian_doctor",
    {
      title: "Diagnostics",
      description: "Report vault-mcp health: socket path, bound vault, plugin version, and which integration plugins are detected. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"];
        const enabled = new Set(ctx.enabledPlugins());
        return ok({
          status: "ok",
          vault_name: ctx.vaultName,
          socket_path: ctx.socketPath,
          plugin_version: ctx.pluginVersion,
          integrations: Object.fromEntries(integrations.map((id) => [id, enabled.has(id)])),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_get_active_note",
    {
      title: "Get active note",
      description: "Return the currently focused note's path, content, and the current editor selection (if any). Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const file = app.workspace.getActiveFile();
        if (!file) return ok({ active: null });
        const content = await app.vault.read(file as TFile);
        // Selection, if a markdown editor is focused.
        let selection: string | null = null;
        const mv = app.workspace.activeEditor;
        if (mv?.editor) selection = mv.editor.getSelection() || null;
        return ok({ active: { path: file.path, content, selection } });
      } catch (e) { return fail(e); }
    }
  );
}
