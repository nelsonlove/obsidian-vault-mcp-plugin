import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import type { ServerCtx } from "./tools-core.js";

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ── Dataview value serialization ───────────────────────────────────────────────
// Dataview result values may be Link objects, arrays, dates, or primitives.
// Serialize links to their markdown representation; recurse into arrays.
function serializeDvValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "object") {
    // Arrays (incl. Dataview DataArrays) first — before the Link test, since a
    // DataArray could carry a `.path` property and must not be mistaken for a Link.
    if (Array.isArray(v)) {
      return v.map(serializeDvValue);
    }
    // Dataview Link: { path: string, display?: string, embed?: boolean }
    if ("path" in v && typeof (v as any).path === "string") {
      const link = v as { path: string; display?: string };
      return link.display ? `[[${link.path}|${link.display}]]` : `[[${link.path}]]`;
    }
    // Dates/Durations: Dataview uses Luxon objects — serialize to ISO if available
    if (typeof (v as any).toISO === "function") {
      return (v as any).toISO();
    }
    // Other objects: attempt plain conversion
    return String(v);
  }
  return v;
}

// Total: out-of-range / surrogate code points (never in real Omnisearch output,
// but the excerpt is external plugin text) yield "" instead of throwing.
function codePoint(n: number): string {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

// Omnisearch excerpts are HTML for its own UI: matched terms wrapped in <mark>
// and special chars entity-escaped (e.g. &#039;). Decode to plain text for MCP.
function decodeExcerpt(s: string): string {
  return s
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ") // drop HTML comments (incl. truncated ones at snippet end)
    .replace(/<br\s*\/?>/gi, " ")        // line breaks → space
    .replace(/<\/?[a-z][^>]*>/gi, "")    // strip <mark> and any other HTML tags
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerIntegrationTools(server: McpServer, app: App, _ctx: ServerCtx) {

  // Gate on the actually-LOADED plugin instance, not app.plugins.enabledPlugins:
  // enabledPlugins can list a plugin that is configured-enabled but uninstalled
  // (a stale entry), in which case its instance is absent and the tool can't work.
  // Checking app.plugins.plugins[id] means a tool only registers when usable.
  const loaded = (id: string): boolean => !!(app as any).plugins?.plugins?.[id];

  // ── Dataview tools ────────────────────────────────────────────────────────────
  if (loaded("dataview")) {

    // ── obsidian_dataview_list_query ──────────────────────────────────────────
    server.registerTool(
      "obsidian_dataview_list_query",
      {
        title: "Dataview LIST query",
        description:
          "Run a Dataview DQL LIST query and return the matching values. Requires the Dataview plugin. Returns { dql, values }. Read-only.",
        inputSchema: {
          dql: z.string().min(1).describe("A Dataview DQL LIST query, e.g. 'LIST FROM #project WHERE status = \"active\"'."),
        },
        annotations: RO,
      },
      async ({ dql }) => {
        try {
          // app.plugins.plugins is internal — not in public obsidian types.
          // Dataview exposes its API at plugin.api. We use api.query(dql) which
          // returns { successful: boolean, value: QueryResult } rather than
          // api.tryQuery(dql) which throws on bad DQL — query() gives us a
          // structured error path without exceptions for bad user input.
          // FLAG: verify api.query exists (vs api.tryQuery) in live Dataview version.
          const api = (app as any).plugins?.plugins?.dataview?.api;
          if (!api) return fail(new Error("dataview api not available"));

          const result = await api.query(dql);
          if (!result.successful) {
            return fail(new Error(String(result.error ?? "Dataview query failed")));
          }
          const qr = result.value;
          if (qr.type !== "list") {
            return fail(new Error(`Expected LIST query but got: ${qr.type}`));
          }
          // qr.values is an array of DataArray items; each may be a Link or primitive.
          const values = (qr.values as unknown[]).map(serializeDvValue);
          return ok({ dql, values });
        } catch (e) { return fail(e); }
      }
    );

    // ── obsidian_dataview_table_query ─────────────────────────────────────────
    server.registerTool(
      "obsidian_dataview_table_query",
      {
        title: "Dataview TABLE query",
        description:
          "Run a Dataview DQL TABLE query and return headers and rows. Requires the Dataview plugin. Returns { dql, headers, rows }. Read-only.",
        inputSchema: {
          dql: z.string().min(1).describe("A Dataview DQL TABLE query, e.g. 'TABLE file.ctime, status FROM #project SORT file.ctime DESC'."),
        },
        annotations: RO,
      },
      async ({ dql }) => {
        try {
          // Same api.query approach as LIST. FLAG: verify in live session.
          const api = (app as any).plugins?.plugins?.dataview?.api;
          if (!api) return fail(new Error("dataview api not available"));

          const result = await api.query(dql);
          if (!result.successful) {
            return fail(new Error(String(result.error ?? "Dataview query failed")));
          }
          const qr = result.value;
          if (qr.type !== "table") {
            return fail(new Error(`Expected TABLE query but got: ${qr.type}`));
          }
          // qr.headers: string[]; qr.values: rows (each row is an array of cells).
          const headers: string[] = qr.headers as string[];
          const rows = (qr.values as unknown[][]).map((row) =>
            row.map(serializeDvValue)
          );
          return ok({ dql, headers, rows });
        } catch (e) { return fail(e); }
      }
    );
  }

  // ── Templater tool ────────────────────────────────────────────────────────────
  if (loaded("templater-obsidian")) {

    // ── obsidian_create_note_from_template ────────────────────────────────────
    server.registerTool(
      "obsidian_create_note_from_template",
      {
        title: "Create note from Templater template",
        description:
          "Create a new note at target_path by running a Templater template. Requires the Templater plugin. Returns { target_path, created: true }.",
        inputSchema: {
          template_path: z.string().min(1).describe("Vault-relative path of the Templater template file, e.g. 'Templates/Daily Note.md'."),
          target_path:   z.string().min(1).describe("Vault-relative path for the new note to create, e.g. 'Notes/2026-06-26.md'."),
        },
        annotations: RW,
      },
      async ({ template_path, target_path }) => {
        try {
          // app.plugins.plugins is internal — not in public obsidian types.
          // Templater exposes its core API at plugin.templater.
          // The method create_new_note_from_template(templateFile, folder, filename, openNew)
          // is the documented public API surface for programmatic note creation.
          // FLAG: verify method name create_new_note_from_template vs create_running_config
          // in the installed Templater version during live verification.
          const templater = (app as any).plugins?.plugins?.["templater-obsidian"]?.templater;
          if (!templater) return fail(new Error("templater api not available"));

          // Resolve template file
          const templateFile = app.vault.getAbstractFileByPath(template_path);
          if (!(templateFile instanceof TFile)) {
            return fail(new Error(`template not found: ${template_path}`));
          }

          // Derive folder and filename from target_path
          const lastSlash = target_path.lastIndexOf("/");
          const folder = lastSlash >= 0 ? target_path.slice(0, lastSlash) : "/";
          const filename = lastSlash >= 0 ? target_path.slice(lastSlash + 1) : target_path;
          // Strip .md suffix for Templater's filename arg (it appends .md itself)
          const filenameStem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;

          // Resolve destination folder — create non-root folders if absent.
          const folderPath = folder === "/" ? "" : folder;
          let destFolder = app.vault.getAbstractFileByPath(folderPath);
          if (!destFolder && folderPath !== "") {
            await app.vault.createFolder(folderPath);
            destFolder = app.vault.getAbstractFileByPath(folderPath);
          }
          if (!destFolder) destFolder = app.vault.getRoot();
          if (!destFolder) return fail(new Error(`could not resolve destination folder: ${folder}`));

          // create_new_note_from_template(template_file, folder, filename, open_new_note)
          // Returns a TFile of the created note.
          // FLAG: if this method does not exist, fall back to write_template_to_file.
          if (typeof templater.create_new_note_from_template === "function") {
            await templater.create_new_note_from_template(templateFile, destFolder, filenameStem, false);
          } else if (typeof templater.create_running_config === "function") {
            // Older API path: create a running config and write it to file
            const targetFile = await app.vault.create(target_path, "");
            const runningConfig = templater.create_running_config(templateFile, targetFile, 0 /* RunMode.CreateNewFromTemplate */);
            await templater.read_and_set_executor_context(runningConfig);
          } else {
            return fail(new Error("templater: no known API method to create note from template"));
          }

          return ok({ target_path, created: true });
        } catch (e) { return fail(e); }
      }
    );
  }

  // ── Omnisearch tool ───────────────────────────────────────────────────────────
  if (loaded("omnisearch")) {

    // ── obsidian_omnisearch ───────────────────────────────────────────────────
    server.registerTool(
      "obsidian_omnisearch",
      {
        title: "Omnisearch full-text search",
        description:
          "Run a full-text search across the vault using the Omnisearch plugin. Returns { query, hits: [{path, score, excerpt}] }. Read-only.",
        inputSchema: {
          query: z.string().min(1).describe("Search query string."),
        },
        annotations: RO,
      },
      async ({ query }) => {
        try {
          // Omnisearch exposes a public API at plugin.api.search(query).
          // Returns Promise<SearchResult[]> where each result has { path, score, excerpt? }.
          // FLAG: verify api shape and whether search is sync or async in live Omnisearch version.
          const api = (app as any).plugins?.plugins?.omnisearch?.api;
          if (!api) return fail(new Error("omnisearch api not available"));

          const results: Array<{ path: string; score?: number; excerpt?: string }> =
            await api.search(query);
          const hits = results.map((r) => ({
            path: r.path,
            score: r.score ?? null,
            excerpt: r.excerpt ? decodeExcerpt(r.excerpt) : null,
          }));
          return ok({ query, hits });
        } catch (e) { return fail(e); }
      }
    );
  }

  // ── Metadata Menu tools ───────────────────────────────────────────────────────
  if (loaded("metadata-menu")) {

    // ── obsidian_fileclass_schema ─────────────────────────────────────────────
    server.registerTool(
      "obsidian_fileclass_schema",
      {
        title: "Metadata Menu fileClass schema",
        description:
          "Return the field schema (name, type, options) for a Metadata Menu fileClass. Requires the Metadata Menu plugin. Returns { fileclass, fields: [{name, type, options?}] }. Read-only.",
        inputSchema: {
          fileclass: z.string().min(1).describe("FileClass name, e.g. 'Project'."),
        },
        annotations: RO,
      },
      async ({ fileclass }) => {
        try {
          // Metadata Menu exposes field data via plugin.fieldIndex.fileClassesFields,
          // a Map<string, Field[]>. Verified live (2026-06-26): keys are the
          // fileClass note's *full vault path without extension*, e.g.
          // "D20-29 People/D26 Divorce/PleadingsEntry" — NOT the bare name. Match the
          // requested name against the basename (last path segment), or an exact key.
          const mm = (app as any).plugins?.plugins?.["metadata-menu"];
          if (!mm) return fail(new Error("metadata-menu plugin not available"));

          const fieldIndex = mm.fieldIndex;
          const fcf: Map<string, unknown[]> | undefined = fieldIndex?.fileClassesFields;
          if (!(fcf instanceof Map)) return fail(new Error("metadata-menu: fileClassesFields not available"));

          const keys = [...fcf.keys()];
          const exact = keys.find((k) => k === fileclass);
          const byBasename = keys.filter((k) => k.split("/").pop() === fileclass);
          const key = exact ?? (byBasename.length === 1 ? byBasename[0] : undefined);
          if (!key) {
            if (byBasename.length > 1) {
              return fail(new Error(`ambiguous fileClass '${fileclass}'; matches multiple — pass a full key: ${byBasename.join(", ")}`));
            }
            const available = keys.map((k) => k.split("/").pop());
            return fail(new Error(`fileClass not found: ${fileclass}. Available: ${available.join(", ")}`));
          }
          const rawFields = fcf.get(key) ?? [];

          const fields = rawFields.map((f: any) => ({
            name: String(f.name ?? f.id ?? ""),
            type: String(f.type ?? ""),
            options: f.options ?? undefined,
          }));

          return ok({ fileclass, fileclass_key: key, fields });
        } catch (e) { return fail(e); }
      }
    );

    // ── obsidian_fileclass_insert_fields ──────────────────────────────────────
    server.registerTool(
      "obsidian_fileclass_insert_fields",
      {
        title: "Insert missing Metadata Menu fields",
        description:
          "Open a note and run Metadata Menu's 'insert missing fields' command to add any fileClass fields not yet present in the note's frontmatter. Requires the Metadata Menu plugin. Returns { path, inserted: true }.",
        inputSchema: {
          path: z.string().min(1).describe("Vault-relative path of the note to update, e.g. 'Projects/Roadmap.md'."),
        },
        annotations: RW,
      },
      async ({ path: p }) => {
        try {
          const mm = (app as any).plugins?.plugins?.["metadata-menu"];
          if (!mm) return fail(new Error("metadata-menu plugin not available"));

          // Open the note first so file-scoped commands have a target.
          await app.workspace.openLinkText(p, "", false);

          // Execute MM's insert-missing-fields command (id verified live 2026-06-26).
          // app.commands is internal — cast required.
          const commandId = "metadata-menu:insert_missing_fields";
          const executed = (app as any).commands?.executeCommandById(commandId) as boolean | undefined;
          // executeCommandById returns false when the command id is unknown, and
          // the whole expression is undefined if app.commands itself is absent —
          // treat both as failure (don't claim success when nothing ran).
          if (!executed) {
            return fail(new Error(`command not found or did not run: ${commandId}`));
          }

          return ok({ path: p, inserted: true });
        } catch (e) { return fail(e); }
      }
    );
  }
}
