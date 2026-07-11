// obsidian_write_note, obsidian_append_note, obsidian_manage_frontmatter,
// obsidian_patch_note, obsidian_move_note, and obsidian_delete_note have been
// migrated to registerFsTools + ObsidianBackend in server.ts.
//
// This file retains the live-only tools that are not part of the 17
// fs-expressible set — obsidian_move_notes (batch move/rename) and
// obsidian_repoint_link (repoint broken wikilinks) — along with their helpers.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail, okError, validateMoves } from "./helpers.js";
import { repointLinksInText } from "./repoint.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

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

async function moveOne(app: App, from: string, to: string, overwrite: boolean): Promise<void> {
  if (!from.endsWith(".md")) throw new Error("source must end in .md");
  if (!to.endsWith(".md")) throw new Error("destination must end in .md");
  if (from === to) throw new Error("from and to are the same path");
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) throw new Error(`not found: ${from}`);
  const dest = app.vault.getAbstractFileByPath(to);
  let trashedDest = false;
  if (dest) {
    if (!overwrite) throw new Error(`destination exists (set overwrite=true): ${to}`);
    // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
    if (dest instanceof TFile) {
      await app.vault.trash(dest, true);
      trashedDest = true;
    }
  }
  await ensureParentFolders(app, to);
  try {
    await app.fileManager.renameFile(file, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (trashedDest)
      throw new Error(`${msg} (the note previously at '${to}' was already moved to the system trash and is recoverable there)`);
    throw e;
  }
}

export function registerVaultWriteTools(server: McpServer, app: App) {
  server.registerTool(
    "obsidian_move_notes",
    {
      title: "Move/rename multiple notes",
      description:
        "Move or rename several notes in one call. Items are processed sequentially; backlinks are rewritten canonically by Obsidian's fileManager.renameFile. A runtime-failed item (missing source, existing destination) is reported in `errors` and does not fail the call, but if every item fails the call is flagged as an error. Statically invalid batches are rejected up front with no moves performed: a non-.md path, an item whose from and to are identical, or a path appearing twice as a source, twice as a destination, or as both (swaps/chains) — compared after normalization.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              from: z.string().min(1).describe("Existing vault-relative path ending in .md."),
              to: z.string().min(1).describe("New vault-relative path ending in .md."),
            })
          )
          .min(1)
          .max(50)
          .describe("Move/rename operations, e.g. [{from:'Inbox/A.md',to:'Archive/A.md'}]."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Applies to every item: replace an existing destination (the previous note goes to trash)."),
      },
      annotations: RW,
    },
    async ({ moves, overwrite }) => {
      const invalid = validateMoves(moves);
      if (invalid) return fail(new Error(`invalid batch, no moves performed — ${invalid}`));
      const moved: Array<{ from: string; to: string }> = [];
      const errors: Array<{ from: string; to: string; error: string }> = [];
      for (const { from, to } of moves) {
        try {
          await moveOne(app, from, to, overwrite);
          moved.push({ from, to });
        } catch (e) {
          errors.push({ from, to, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const payload = { count: moved.length, error_count: errors.length, moved, errors };
      // Partial failure is tolerated, but total failure must carry the standard MCP error flag.
      return moved.length === 0 ? okError(payload) : ok(payload);
    }
  );

  server.registerTool(
    "obsidian_repoint_link",
    {
      title: "Repoint a link",
      description:
        "Rewrite every wikilink whose target text matches `link_name` to point at `target_path` instead, across the whole vault. Case-insensitive on the link text; aliases ([[x|alias]]) and subpaths ([[x#heading]]) are preserved. This is the tool for fixing BROKEN links: Obsidian's rename-based backlink rewrite (obsidian_move_note/obsidian_move_notes) only touches links that already resolve to a file, so a dangling [[x]] that points at no note can only be repointed by this text-level scan. Set dry_run=true to report how many links/notes would change without writing anything.",
      inputSchema: {
        link_name: z
          .string()
          .min(1)
          .describe("The link text inside [[ ]] to repoint, e.g. 'Foo Bar'. Case-insensitive; omit the brackets, any alias, and any #heading."),
        target_path: z
          .string()
          .min(1)
          .describe("Vault-relative path (ending in .md) of the note to point the matching links at."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, report linksChanged/filesChanged without modifying any files."),
        unresolved_only: z
          .boolean()
          .default(false)
          .describe("Only rewrite links that do NOT currently resolve from their source file (checked per-file against metadataCache.unresolvedLinks). Guards against repointing working links that share the name."),
        drop_echo_alias: z
          .boolean()
          .default(false)
          .describe("Drop an alias that merely echoes the old link name ([[foo|foo]] becomes [[NewTarget]]), so display text follows the new target. Genuine aliases are always preserved."),
      },
      annotations: RW,
    },
    async ({ link_name, target_path, dry_run, unresolved_only, drop_echo_alias }) => {
      try {
        if (!target_path.endsWith(".md")) return fail(new Error("target_path must end in .md"));
        const target = app.vault.getAbstractFileByPath(target_path);
        if (!(target instanceof TFile)) return fail(new Error(`target not found: ${target_path}`));

        let filesChanged = 0;
        let linksChanged = 0;
        const files: string[] = [];

        for (const file of app.vault.getMarkdownFiles()) {
          // Shortest unambiguous link text for the target, relative to this source file.
          const newTarget = app.metadataCache.fileToLinktext(target, file.path, true);
          // unresolved_only: gate each link on Obsidian's own per-file unresolved map,
          // so links that still resolve from this file are left untouched.
          let allowTarget: ((rawTarget: string) => boolean) | undefined;
          if (unresolved_only) {
            const unres = app.metadataCache.unresolvedLinks[file.path] ?? {};
            const unresSet = new Set(Object.keys(unres).map((k) => k.trim().toLowerCase()));
            allowTarget = (raw) => unresSet.has(raw.trim().toLowerCase());
          }
          const opts = { dropEchoAlias: drop_echo_alias, allowTarget };
          // Peek from cache first so unmatched files are never rewritten (no mtime churn).
          const preview = repointLinksInText(await app.vault.cachedRead(file), link_name, newTarget, opts);
          if (preview.count === 0) continue;

          let count = preview.count;
          if (!dry_run) {
            // Re-run under the write lock so the reported count reflects what was written.
            await app.vault.process(file, (data) => {
              const r = repointLinksInText(data, link_name, newTarget, opts);
              count = r.count;
              return r.text;
            });
          }
          if (count === 0) continue;

          filesChanged++;
          linksChanged += count;
          files.push(file.path);
        }

        return ok({ link_name, target_path, dry_run, unresolved_only, drop_echo_alias, linksChanged, filesChanged, files });
      } catch (e) { return fail(e); }
    }
  );
}
