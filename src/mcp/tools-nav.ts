import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, MarkdownView } from "obsidian";
import { ok, fail } from "./helpers.js";

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ── internal-API helpers ──────────────────────────────────────────────────────
// All access to `internalPlugins`, `internalPlugins.getPluginById`, `.instance.*`,
// `app.plugins.enablePlugin / disablePlugin` is internal / undocumented; cast to
// `any` with a comment at each site.

/** Resolve the "workspaces" internal plugin instance, or null if not enabled. */
function workspacesPlugin(app: App) {
  // internalPlugins is internal — not in public obsidian types.
  return (app as any).internalPlugins?.getPluginById("workspaces")?.instance ?? null;
}

/** Resolve the "bookmarks" internal plugin instance, or null if not enabled. */
function bookmarksPlugin(app: App) {
  // internalPlugins is internal — not in public obsidian types.
  return (app as any).internalPlugins?.getPluginById("bookmarks")?.instance ?? null;
}

// ── Bookmark item shape (internal) ───────────────────────────────────────────
interface BookmarkItem {
  type: string;
  title?: string;
  path?: string;
  items?: BookmarkItem[]; // groups can contain nested items
}

/** Flatten a bookmark tree into a list of leaf items. */
function flattenBookmarks(items: BookmarkItem[]): Array<{ title: string; type: string; path?: string }> {
  const result: Array<{ title: string; type: string; path?: string }> = [];
  for (const item of items) {
    if (item.type === "group" && item.items) {
      result.push(...flattenBookmarks(item.items));
    } else {
      result.push({
        title: item.title ?? item.path ?? "",
        type: item.type,
        path: item.path,
      });
    }
  }
  return result;
}

