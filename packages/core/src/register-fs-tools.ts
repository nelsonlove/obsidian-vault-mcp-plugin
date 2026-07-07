/**
 * registerFsTools — wire the 17 FS_TOOLS definitions onto an MCP server.
 *
 * Iterates FS_TOOLS and calls server.registerTool for each, supplying a
 * handler that dispatches to the provided VaultBackend. Response envelopes
 * match the server's pre-refactor shapes exactly so callers see no change.
 *
 * No dependency on @modelcontextprotocol/sdk here — the server parameter is
 * typed as a structural duck type that McpServer satisfies.
 */

import type { VaultBackend, FrontmatterEditValue } from "./vault-backend.js";
import { FS_TOOLS } from "./tool-registry.js";
import { ok, fail } from "./responses.js";
import { CHARACTER_LIMIT, decodeHtmlEntities } from "./fs-backend/vault.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Snapshot returned by includeIndexStatus. Typed for use inside the
 * obsidian_force_reindex handler which needs to read status fields.
 */
export interface IndexStatusSnapshot {
  status: string;
  count: number;
  last_built_at?: string;
  error?: string;
}

export interface RegisterFsToolsOpts {
  /**
   * When true, run decodeHtmlEntities on every string argument before passing
   * it to the backend. Required for the remote HTTP server (HTML entities can
   * arrive from some MCP clients); leave false for the in-process plugin.
   */
  decodeHtml?: boolean;
  /**
   * When provided, the return value is merged into every read-tool response as
   * `index_status`. Also read before/after for obsidian_force_reindex timing.
   */
  includeIndexStatus?: () => IndexStatusSnapshot;
}

