import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile, TFolder, getAllTags } from "obsidian";
import { ok, fail } from "./helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const PROP_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const CHARACTER_LIMIT = 100_000;

function countMarkdownRecursive(folder: TFolder): number {
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += countMarkdownRecursive(child);
    else if (child instanceof TFile && child.extension === "md") n += 1;
  }
  return n;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "");
}

export function registerVaultReadTools(server: McpServer, app: App) {
  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read a note",
      description: "Read the full markdown content of a note by its vault-relative path. Read-only.",
      inputSchema: { path: z.string().min(1).describe("Vault-relative path, e.g. 'Projects/Roadmap.md'.") },
      annotations: RO,
    },
    async ({ path: p }) => {
      try {
        const f = app.vault.getAbstractFileByPath(p);
        if (!(f instanceof TFile)) return fail(new Error(`not found: ${p}`));
        return ok({ path: p, content: await app.vault.read(f) });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_read_notes",
    {
      title: "Read multiple notes",
      description: "Read several notes at once. One missing/unreadable path is reported in `errors` and does not fail the call. Read-only.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(50).describe("Vault-relative paths, e.g. ['Projects/A.md','Daily/2026-06-05.md']."),
      },
      annotations: RO,
    },
    async ({ paths }) => {
      const notes: Array<{ path: string; content: string; truncated: boolean }> = [];
      const errors: Array<{ path: string; error: string }> = [];
      for (const p of paths) {
        try {
          const f = app.vault.getAbstractFileByPath(p);
          if (!(f instanceof TFile)) throw new Error(`not found: ${p}`);
          const content = await app.vault.read(f);
          notes.push({ path: p, content, truncated: content.length > CHARACTER_LIMIT });
        } catch (e) {
          errors.push({ path: p, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return ok({ count: notes.length, error_count: errors.length, notes, errors });
    }
  );

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List notes",
      description: "List markdown notes, optionally under a subfolder, with pagination. Read-only.",
      inputSchema: {
        subdir: z.string().optional().describe("Vault-relative subfolder, e.g. 'Daily'. Omit for the whole vault."),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: RO,
    },
    async ({ subdir, limit, offset }) => {
      try {
        const prefix = subdir ? subdir.replace(/\/$/, "") + "/" : "";
        const all = app.vault
          .getMarkdownFiles()
          .filter((f) => (prefix ? f.path.startsWith(prefix) : true))
          .map((f) => f.path)
          .sort();
        const total = all.length;
        const page = all.slice(offset, offset + limit);
        return ok({
          total,
          count: page.length,
          offset,
          notes: page.map((path) => ({ path })),
          has_more: offset + page.length < total,
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_list_folders",
    {
      title: "List folders",
      description: "List immediate subfolders of a folder (or the vault root), each with a recursive markdown-note count. Read-only.",
      inputSchema: {
        subdir: z.string().optional().describe("Vault-relative subfolder. Omit for the vault root."),
      },
      annotations: RO,
    },
    async ({ subdir }) => {
      try {
        const base = subdir ? app.vault.getAbstractFileByPath(subdir.replace(/\/$/, "")) : app.vault.getRoot();
        if (!(base instanceof TFolder)) return fail(new Error(`not a folder: ${subdir}`));
        const folders = base.children
          .filter((c): c is TFolder => c instanceof TFolder)
          .map((f) => ({ path: f.path, note_count: countMarkdownRecursive(f) }))
          .sort((a, b) => a.path.localeCompare(b.path));
        return ok({ subdir: subdir ?? null, count: folders.length, folders });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_find_by_tag",
    {
      title: "Find notes by tag",
      description: "List notes carrying a tag (inline or in frontmatter), matched from the live metadata cache. Read-only.",
      inputSchema: {
        tag: z.string().min(1).describe("Tag to match, e.g. 'project' or '#project' (with or without #)."),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: RO,
    },
    async ({ tag, limit }) => {
      try {
        const want = normalizeTag(tag).toLowerCase();
        const notes: Array<{ path: string }> = [];
        for (const f of app.vault.getMarkdownFiles()) {
          const cache = app.metadataCache.getFileCache(f);
          if (!cache) continue;
          const tags = (getAllTags(cache) ?? []).map((t) => normalizeTag(t).toLowerCase());
          if (tags.includes(want)) {
            notes.push({ path: f.path });
            if (notes.length >= limit) break;
          }
        }
        return ok({ tag: normalizeTag(tag), count: notes.length, notes });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_search_notes",
    {
      title: "Search notes",
      description: "Case-insensitive substring search across note contents, line by line. Read-only.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for."),
        limit: z.number().int().min(1).max(500).default(25),
        mode: z.enum(["one_per_note", "all"]).default("one_per_note"),
      },
      annotations: RO,
    },
    async ({ query, limit, mode }) => {
      try {
        const needle = query.toLowerCase();
        const hits: Array<{ path: string; line: number; snippet: string }> = [];
        outer: for (const f of app.vault.getMarkdownFiles()) {
          const content = await app.vault.cachedRead(f);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push({ path: f.path, line: i + 1, snippet: lines[i].trim().slice(0, 300) });
              if (hits.length >= limit) break outer;
              if (mode === "one_per_note") continue outer;
            }
          }
        }
        return ok({ query, mode, count: hits.length, hits });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_get_outlinks",
    {
      title: "Get outlinks",
      description: "List links and embeds OUT of a note, each resolved to a canonical vault path via the live cache. Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the source note."),
      },
      annotations: RO,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));
        const cache = app.metadataCache.getFileCache(file);
        const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
        const outlinks = refs.map((r) => {
          const linkpath = r.link.split("#")[0];
          const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, p) : null;
          return { ref: r.link, resolved_path: dest ? dest.path : undefined };
        });
        return ok({ path: p, count: outlinks.length, outlinks });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_search_by_frontmatter",
    {
      title: "Search by frontmatter",
      description: "Find notes whose frontmatter property equals a value (array properties match any element). Read-only.",
      inputSchema: {
        property: z.string().min(1).max(64).regex(PROP_RE).describe("Frontmatter field name."),
        value: z.string().min(1).describe("Exact value to match."),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: RO,
    },
    async ({ property, value, limit }) => {
      try {
        const wantKey = property.toLowerCase();
        const matched: Array<{ path: string }> = [];
        let total = 0;
        for (const f of app.vault.getMarkdownFiles()) {
          const fm = app.metadataCache.getFileCache(f)?.frontmatter;
          if (!fm) continue;
          const key = Object.keys(fm).find((k) => k.toLowerCase() === wantKey);
          if (!key) continue;
          const fv = fm[key];
          const hit = Array.isArray(fv)
            ? fv.some((v) => String(v) === value)
            : String(fv) === value;
          if (hit) {
            total += 1;
            if (matched.length < limit) matched.push({ path: f.path });
          }
        }
        return ok({
          property,
          value,
          total,
          count: matched.length,
          notes: matched,
          has_more: total > matched.length,
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_force_reindex",
    {
      title: "Force reindex (no-op)",
      description: "No-op: Obsidian's metadata cache is always live, so there is nothing to rebuild. Returns immediately. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => ok({ status: "live", message: "metadata cache is live; no reindex needed" })
  );
}