export function registerNavTools(server: McpServer, app: App) {

  // ── obsidian_jump_to ────────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_jump_to",
    {
      title: "Jump to location in a note",
      description:
        "Open a note and scroll to a heading, block reference, or line number. Supply at most one of heading / block / line. Returns {path, jumped:true}.",
      inputSchema: {
        path:    z.string().min(1).describe("Vault-relative path of the note."),
        heading: z.string().optional().describe("Heading text to scroll to (no leading #)."),
        block:   z.string().optional().describe("Block ID to scroll to (no leading ^)."),
        line:    z.number().int().min(1).optional().describe("1-based line number to jump to."),
      },
      annotations: RW,
    },
    async ({ path: p, heading, block, line }) => {
      try {
        // Build the link fragment for heading / block anchors.
        let fragment = "";
        if (heading) fragment = `#${heading}`;
        else if (block) fragment = `#^${block}`;

        // openLinkText handles fragment scrolling natively.
        await app.workspace.openLinkText(p + fragment, "", false);

        // For plain line jumps, move the cursor after the file is open.
        if (line !== undefined) {
          const view = app.workspace.getActiveViewOfType(MarkdownView);
          if (view?.editor) {
            const zeroLine = line - 1;
            view.editor.setCursor({ line: zeroLine, ch: 0 });
            view.editor.scrollIntoView({ from: { line: zeroLine, ch: 0 }, to: { line: zeroLine, ch: 0 } }, true);
          }
        }

        return ok({ path: p, jumped: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_toggle_view_mode ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_toggle_view_mode",
    {
      title: "Toggle view mode",
      description:
        "Switch the active MarkdownView (or the one showing path) to source, preview, or live-preview mode. Returns {mode}.",
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path to target; omit for the currently-active leaf."),
        mode: z.enum(["source", "preview", "live"]).describe('"source" = source mode, "preview" = reading view, "live" = live preview.'),
      },
      annotations: RW,
    },
    async ({ path: p, mode }) => {
      try {
        // Locate the MarkdownView to target.
        let view: MarkdownView | null = null;

        if (p) {
          // Iterate leaves to find one showing the requested path.
          // iterateAllLeaves is public; the leaf's view type guard is safe.
          app.workspace.iterateAllLeaves((leaf) => {
            if (view) return;
            const v = leaf.view;
            if (v instanceof MarkdownView && v.file?.path === p) {
              view = v;
            }
          });
          if (!view) {
            // Open the file if it isn't already visible.
            await app.workspace.openLinkText(p, "", false);
            view = app.workspace.getActiveViewOfType(MarkdownView);
          }
        } else {
          view = app.workspace.getActiveViewOfType(MarkdownView);
        }

        if (!view) return fail(new Error("No MarkdownView available"));

        // setViewState shape: { state: { mode, source } }
        // "source" mode: { mode: "source", source: true }
        // "preview" mode: { mode: "preview", source: false }
        // "live" mode: { mode: "source", source: false }  (live preview is "source" without CM source toggle)
        // leaf.setViewState is public API.
        const leaf = (view as MarkdownView).leaf;
        const curState = leaf.getViewState();
        const newState = {
          ...curState,
          state: {
            ...curState.state,
            mode:   mode === "preview" ? "preview" : "source",
            source: mode === "source",
          },
        };
        await leaf.setViewState(newState);

        return ok({ mode });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_workspace ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_workspace",
    {
      title: "Open a saved workspace layout",
      description: "Load a named Obsidian workspace layout (requires the core Workspaces plugin to be enabled). Returns {name, opened:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Workspace name to load."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // loadWorkspace is internal — not in public obsidian types.
        (instance as any).loadWorkspace(name);
        return ok({ name, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_save_workspace ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_save_workspace",
    {
      title: "Save current layout as a workspace",
      description: "Save the current Obsidian layout under a name (requires the core Workspaces plugin). Returns {name, saved:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Workspace name to save/overwrite."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // saveWorkspace is internal — not in public obsidian types.
        (instance as any).saveWorkspace(name);
        return ok({ name, saved: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_list_workspaces ────────────────────────────────────────────────
  server.registerTool(
    "obsidian_list_workspaces",
    {
      title: "List saved workspace layouts",
      description: "List all saved workspace layout names (requires the core Workspaces plugin). Read-only. Returns {workspaces: string[]}.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // instance.workspaces is a Record<string, unknown> — internal.
        const workspaces = Object.keys((instance as any).workspaces ?? {});
        return ok({ workspaces });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_periodic_note ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_periodic_note",
    {
      title: "Open or create a periodic note",
      description:
        "Open or create a daily / weekly / monthly note. Prefers the community Periodic Notes plugin if enabled; falls back to the core Daily Notes plugin for kind='daily'. Returns {kind, path, created}. FLAG: live verification required — Periodic Notes plugin API shape varies by version.",
      inputSchema: {
        kind:   z.enum(["daily", "weekly", "monthly"]).default("daily"),
        action: z.enum(["open", "create"]).default("open"),
      },
      annotations: RW,
    },
    async ({ kind, action }) => {
      try {
        // Prefer community Periodic Notes plugin.
        // app.plugins.plugins is internal — not in public obsidian types.
        const periodicPlugin = (app as any).plugins?.plugins?.["periodic-notes"];
        if (periodicPlugin) {
          // The Periodic Notes plugin exposes per-granularity APIs; shape varies by version.
          // Attempt the v0.0.17+ approach: plugin.openNote(granularity, moment()).
          // granularity strings: "day", "week", "month"
          const granularity = kind === "daily" ? "day" : kind === "weekly" ? "week" : "month";
          const pluginInstance = periodicPlugin as any;
          if (typeof pluginInstance.openNote === "function") {
            const file = await pluginInstance.openNote(granularity);
            return ok({ kind, path: file?.path ?? null, created: action === "create" });
          }
          // Fallback: use commands to open/create via Obsidian command system.
          // Command IDs follow the pattern: "periodic-notes:open-<granularity>-note"
          const cmdId = `periodic-notes:open-${granularity}-note`;
          const executed = (app as any).commands?.executeCommandById(cmdId) as boolean | undefined;
          if (executed !== false) return ok({ kind, path: null, created: false });
        }

        // Fall back to core Daily Notes plugin (only supports daily).
        if (kind !== "daily") {
          return fail(new Error(`kind='${kind}' requires the Periodic Notes community plugin`));
        }

        // Core Daily Notes: prefer the internal plugin's createNewDailyNote() / openDailyNote().
        // internalPlugins is internal — not in public obsidian types.
        const dailyInstance = (app as any).internalPlugins?.getPluginById("daily-notes")?.instance as any;
        if (dailyInstance) {
          if (action === "create" && typeof dailyInstance.createNewDailyNote === "function") {
            const file = await dailyInstance.createNewDailyNote();
            return ok({ kind, path: file?.path ?? null, created: true });
          }
          // openDailyNote opens or creates and navigates.
          if (typeof dailyInstance.openDailyNote === "function") {
            await dailyInstance.openDailyNote();
            const active = app.workspace.getActiveFile();
            return ok({ kind, path: active?.path ?? null, created: false });
          }
        }

        // Last resort: run the daily-notes command.
        (app as any).commands?.executeCommandById("daily-notes");
        const active = app.workspace.getActiveFile();
        return ok({ kind, path: active?.path ?? null, created: false });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_bookmark ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_bookmark",
    {
      title: "Open a bookmark",
      description: "Open a bookmarked file by its title (requires the core Bookmarks plugin). Returns {name, opened:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Bookmark title (exact match)."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = bookmarksPlugin(app);
        if (!instance) return fail(new Error("bookmarks plugin not enabled"));

        // instance.items holds the bookmark tree — internal, not in public types.
        const items: BookmarkItem[] = (instance as any).items ?? [];
        const flat = flattenBookmarks(items);
        const bm = flat.find((b) => b.title === name);
        if (!bm) return fail(new Error(`bookmark not found: ${name}`));
        if (!bm.path) return fail(new Error(`bookmark '${name}' has no file path (not a file bookmark)`));

        await app.workspace.openLinkText(bm.path, "", false);
        return ok({ name, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_list_bookmarks ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_list_bookmarks",
    {
      title: "List bookmarks",
      description: "Return all bookmarks as a flat list of {title, type, path?} (requires the core Bookmarks plugin). Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const instance = bookmarksPlugin(app);
        if (!instance) return fail(new Error("bookmarks plugin not enabled"));

        // instance.items or instance.getBookmarks() — internal; prefer items directly.
        const items: BookmarkItem[] =
          typeof (instance as any).getBookmarks === "function"
            ? (instance as any).getBookmarks()
            : ((instance as any).items ?? []);

        const bookmarks = flattenBookmarks(items);
        return ok({ count: bookmarks.length, bookmarks });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_plugin_toggle ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_plugin_toggle",
    {
      title: "Enable or disable a community plugin",
      description: "Enable or disable a community plugin by its ID. Returns {plugin_id, enabled}.",
      inputSchema: {
        plugin_id: z.string().min(1).describe("Community plugin ID, e.g. 'dataview'."),
        enabled:   z.boolean().describe("true to enable, false to disable."),
      },
      annotations: RW,
    },
    async ({ plugin_id, enabled }) => {
      try {
        // Don't let the MCP disable its own host plugin — it would tear down
        // this connection mid-response. Use Obsidian's settings to disable.
        if (!enabled && plugin_id === "vault-mcp") {
          return fail(new Error("refusing to disable vault-mcp via MCP (it hosts this connection); use Obsidian settings"));
        }
        // app.plugins.enablePlugin / disablePlugin are internal — not in public obsidian types.
        const plugins = (app as any).plugins;
        if (!plugins) return fail(new Error("community plugins manager not available"));
        if (enabled) {
          await (plugins as any).enablePlugin(plugin_id);
        } else {
          await (plugins as any).disablePlugin(plugin_id);
        }
        return ok({ plugin_id, enabled });
      } catch (e) { return fail(e); }
    }
  );
}