/**
 * Minimal duck-type for McpServer.registerTool — satisfied structurally by the
 * real McpServer from @modelcontextprotocol/sdk without importing it here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistrar = { registerTool(name: string, meta: any, handler: (args: any) => any): any };

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Register all 17 FS_TOOLS on `server` using `backend` as the implementation.
 *
 * The schemas (name / title / description / inputSchema / annotations) come
 * exclusively from FS_TOOLS — no inline duplication. Handlers shape responses
 * to match the remote server's pre-existing public contract.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerFsTools(server: any, backend: VaultBackend, opts: RegisterFsToolsOpts = {}): void {
  const reg = server as ToolRegistrar;
  const { decodeHtml = false, includeIndexStatus } = opts;

  const dec = (s: string): string => (decodeHtml ? decodeHtmlEntities(s) : s);
  const status = (): { index_status: IndexStatusSnapshot } | Record<string, never> =>
    includeIndexStatus ? { index_status: includeIndexStatus() } : {};

  for (const tool of FS_TOOLS) {
    const handler = makeHandler(tool.name, backend, dec, includeIndexStatus);
    reg.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      handler,
    );
  }

  // status is used only inside makeHandler; reference it to satisfy TS.
  void status;
}

// ── Per-tool handler factory ──────────────────────────────────────────────────

function makeHandler(
  name: string,
  backend: VaultBackend,
  dec: (s: string) => string,
  includeIndexStatus: (() => IndexStatusSnapshot) | undefined,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    includeIndexStatus ? { ...extra, index_status: includeIndexStatus() } : extra;

  switch (name) {
    // ── obsidian_list_notes ────────────────────────────────────────────────
    case "obsidian_list_notes":
      return async ({ subdir, limit, offset }: { subdir?: string; limit: number; offset: number }) => {
        try {
          const decodedSubdir = subdir ? dec(subdir) : undefined;
          const { total, notes } = await backend.listNotes(decodedSubdir, limit, offset);
          return ok(status({
            total,
            count: notes.length,
            offset,
            notes,
            has_more: offset + notes.length < total,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_list_folders ──────────────────────────────────────────────
    case "obsidian_list_folders":
      return async ({ subdir }: { subdir?: string }) => {
        try {
          const decoded = subdir ? dec(subdir) : undefined;
          const folders = await backend.listFolders(decoded);
          return ok({ subdir: decoded ?? null, count: folders.length, folders });
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_read_note ─────────────────────────────────────────────────
    case "obsidian_read_note":
      return async ({ path: p }: { path: string }) => {
        try {
          const decoded = dec(p);
          return ok(status({ path: decoded, content: await backend.readNote(decoded) }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_read_notes ────────────────────────────────────────────────
    case "obsidian_read_notes":
      return async ({ paths }: { paths: string[] }) => {
        type Result =
          | { idx: number; kind: "ok"; value: { path: string; content: string; truncated: boolean } }
          | { idx: number; kind: "err"; value: { path: string; error: string } };

        // Preserve input order even when duplicate paths are provided.
        const results: Result[] = await Promise.all(
          paths.map(async (raw, idx): Promise<Result> => {
            const p = dec(raw);
            try {
              const content = await backend.readNote(p);
              // readNote truncates and appends a trailer when len > CHARACTER_LIMIT,
              // so the returned content is CHARACTER_LIMIT + len(trailer) chars.
              // content.length > CHARACTER_LIMIT thus correctly flags truncation.
              return { idx, kind: "ok", value: { path: p, content, truncated: content.length > CHARACTER_LIMIT } };
            } catch (e) {
              return { idx, kind: "err", value: { path: p, error: e instanceof Error ? e.message : String(e) } };
            }
          })
        );
        results.sort((a, b) => a.idx - b.idx);
        const notes = results
          .filter((r): r is Extract<Result, { kind: "ok" }> => r.kind === "ok")
          .map((r) => r.value);
        const errors = results
          .filter((r): r is Extract<Result, { kind: "err" }> => r.kind === "err")
          .map((r) => r.value);
        return ok(status({ count: notes.length, error_count: errors.length, notes, errors }));
      };

    // ── obsidian_search_notes ──────────────────────────────────────────────
    case "obsidian_search_notes":
      return async ({ query, limit, mode }: { query: string; limit: number; mode: "one_per_note" | "all" }) => {
        try {
          const decodedQuery = dec(query);
          const hits = await backend.searchNotes(decodedQuery, limit, mode);
          return ok(status({ query: decodedQuery, mode, count: hits.length, hits }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_find_by_tag ───────────────────────────────────────────────
    case "obsidian_find_by_tag":
      return async ({ tag, limit }: { tag: string; limit: number }) => {
        try {
          const decodedTag = dec(tag);
          const notes = await backend.findByTag(decodedTag, limit);
          return ok(status({
            tag: decodedTag.replace(/^#/, ""),
            count: notes.length,
            notes,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_search_by_frontmatter ─────────────────────────────────────
    case "obsidian_search_by_frontmatter":
      return async ({ property, value, limit }: { property: string; value: string; limit: number }) => {
        try {
          const decodedValue = dec(value);
          // Backend returns all matches uncapped; we apply the limit here.
          const matches = await backend.searchByFrontmatter(property, decodedValue);
          const notes = matches.slice(0, limit).map((n) => ({ path: n.path }));
          return ok(status({
            property,
            value: decodedValue,
            total: matches.length,
            count: notes.length,
            notes,
            has_more: matches.length > limit,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_resolve ───────────────────────────────────────────────────
    case "obsidian_resolve":
      return async ({ refs }: { refs: string[] }) => {
        try {
          const decoded = refs.map(dec);
          const results = await backend.resolve(decoded);
          const resolved = results.filter((r) => r.path !== undefined);
          const ambiguous = results.filter((r) => r.ambiguous !== undefined);
          const unresolved = results.filter((r) => r.path === undefined && r.ambiguous === undefined);
          return ok(status({ resolved, ambiguous, unresolved }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_get_backlinks ─────────────────────────────────────────────
    case "obsidian_get_backlinks":
      return async ({ path: p }: { path: string }) => {
        try {
          const decoded = dec(p);
          const backlinks = await backend.getBacklinks(decoded);
          return ok(status({ path: decoded, count: backlinks.length, backlinks }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_get_outlinks ──────────────────────────────────────────────
    case "obsidian_get_outlinks":
      return async ({ path: p }: { path: string }) => {
        try {
          const decoded = dec(p);
          const outlinks = await backend.getOutlinks(decoded);
          return ok(status({ path: decoded, count: outlinks.length, outlinks }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_force_reindex ─────────────────────────────────────────────
    // Real synchronous rebuild (not no-op). Returns timing + before/after counts.
    case "obsidian_force_reindex":
      return async () => {
        const before = includeIndexStatus ? includeIndexStatus() : { status: "unknown", count: 0 };
        const t0 = Date.now();
        // buildIndex catches its own errors; they surface in after.error.
        await backend.forceReindex();
        const after = includeIndexStatus ? includeIndexStatus() : { status: "ready", count: 0 };
        return ok({
          status: after.status,
          prev_count: before.count,
          count: after.count,
          duration_ms: Date.now() - t0,
          last_built_at: after.last_built_at,
          error: after.error,
        });
      };

    // ── obsidian_manage_frontmatter ────────────────────────────────────────
    case "obsidian_manage_frontmatter":
      return async ({
        path: p,
        key,
        op,
        value,
      }: {
        path: string;
        key: string;
        op: "get" | "set" | "delete";
        value?: FrontmatterEditValue;
      }) => {
        try {
          const decodedPath = dec(p);
          if (op === "get") {
            const r = await backend.manageFrontmatter(decodedPath, key, "get");
            return ok({ path: decodedPath, key, op, value: r.value });
          }
          if (op === "delete") {
            const r = await backend.manageFrontmatter(decodedPath, key, "delete");
            return ok({ path: decodedPath, key, op, existed: r.existed, previous: r.previous });
          }
          // op === "set"
          if (value === undefined) {
            return fail(new Error("`value` is required for op='set'"));
          }
          const r = await backend.manageFrontmatter(decodedPath, key, "set", value);
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
      };

    // ── obsidian_patch_note ────────────────────────────────────────────────
    case "obsidian_patch_note":
      return async ({
        path: p,
        anchor_type,
        anchor,
        op,
        content,
      }: {
        path: string;
        anchor_type: "heading" | "block";
        anchor: string;
        op: "append" | "prepend" | "replace";
        content: string;
      }) => {
        try {
          const decodedPath = dec(p);
          // Block IDs must be alphanumeric + dash/underscore by Obsidian convention.
          if (anchor_type === "block" && !/^[A-Za-z0-9_-]+$/.test(anchor)) {
            return fail(new Error(`Block anchor must match [A-Za-z0-9_-]+. Got: '${anchor}'`));
          }
          const result = await backend.patchNote(
            decodedPath,
            { type: anchor_type, value: anchor },
            op,
            content,
          );
          return ok({ path: decodedPath, ...result });
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_write_note ────────────────────────────────────────────────
    case "obsidian_write_note":
      return async ({ path: p, content, overwrite }: { path: string; content: string; overwrite: boolean }) => {
        try {
          return ok(await backend.writeNote(dec(p), content, overwrite));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_append_note ───────────────────────────────────────────────
    case "obsidian_append_note":
      return async ({ path: p, content }: { path: string; content: string }) => {
        try {
          return ok(await backend.appendNote(dec(p), content));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_move_note ─────────────────────────────────────────────────
    case "obsidian_move_note":
      return async ({
        from,
        to,
        update_backlinks,
        overwrite,
      }: {
        from: string;
        to: string;
        update_backlinks: boolean;
        overwrite: boolean;
      }) => {
        try {
          const decodedFrom = dec(from);
          const decodedTo = dec(to);
          const r = await backend.moveNote(decodedFrom, decodedTo, { update_backlinks, overwrite });
          return ok(status({ ...r }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_delete_note ───────────────────────────────────────────────
    case "obsidian_delete_note":
      return async ({ path: p, confirm }: { path: string; confirm: true }) => {
        try {
          const decodedPath = dec(p);
          const r = await backend.deleteNote(decodedPath, confirm);
          return ok(r);
        } catch (e) {
          return fail(e);
        }
      };

    default:
      // Should never happen if FS_TOOLS is in sync with this switch.
      throw new Error(`registerFsTools: no handler for tool "${name}"`);
  }
}
