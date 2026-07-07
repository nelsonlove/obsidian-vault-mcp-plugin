import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import {
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  findByTag,
  vaultRoot,
  decodeHtmlEntities,
  CHARACTER_LIMIT,
  getFrontmatterField,
  setFrontmatterField,
  deleteFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  listFolders,
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  startVaultWatcher,
  ok,
  fail,
} from "@vault-mcp/core";
import {
  loadAuthConfig,
  protectedResourceMetadata,
  prmPath,
  requireBearer,
} from "./auth.js";

/**
 * obsidian-vault-mcp-server
 *
 * A minimal REMOTE (Streamable HTTP) MCP server over a plain Obsidian vault
 * folder. It reads/writes the markdown files that `obsidian-headless` keeps
 * continuously synced. It does NOT call the Obsidian app or any plugin REST API.
 *
 * Auth: NONE at this layer (Phase 1). Lock the public edge to Anthropic's
 * egress range and serve over TLS via your reverse proxy. Add real OAuth
 * (Phase 2) in front of, or inside, this process later.
 */

function buildServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-vault-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List vault notes",
      description:
        "List markdown notes in the vault as vault-relative paths. Optionally scope to a subfolder. Paginated. Read-only.",
      inputSchema: {
        subdir: z
          .string()
          .optional()
          .describe("Optional vault-relative subfolder to scope the listing, e.g. 'Daily'."),
        limit: z.number().int().min(1).max(500).default(100).describe("Max notes to return."),
        offset: z.number().int().min(0).default(0).describe("Notes to skip (pagination)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subdir, limit, offset }) => {
      try {
        const decodedSubdir = subdir ? decodeHtmlEntities(subdir) : undefined;
        const { total, notes } = await listNotes(decodedSubdir, limit, offset);
        return ok({
          total,
          count: notes.length,
          offset,
          notes,
          has_more: offset + notes.length < total,
          index_status: indexStatus(),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read a note",
      description: "Read the full markdown content of a note by its vault-relative path. Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path, e.g. 'Projects/Roadmap.md'."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: p }) => {
      try {
        const decoded = decodeHtmlEntities(p);
        return ok({ path: decoded, content: await readNote(decoded), index_status: indexStatus() });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive full-text search across all notes. Returns matching lines (path, line number, snippet). By default returns one match per note for broad coverage; pass `mode: \"all\"` to get every matching line up to `limit`. Read-only.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for."),
        limit: z.number().int().min(1).max(500).default(25).describe("Max hits to return."),
        mode: z
          .enum(["one_per_note", "all"])
          .default("one_per_note")
          .describe(
            "`one_per_note` (default) returns the first match per file; `all` returns every matching line until `limit`. Use `all` when you need multiple hits inside the same note."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit, mode }) => {
      try {
        const decodedQuery = decodeHtmlEntities(query);
        const hits = await searchNotes(decodedQuery, limit, mode);
        return ok({ query: decodedQuery, mode, count: hits.length, hits, index_status: indexStatus() });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_find_by_tag",
    {
      title: "Find notes by tag",
      description:
        "Find notes carrying a given tag, from YAML frontmatter `tags:` or inline `#tag`. Pass the tag with or without '#'. Read-only.",
      inputSchema: {
        tag: z.string().min(1).describe("Tag to match, e.g. 'project' or '#project'."),
        limit: z.number().int().min(1).max(200).default(50).describe("Max notes to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tag, limit }) => {
      try {
        const decodedTag = decodeHtmlEntities(tag);
        const notes = await findByTag(decodedTag, limit);
        return ok({
          tag: decodedTag.replace(/^#/, ""),
          count: notes.length,
          notes,
          index_status: indexStatus(),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_write_note",
    {
      title: "Write a note",
      description:
        "Create a note, or overwrite an existing one when overwrite=true. Path must end in .md. Parent folders are created as needed. Writes propagate to your other devices via Obsidian Sync.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        content: z.string().describe("Full markdown content to write."),
        overwrite: z.boolean().default(false).describe("Replace an existing note. Default false (refuses if it exists)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: p, content, overwrite }) => {
      try {
        return ok(await writeNote(decodeHtmlEntities(p), content, overwrite));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_resolve",
    {
      title: "Resolve references to vault paths",
      description:
        "Resolve one or more references (wikilinks, basenames, aliases, JD-IDs, or vault-relative paths) to canonical vault paths. " +
        "Algorithm matches Obsidian's: exact path → JD-ID → basename → frontmatter alias. " +
        "Accepts `[[...]]` wrapping, `|alias` display text, and `#heading` / `#^block` fragments — those are stripped for matching and preserved in the response. " +
        "Multiple basename or alias matches return as `ambiguous` with all candidates so the caller can disambiguate. Read-only.",
      inputSchema: {
        refs: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("References to resolve, e.g. ['Daily Standup', '[[92.05]]', 'Projects/A.md#Goals']."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ refs }) => {
      const decoded = refs.map(decodeHtmlEntities);
      const results = resolveRefs(decoded);
      const resolved = results.filter((r) => r.path !== undefined);
      const ambiguous = results.filter((r) => r.ambiguous !== undefined);
      const unresolved = results.filter((r) => r.path === undefined && r.ambiguous === undefined);
      return ok({
        resolved,
        ambiguous,
        unresolved,
        index_status: indexStatus(),
      });
    }
  );

  server.registerTool(
    "obsidian_get_backlinks",
    {
      title: "Get backlinks to a note",
      description:
        "List notes that contain a `[[wikilink]]` pointing at the given note. Backlinks are computed from the in-memory index, which auto-refreshes on disk changes within ~300ms; call `obsidian_force_reindex` if you need to wait synchronously before querying. Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the target note, e.g. 'Projects/Plan.md'."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: p }) => {
      const decoded = decodeHtmlEntities(p);
      const backlinks = getBacklinks(decoded);
      return ok({
        path: decoded,
        count: backlinks.length,
        backlinks,
        index_status: indexStatus(),
      });
    }
  );

  server.registerTool(
    "obsidian_get_outlinks",
    {
      title: "Get outbound links from a note",
      description:
        "List `[[wikilinks]]` in the body of a note, with each ref's resolved path when resolution is unambiguous. Useful for traversal without re-reading the note. Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the source note, e.g. 'Projects/Plan.md'."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: p }) => {
      const decoded = decodeHtmlEntities(p);
      const outlinks = getOutlinks(decoded);
      return ok({
        path: decoded,
        count: outlinks.length,
        outlinks,
        index_status: indexStatus(),
      });
    }
  );

  server.registerTool(
    "obsidian_list_folders",
    {
      title: "List immediate child folders",
      description:
        "Return the immediate child folders of `subdir` (or the vault root) with a recursive markdown-note count for each. Useful for discovering vault structure before narrowing scope with `obsidian_list_notes`. Hidden directories (`.obsidian/`, `.trash/`, etc.) are excluded. Read-only.",
      inputSchema: {
        subdir: z
          .string()
          .optional()
          .describe("Optional vault-relative subfolder. Defaults to vault root."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subdir }) => {
      try {
        const decoded = subdir ? decodeHtmlEntities(subdir) : undefined;
        const folders = await listFolders(decoded);
        return ok({ subdir: decoded ?? null, count: folders.length, folders });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_search_by_frontmatter",
    {
      title: "Search notes by a frontmatter field/value",
      description:
        "Find notes whose frontmatter has `property == value`. Property match is case-insensitive (Obsidian convention); value match is case-sensitive (exact). " +
        "For array-typed fields (`tags`, `aliases`, etc.) the note matches if any array element equals the value. " +
        "Backed by the in-memory index, which auto-refreshes on disk changes within ~300ms; call `obsidian_force_reindex` if you need to wait synchronously before querying. Read-only.",
      inputSchema: {
        property: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Property must be a YAML identifier (letters/digits/underscore/hyphen, starting with letter or underscore)")
          .describe("Frontmatter field name, e.g. 'status', 'tags', 'jd-id'."),
        value: z
          .string()
          .min(1)
          .describe("Exact value to match. For array fields, matches if any element equals this."),
        limit: z.number().int().min(1).max(500).default(100).describe("Max notes to return."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ property, value, limit }) => {
      const decodedValue = decodeHtmlEntities(value);
      const matches = searchByFrontmatter(property, decodedValue);
      const notes = matches.slice(0, limit).map((n) => ({ path: n.path }));
      return ok({
        property,
        value: decodedValue,
        total: matches.length,
        count: notes.length,
        notes,
        has_more: matches.length > limit,
        index_status: indexStatus(),
      });
    }
  );

  server.registerTool(
    "obsidian_manage_frontmatter",
    {
      title: "Get / set / delete a single frontmatter field",
      description:
        "Read or modify one top-level frontmatter field of a note. Supports inline-scalar (`key: value`), inline-array (`key: [a, b]`), and block-array (`key:\\n  - a`) shapes. " +
        "Refuses to edit fields using block-scalar (|/>) or inline-object shapes to avoid silent corruption. " +
        "`set` creates the frontmatter block if absent. Other keys' formatting (indentation, quoting) is preserved — only the target key's lines get rewritten. " +
        "Note: changes are written to disk live, and the watcher auto-refreshes the in-memory index within ~300ms. Tight read-after-write loops should call obsidian_force_reindex first to wait synchronously.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note, ending in .md."),
        key: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Key must be a YAML identifier (letters/digits/underscore/hyphen, starting with letter or underscore)")
          .describe("Frontmatter field name."),
        op: z.enum(["get", "set", "delete"]).describe("Operation."),
        value: z
          .union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.union([z.string(), z.number(), z.boolean()])),
          ])
          .optional()
          .describe("Required for `set`. Ignored otherwise. Arrays serialize as block lists."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: p, key, op, value }) => {
      try {
        const decodedPath = decodeHtmlEntities(p);
        if (op === "get") {
          const v = await getFrontmatterField(decodedPath, key);
          return ok({ path: decodedPath, key, op, value: v });
        }
        if (op === "delete") {
          const r = await deleteFrontmatterField(decodedPath, key);
          return ok({ path: decodedPath, key, op, existed: r.existed, previous: r.previous });
        }
        // op === "set"
        if (value === undefined) {
          return fail(new Error("`value` is required for op='set'"));
        }
        const r = await setFrontmatterField(decodedPath, key, value);
        return ok({
          path: decodedPath,
          key,
          op,
          value,
          previous: r.previous,
          created_frontmatter: r.created_frontmatter,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_read_notes",
    {
      title: "Read multiple notes",
      description:
        "Read several notes in one call. Returns `notes` for successful reads and `errors` for paths that failed (missing, ignored folders, etc.) — one bad path doesn't fail the whole call. Each note is truncated independently at the per-note character limit. Read-only.",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe("Vault-relative paths, e.g. ['Projects/A.md', 'Daily/2026-06-05.md']. Max 50 per call."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ paths }) => {
      type Result =
        | { idx: number; kind: "ok"; value: { path: string; content: string; truncated: boolean } }
        | { idx: number; kind: "err"; value: { path: string; error: string } };
      // Single decode per input + idx tagging — preserves input order even when
      // duplicate paths are passed (each occurrence gets its own slot) and runs
      // in O(N) rather than the O(N²) re-decode of the prior sort approach.
      const results: Result[] = await Promise.all(
        paths.map(async (raw, idx): Promise<Result> => {
          const p = decodeHtmlEntities(raw);
          try {
            const content = await readNote(p);
            return {
              idx,
              kind: "ok",
              // readNote truncates strictly when content.length > CHARACTER_LIMIT
              // (vault.ts), so the same comparison here is the precise check.
              value: { path: p, content, truncated: content.length > CHARACTER_LIMIT },
            };
          } catch (e) {
            return {
              idx,
              kind: "err",
              value: { path: p, error: e instanceof Error ? e.message : String(e) },
            };
          }
        })
      );
      results.sort((a, b) => a.idx - b.idx);
      const notes = results.filter((r): r is Extract<Result, { kind: "ok" }> => r.kind === "ok").map((r) => r.value);
      const errors = results.filter((r): r is Extract<Result, { kind: "err" }> => r.kind === "err").map((r) => r.value);
      return ok({ count: notes.length, error_count: errors.length, notes, errors, index_status: indexStatus() });
    }
  );

  server.registerTool(
    "obsidian_delete_note",
    {
      title: "Delete a note from the vault",
      description:
        "Permanently delete a note from disk. The change propagates to your other devices via Obsidian Sync — the same one-way deletion that caused a near-data-loss incident on 2026-06-04 if used wrong. " +
        "To make accidents harder: `confirm: true` is required at the schema layer. Calls without it are rejected before reaching the filesystem. " +
        "Backlinks to the deleted note are NOT updated — those refs become 'broken' and can be detected with the existing tooling. Use `obsidian_move_note` if you want to relocate while preserving wikilinks.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to delete."),
        confirm: z
          .literal(true)
          .describe("Must be literally `true`. Required guard against accidental deletes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: p, confirm }) => {
      try {
        const decodedPath = decodeHtmlEntities(p);
        const r = await deleteNote(decodedPath, confirm);
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_move_note",
    {
      title: "Rename / move a note and rewrite backlinks",
      description:
        "Move (or rename) a note from one vault path to another. With `update_backlinks: true` (default), every note that wikilinks to `from` is rewritten to point at `to`. " +
        "Resolution uses the in-memory index built at startup: only refs that currently resolve to `from` are touched; ambiguous basename matches are left alone (the index can't tell which note the author meant). " +
        "Ref *shape* is preserved across the rewrite — bare basename refs (`[[from-basename]]`) get the new basename, full-path refs get the new full path. `|alias` and `#fragment` suffixes are kept verbatim. " +
        "Refuses if `to` already exists unless `overwrite: true`. Parent folders of `to` are created as needed. " +
        "The watcher refreshes the in-memory index within ~300ms after the move; tight read-after-write loops should call `obsidian_force_reindex` first to wait synchronously.",
      inputSchema: {
        from: z.string().min(1).describe("Existing vault-relative path of the note, ending in .md."),
        to: z.string().min(1).describe("New vault-relative path, ending in .md."),
        update_backlinks: z
          .boolean()
          .default(true)
          .describe("Rewrite [[wikilinks]] in other notes that currently resolve to `from`."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace `to` if it already exists. Default false (refuses)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to, update_backlinks, overwrite }) => {
      try {
        const decodedFrom = decodeHtmlEntities(from);
        const decodedTo = decodeHtmlEntities(to);
        const r = await moveNote(decodedFrom, decodedTo, {
          update_backlinks,
          overwrite,
          backlinks_provider: getBacklinks,
          resolve_ref: (ref: string) => resolveRefs([ref])[0]?.path,
        });
        return ok({ ...r, index_status: indexStatus() });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_patch_note",
    {
      title: "Patch a note relative to a heading or block anchor",
      description:
        "Insert / replace content at a named anchor inside a note. Three operations × two anchor types:\n" +
        "  - `heading` anchor: matches the first `## My Heading` line whose text exactly equals the anchor value (case-sensitive). " +
        "If multiple headings have the same text, only the first is patched. The anchor's 'content' is the section body — lines from after the heading up to the next heading of equal or higher level, or EOF. The heading line itself is preserved across all three ops.\n" +
        "  - `block` anchor: matches the first paragraph whose final token is `^<value>` (whitespace-bounded). The anchor's 'content' is the entire paragraph (lines from prior blank line up to next blank line). `prepend`/`append` operate on the WHOLE paragraph, not just the line containing `^<value>`. `replace` swaps the entire paragraph (and the `^<value>` token with it — include it in `content` if you want the block ref preserved).\n" +
        "`content` is inserted verbatim into the line stream — newlines preserved. Callers wanting paragraph-level separation (a blank line between the inserted content and the anchor's content) should include the blank line(s) in `content` themselves. " +
        "Returns `found: false` if the anchor doesn't match; no write happens. Returns the prior content as `previous` so the caller can undo or audit. " +
        "For frontmatter-field edits use `obsidian_manage_frontmatter` instead — patch_note doesn't shadow it.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note, ending in .md."),
        anchor_type: z.enum(["heading", "block"]).describe("Anchor matcher: 'heading' or 'block'."),
        anchor: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Anchor value: the exact heading text (without leading `#`s and whitespace) OR the block ID (without leading `^`)."
          ),
        op: z.enum(["append", "prepend", "replace"]).describe("Where to put the content relative to the anchor."),
        content: z.string().describe("Markdown to insert or use as replacement. Newlines preserved."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: p, anchor_type, anchor, op, content }) => {
      try {
        const decodedPath = decodeHtmlEntities(p);
        // Block IDs in Obsidian are alphanumeric + dash/underscore by
        // convention. Reject anything else to avoid the user passing values
        // like `foo bar` that would never match an Obsidian block ref.
        if (anchor_type === "block" && !/^[A-Za-z0-9_-]+$/.test(anchor)) {
          return fail(new Error(`Block anchor must match [A-Za-z0-9_-]+. Got: '${anchor}'`));
        }
        const result = await patchNote(
          decodedPath,
          { type: anchor_type, value: anchor },
          op,
          content
        );
        return ok({ path: decodedPath, ...result });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_append_note",
    {
      title: "Append to a note",
      description:
        "Append markdown to a note (creating it if absent). A newline is inserted before appended content for existing notes. Good for daily logs and running lists.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        content: z.string().min(1).describe("Markdown to append."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: p, content }) => {
      try {
        return ok(await appendNote(decodeHtmlEntities(p), content));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_force_reindex",
    {
      title: "Force-rebuild the in-memory vault index",
      description:
        "Re-walk the vault from disk and rebuild the in-memory index (basename / alias / JD-ID / frontmatter / backlinks). " +
        "Normally unnecessary — the watcher refreshes the index within ~300ms of any disk change. Call this when you need to wait synchronously before a follow-up query (tight read-after-write loop), or when you suspect the watcher missed an event. " +
        "Bounded by the disk walk: ~5–10s cold on spinning disk, sub-second with a warm pagecache. Concurrent callers share a single in-flight rebuild. " +
        "Reads served during the rebuild see the previous ready index — there's no zero-count window. Idempotent.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      // buildIndex catches its own errors and reports them via `state.error`,
      // surfaced here as `after.error`. No try/catch needed at this layer.
      const before = indexStatus();
      const t0 = Date.now();
      await buildIndex();
      const after = indexStatus();
      return ok({
        status: after.status,
        prev_count: before.count,
        count: after.count,
        duration_ms: Date.now() - t0,
        last_built_at: after.last_built_at,
        error: after.error,
      });
    }
  );

  return server;
}

async function main(): Promise<void> {
  const auth = loadAuthConfig();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Kick off the index build at startup. Fires async — the HTTP server starts
  // immediately and reports `index_status: "indexing"` on resolve/backlinks/
  // outlinks responses until the build finishes. Cold build is ~5–10s for
  // ~7,300 notes on Vultr's disk. Once the initial build is in, start the
  // vault watcher so subsequent vault mutations (this server's writes + the
  // obsidian-sync sidecar) trigger a debounced rebuild — see #23.
  buildIndex()
    .then(async () => {
      const s = indexStatus();
      console.error(
        `index: ${s.status} (${s.count} notes)${s.error ? ` — error: ${s.error}` : ""}`
      );
      if (s.status !== "ready") {
        console.error("watcher: skipped (index not ready)");
        return;
      }
      try {
        await startVaultWatcher({ vaultRoot: vaultRoot() });
      } catch (e) {
        console.error(`watcher: failed to start — ${e instanceof Error ? e.message : String(e)}`);
      }
    })
    .catch((e) => {
      console.error(`index: error — ${e instanceof Error ? e.message : String(e)}`);
    });

  // Health check (reachable locally / over your admin plane).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", vault: vaultRoot(), authEnabled: auth.enabled });
  });

  // Protected Resource Metadata (RFC 9728) — tells Claude which AS to use.
  // Always served (harmless when auth is off); required when auth is on.
  app.get(prmPath(), (_req, res) => {
    res.json(protectedResourceMetadata(auth));
  });

  // Stateless Streamable HTTP: a fresh transport+server per request avoids
  // request-id collisions and scales simply. Bearer auth gates it in Phase 2.
  app.post("/mcp", requireBearer(auth), async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  const port = parseInt(process.env.PORT ?? "8787", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => {
    console.error(`obsidian-vault-mcp-server on http://${host}:${port}/mcp  (vault: ${vaultRoot()})`);
    console.error(`auth: ${auth.enabled ? `enabled (issuer ${auth.issuer}, resource ${auth.resourceUrl})` : "DISABLED (Phase 1)"}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
