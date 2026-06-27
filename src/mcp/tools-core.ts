import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import type { GuardSettings } from "../guard.js";

export interface ServerCtx {
  pluginVersion: string;
  socketPath: string;
  vaultName: string;
  enabledPlugins: () => string[];
  getSettings: () => GuardSettings;
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

  server.registerTool(
    "obsidian_resolve",
    {
      title: "Resolve link reference",
      description: "Resolve a wikilink/path/basename to a canonical vault path using Obsidian's own resolver. Read-only.",
      inputSchema: {
        ref: z.string().min(1).describe("Link text, basename, or path, e.g. '[[Roadmap]]' or 'Roadmap'."),
        from: z.string().optional().describe("Source note path for context-sensitive resolution."),
      },
      annotations: RO,
    },
    async ({ ref, from }) => {
      try {
        const clean = ref.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0];
        const dest = app.metadataCache.getFirstLinkpathDest(clean, from ?? "");
        return ok({ ref, resolved: dest ? dest.path : null });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_get_backlinks",
    {
      title: "Get backlinks",
      description: "List notes that link TO the given note, from Obsidian's live metadata cache (canonical — resolves aliases, embeds, block refs). Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the target note."),
      },
      annotations: RO,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!file) return fail(new Error(`not found: ${p}`));
        // getBacklinksForFile is not in the public obsidian type defs — cast required.
        // The {data: Map<path, ReferenceCache[]>} return shape is an assumption to be verified live in M1.9.
        const bl = (app.metadataCache as any).getBacklinksForFile(file);
        const sources = bl?.data ? Array.from(bl.data.keys()) : [];
        return ok({ path: p, backlink_count: sources.length, backlinks: sources });
      } catch (e) { return fail(e); }
    }
  );
}
