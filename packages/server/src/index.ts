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
import type { VaultBackend } from "@vault-mcp/core";
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
 *
 * Tool schemas and registration are delegated to registerFsTools() from
 * @vault-mcp/core, which iterates FS_TOOLS so schemas are defined once
 * (no inline duplication). Response envelopes are shaped in the handlers
 * inside register-fs-tools.ts; see that file for per-tool notes.
 */

// ── Module-level VaultBackend adapter ────────────────────────────────────────
//
// Wraps the module-level singleton functions from @vault-mcp/core so that
// registerFsTools can drive them through the VaultBackend interface. The
// module-level singletons are pinned to VAULT_PATH at process start, which
// is the same root the vault watcher uses — keeping the index consistent.

function makeBackend(): VaultBackend {
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

function buildServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-vault-mcp-server",
    version: "1.0.0",
  });

  registerFsTools(server, makeBackend(), {
    decodeHtml: true,
    includeIndexStatus: indexStatus,
  });

  return server;
}

// ── HTTP entry-point ──────────────────────────────────────────────────────────

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
        `index: ${s.status} (${s.count} notes)${s.error ? ` — error: ${s.error}` : ""}`,
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
    console.error(
      `auth: ${auth.enabled ? `enabled (issuer ${auth.issuer}, resource ${auth.resourceUrl})` : "DISABLED (Phase 1)"}`,
    );
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
