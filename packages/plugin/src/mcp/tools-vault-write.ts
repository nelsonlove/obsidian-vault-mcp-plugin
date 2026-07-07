// obsidian_write_note, obsidian_append_note, obsidian_manage_frontmatter,
// obsidian_patch_note, obsidian_move_note, and obsidian_delete_note have been
// migrated to registerFsTools + ObsidianBackend in server.ts.
//
// This file retains ONLY obsidian_move_notes — the live-only batch-move tool
// that is not part of the 17 fs-expressible set — along with its helpers.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail, okError, validateMoves } from "./helpers.js";

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
}
