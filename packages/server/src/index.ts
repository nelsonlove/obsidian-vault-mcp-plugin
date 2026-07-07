import express from "express";
import { vaultRoot } from "@vault-mcp/core";
import {
  loadAuthConfig,
  protectedResourceMetadata,
  prmPath,
  requireBearer,
} from "./auth.js";
import { createFsHandler } from "./fs-mode.js";

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
 * @vault-mcp/core via createFsHandler() in fs-mode.ts, which keeps the
 * per-request logic and the one-time startup in one reusable factory.
 * This file stays a working standalone FS server until Task 7 retires it.
 */

// ── HTTP entry-point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const auth = loadAuthConfig();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Delegate all FS-mode MCP handling to the factory.
  // ready() kicks off buildIndex() + startVaultWatcher() — the HTTP server
  // starts immediately and reports `index_status: "indexing"` until the build
  // finishes. Cold build is ~5–10s for ~7,300 notes on Vultr's disk.
  const fs = createFsHandler();
  fs.ready().catch((e) => {
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
  app.post("/mcp", requireBearer(auth), (req, res) => {
    void fs.handle(req, res);
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
