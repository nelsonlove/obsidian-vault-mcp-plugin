/**
 * fs-mode.ts — stateless FS-mode MCP handler factory.
 *
 * Extracts the per-request MCP handling from index.ts into a reusable factory
 * so the unified front (Task 5) can call it when Obsidian is offline.
 *
 * Usage:
 *   const fs = createFsHandler();
 *   await fs.ready();         // one-time: buildIndex + startVaultWatcher
 *   app.post("/mcp", (req, res) => fs.handle(req, res));
 *   // on shutdown:
 *   await fs.stop();          // closes the vault watcher
 *
 * The factory is behavior-preserving: handle() reproduces the per-request
 * logic that index.ts:buildServer() + the POST /mcp handler used to inline.
 * Response shapes are identical.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  findByTag,
  vaultRoot,
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
  registerFsTools,
} from "@vault-mcp/core";
import type { VaultBackend, VaultWatcherHandle } from "@vault-mcp/core";

// ── Public interface ──────────────────────────────────────────────────────────

export interface FsHandler {
  /** Per-request handler: builds a fresh stateless McpServer and serves it. */
  handle(req: express.Request, res: express.Response): Promise<void>;

  /**
   * One-time startup: runs buildIndex() + startVaultWatcher(). Idempotent —
   * calling twice returns the same Promise without rebuilding.
   */
  ready(): Promise<void>;

  /**
   * Close the vault watcher. Must be called in tests to avoid open handles.
   * Idempotent; resolves immediately if ready() was never called or the
   * watcher failed to start.
   */
  stop(): Promise<void>;
}

export interface FsHandlerOpts {
  /**
   * When true (the default), pass `indexStatus` to registerFsTools so every
   * read-tool response includes an `index_status` block. Set to false to
   * suppress it (e.g., when the live Obsidian backend is active).
   */
  indexStatus?: boolean;
}

// ── VaultBackend adapter ──────────────────────────────────────────────────────
//
// Wraps the module-level singleton functions from @vault-mcp/core so that
// registerFsTools can drive them through the VaultBackend interface. The
// singletons are pinned to VAULT_PATH at process start, which is the same
// root the vault watcher uses — keeping the index consistent.

export function makeBackend(): VaultBackend {
  return {
    listNotes: (subdir, limit, offset) => listNotes(subdir, limit, offset),

    listFolders: (subdir) => listFolders(subdir),

    readNote: (relPath) => readNote(relPath),

    searchNotes: (query, limit, mode) => searchNotes(query, limit, mode),

    findByTag: (tag, limit) => findByTag(tag, limit),

    searchByFrontmatter: async (property, value) => {
      const matches = searchByFrontmatter(property, value);
      return matches.map((n) => ({ path: n.path, frontmatter: n.frontmatter }));
    },

    resolve: (refs) => Promise.resolve(resolveRefs(refs)),

    getBacklinks: (notePath) => Promise.resolve(getBacklinks(notePath)),

    getOutlinks: (notePath) => Promise.resolve(getOutlinks(notePath)),

    forceReindex: () => buildIndex(),

    manageFrontmatter: async (relPath, key, op, value) => {
      if (op === "get") {
        return { value: await getFrontmatterField(relPath, key) };
      }
      if (op === "delete") {
        return deleteFrontmatterField(relPath, key);
      }
      // op === "set"
      if (value === undefined) {
        throw new Error("`value` is required for op='set'");
      }
      return setFrontmatterField(relPath, key, value);
    },

    patchNote: (relPath, anchor, op, content) => patchNote(relPath, anchor, op, content),

    writeNote: (relPath, content, overwrite) => writeNote(relPath, content, overwrite),

    appendNote: (relPath, content) => appendNote(relPath, content),

    moveNote: (fromRel, toRel, options) =>
      moveNote(fromRel, toRel, {
        update_backlinks: options.update_backlinks,
        overwrite: options.overwrite,
        backlinks_provider: getBacklinks,
        resolve_ref: (ref: string) => resolveRefs([ref])[0]?.path,
      }),

    deleteNote: (relPath, confirm) => deleteNote(relPath, confirm),
  };
}

// ── Server factory ────────────────────────────────────────────────────────────
//
// Exported so tests can build a server and wire it over InMemoryTransport
// without standing up a full Express + HTTP stack.

export function buildFsServer(opts?: FsHandlerOpts): McpServer {
  const server = new McpServer(
    { name: "obsidian-vault-mcp-server", version: "1.0.0" },
    // listChanged: true is required by Phase 2b (notifications/tools/list_changed);
    // harmless in Phase 2a but declared now so the capability is advertised.
    { capabilities: { tools: { listChanged: true } } },
  );

  registerFsTools(server, makeBackend(), {
    decodeHtml: true,
    includeIndexStatus: (opts?.indexStatus ?? true) ? indexStatus : undefined,
  });

  return server;
}

// ── Handler factory ───────────────────────────────────────────────────────────

export function createFsHandler(opts?: FsHandlerOpts): FsHandler {
  let readyPromise: Promise<void> | null = null;
  let watcher: VaultWatcherHandle | null = null;

  // Build the vault index + start the watcher. Idempotent; re-armed by stop().
  function ready(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      await buildIndex();
      const s = indexStatus();
      console.error(
        `index: ${s.status} (${s.count} notes)${s.error ? ` — error: ${s.error}` : ""}`,
      );
      if (s.status !== "ready") {
        console.error("watcher: skipped (index not ready)");
        return;
      }
      try {
        watcher = await startVaultWatcher({ vaultRoot: vaultRoot() });
      } catch (e) {
        console.error(
          `watcher: failed to start — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();

    return readyPromise;
  }

  async function stop(): Promise<void> {
    // Re-arm ready() so a later return to FS mode rebuilds the index + restarts
    // the watcher. The watcher must NOT run during LIVE mode: a live vault
    // watcher corrupts child_process fd setup under launchd and EBADFs the
    // bridge spawn (see front.ts wireFailover).
    readyPromise = null;
    if (!watcher) return;
    const w = watcher;
    watcher = null;
    try {
      await w.stop();
    } catch (e) {
      console.error(
        `watcher: stop failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    // ── Per-request handler ─────────────────────────────────────────────────
    async handle(req: express.Request, res: express.Response): Promise<void> {
      // Lazily build the index on first FS-mode use. In LIVE mode the FS
      // machinery (and its watcher) never starts, keeping the bridge spawn safe.
      await ready();
      const server = buildFsServer(opts);
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
    },

    ready,
    stop,
  };
}
