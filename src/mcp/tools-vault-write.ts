import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail, liveIndexStatus } from "./helpers.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const PROP_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const FmValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* exists / race */ }
    }
  }
}

export function registerVaultWriteTools(server: McpServer, app: App) {
  server.registerTool(
    "obsidian_write_note",
    {
      title: "Write a note",
      description: "Create a note, or overwrite an existing one when `overwrite` is true. Parent folders are created as needed.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        content: z.string(),
        overwrite: z.boolean().default(false),
      },
      annotations: RW,
    },
    async ({ path: p, content, overwrite }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        const existing = app.vault.getAbstractFileByPath(p);
        if (existing instanceof TFile) {
          if (!overwrite) return fail(new Error(`exists (set overwrite=true to replace): ${p}`));
          await app.vault.modify(existing, content);
          return ok({ path: p, created: false });
        }
        await ensureParentFolders(app, p);
        await app.vault.create(p, content);
        return ok({ path: p, created: true });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_append_note",
    {
      title: "Append to a note",
      description: "Append content to a note, creating it (and parent folders) if absent.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        content: z.string().min(1),
      },
      annotations: RW,
    },
    async ({ path: p, content }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        const existing = app.vault.getAbstractFileByPath(p);
        if (existing instanceof TFile) {
          await app.vault.append(existing, content);
          return ok({ path: p, created: false });
        }
        await ensureParentFolders(app, p);
        await app.vault.create(p, content);
        return ok({ path: p, created: true });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_manage_frontmatter",
    {
      title: "Manage frontmatter",
      description: "Get, set, or delete a single frontmatter key. Set/delete use Obsidian's atomic processFrontMatter, preserving other keys' formatting.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        key: z.string().min(1).max(64).regex(PROP_RE).describe("Frontmatter field name."),
        op: z.enum(["get", "set", "delete"]),
        value: FmValue.optional().describe("Required for op='set'."),
      },
      annotations: RW,
    },
    async ({ path: p, key, op, value }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));

        if (op === "get") {
          // Literal (case-sensitive) key, matching set/delete — mutation must
          // target the exact YAML key, not a case-folded match, to avoid dupes.
          const fm = app.metadataCache.getFileCache(file)?.frontmatter;
          return ok({ path: p, key, op, value: fm ? fm[key] : undefined });
        }

        if (op === "set") {
          if (value === undefined) return fail(new Error("op='set' requires `value`"));
          const hadFm = !!app.metadataCache.getFileCache(file)?.frontmatter;
          let previous: unknown;
          await app.fileManager.processFrontMatter(file, (fm) => {
            previous = fm[key];
            fm[key] = value;
          });
          return ok({ path: p, key, op, value, previous, created_frontmatter: !hadFm });
        }

        // delete
        let existed = false;
        let previous: unknown;
        await app.fileManager.processFrontMatter(file, (fm) => {
          existed = Object.prototype.hasOwnProperty.call(fm, key);
          previous = fm[key];
          delete fm[key];
        });
        return ok({ path: p, key, op, existed, previous });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_patch_note",
    {
      title: "Patch a note section",
      description: "Append/prepend/replace content at a heading or block-id anchor. Returns found=false (no write) if the anchor is not present.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        anchor_type: z.enum(["heading", "block"]),
        anchor: z.string().min(1).max(500).describe("Heading text (no #) or block id (no ^)."),
        op: z.enum(["append", "prepend", "replace"]),
        content: z.string().describe("Markdown to insert; newlines preserved."),
      },
      annotations: RW,
    },
    async ({ path: p, anchor_type, anchor, op, content }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        if (anchor_type === "block" && !/^[A-Za-z0-9_-]+$/.test(anchor)) {
          return fail(new Error("block anchor must match [A-Za-z0-9_-]+"));
        }
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));
        const cache = app.metadataCache.getFileCache(file);
        const text = await app.vault.read(file);

        let start: number, end: number; // bounds of the anchored region's body
        if (anchor_type === "heading") {
          const headings = cache?.headings ?? [];
          const idx = headings.findIndex((h) => h.heading === anchor);
          if (idx < 0) {
            return ok({ path: p, found: false, anchor: { type: anchor_type, value: anchor }, op });
          }
          const h = headings[idx];
          start = h.position.end.offset; // just after the heading line
          end = text.length;
          for (let j = idx + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) { end = headings[j].position.start.offset; break; }
          }
        } else {
          const block = cache?.blocks?.[anchor];
          if (!block) {
            return ok({ path: p, found: false, anchor: { type: anchor_type, value: anchor }, op });
          }
          start = block.position.start.offset;
          end = block.position.end.offset;
        }

        const previous = text.slice(start, end);
        let next: string;
        if (op === "replace") {
          const body = anchor_type === "heading" ? `\n\n${content}\n` : content;
          next = text.slice(0, start) + body + text.slice(end);
        } else if (op === "prepend") {
          const ins = anchor_type === "heading" ? `\n\n${content}` : `${content}\n`;
          next = text.slice(0, start) + ins + text.slice(start);
        } else {
          // append at the end of the section/block body, preserving any blank
          // line before a following heading (tail not starting with a newline)
          const head = text.slice(0, end).replace(/\n*$/, "\n");
          const tail = text.slice(end);
          const sep = tail.length === 0 || tail.startsWith("\n") ? "\n" : "\n\n";
          next = head + content + sep + tail;
        }

        await app.vault.modify(file, next);
        return ok({ path: p, found: true, anchor: { type: anchor_type, value: anchor }, op, previous });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_move_note",
    {
      title: "Move/rename a note",
      description: "Move or rename a note. Backlinks are rewritten canonically by Obsidian's fileManager.renameFile.",
      inputSchema: {
        from: z.string().min(1).describe("Existing vault-relative path ending in .md."),
        to: z.string().min(1).describe("New vault-relative path ending in .md."),
        overwrite: z.boolean().default(false),
      },
      annotations: RW,
    },
    async ({ from, to, overwrite }) => {
      try {
        if (!to.endsWith(".md")) return fail(new Error("destination must end in .md"));
        if (from === to) return fail(new Error("from and to are the same path"));
        const file = app.vault.getAbstractFileByPath(from);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${from}`));
        const dest = app.vault.getAbstractFileByPath(to);
        if (dest) {
          if (!overwrite) return fail(new Error(`destination exists (set overwrite=true): ${to}`));
          // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
          if (dest instanceof TFile) await app.vault.trash(dest, true);
        }
        // Count the backlinks Obsidian is about to rewrite (canonical, alias/embed-aware).
        // getBacklinksForFile is not in the public type defs — cast required.
        const bl = (app.metadataCache as { getBacklinksForFile?: (f: TFile) => { data?: Map<string, unknown[]> } })
          .getBacklinksForFile?.(file);
        let backlinks_files_touched = 0;
        let backlinks_updated = 0;
        if (bl?.data) {
          backlinks_files_touched = bl.data.size;
          for (const refs of bl.data.values()) backlinks_updated += Array.isArray(refs) ? refs.length : 0;
        }
        await ensureParentFolders(app, to);
        await app.fileManager.renameFile(file, to);
        return ok({ from, to, backlinks_updated, backlinks_files_touched, index_status: liveIndexStatus(app) });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_delete_note",
    {
      title: "Delete a note",
      description: "Permanently delete a note. Requires confirm=true.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note."),
        confirm: z.literal(true).describe("Must be true to proceed."),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ path: p }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));
        await app.vault.delete(file);
        return ok({ path: p, deleted: true });
      } catch (e) { return fail(e); }
    }
  );
}
