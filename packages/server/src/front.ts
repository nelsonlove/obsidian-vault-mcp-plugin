/**
 * front.ts — Unified presence-aware front for the Obsidian vault MCP server.
 *
 * ONE Express app that:
 *   1. Gates /mcp with shared auth (static bearer or OAuth 2.1 — same gate as
 *      remote-proxy.ts).
 *   2. Routes to the LIVE proxy (plugin-backed, 44 tools) when Obsidian's plugin
 *      Unix socket is reachable.
 *   3. Falls back to the FS handler (filesystem-only, 17 tools) otherwise.
 *
 * The endpoint therefore survives Obsidian closing (graceful degradation) and
 * automatically returns to LIVE mode when the plugin reopens.
 *
 * Usage (injectable, for testing):
 *   const app = buildFront({ cfg, token, presence, fs, live });
 *
 * Production entrypoint (module tail, only when executed directly):
 *   node dist/front.js
 */

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  loadAuthConfig,
  protectedResourceMetadata,
  prmPath,
  createAuthGate,
  isAllowlistActive,
  isAllowAnyAuthenticated,
  type AuthConfig,
} from "./auth.js";
import { createPresenceMonitor } from "./presence.js";
import { createFsHandler } from "./fs-mode.js";
import { createLiveProxy } from "./live-proxy.js";

// ── Injectable factory ────────────────────────────────────────────────────────

export interface FrontDeps {
  cfg: AuthConfig;
  token?: string;
  presence: { isLive(): boolean };
  fs: { handle(req: Request, res: Response): Promise<void> };
  live: { handle(req: Request, res: Response): Promise<void> };
}

export function buildFront(deps: FrontDeps): express.Express {
  const { cfg, token, presence, fs: fsHandler, live } = deps;

  const authGate = createAuthGate(cfg, { token });
  // Body parsing is scoped to /mcp and applied AFTER authGate so unauthenticated
  // callers cannot force a 10 MB JSON parse before the 401.
  const parseBody = express.json({ limit: "10mb" });

  const app = express();

  // Health — no auth, no body parse.
  // `mode` tells a monitor whether the proxy is in live or fallback mode.
  // `fsWriteSyncCaveat` flags that FS-mode writes bypass Obsidian's sync pipeline.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: presence.isLive() ? "live" : "fs",
      authEnabled: cfg.enabled,
      fsWriteSyncCaveat: true,
    });
  });

  // OAuth Protected Resource Metadata (RFC 9728) — tells claude.ai which AS to
  // use. Public by spec (names the AS, no secrets). Served at the bare path and
  // the resource-scoped /mcp variant so either discovery probe works. Only when
  // OAuth is enabled.
  if (cfg.enabled) {
    const prm = (_req: Request, res: Response): void => {
      res.json(protectedResourceMetadata(cfg));
    };
    app.get(prmPath(), prm);
    app.get(`${prmPath()}/mcp`, prm);
  }

  // MCP endpoint — auth gate, then body parse, then presence-based routing.
  // All three HTTP verbs are wired (POST = new/stateless, GET = SSE stream,
  // DELETE = session teardown) so the full Streamable HTTP protocol is supported.
  const handler = (req: Request, res: Response): void => {
    void (presence.isLive() ? live.handle(req, res) : fsHandler.handle(req, res));
  };

  for (const method of ["post", "get", "delete"] as const) {
    app[method]("/mcp", authGate, parseBody, handler);
  }

  // Turn body-parser failures (oversized payloads etc.) into JSON-RPC errors
  // instead of Express's default HTML error page, which an MCP client can't parse.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; message?: string };
    const tooLarge = e?.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: tooLarge ? "request body too large" : (e?.message ?? "bad request"),
      },
      id: null,
    });
  });

  return app;
}

// ── Presence-to-LIVE-proxy failover wiring ────────────────────────────────────
//
// Notifies open SSE channels (best-effort) that the tool surface changed, then
// tears down LIVE sessions when Obsidian closes.  New requests auto-route to FS
// mode via the request-time presence.isLive() check already in buildFront.
// FS-mode and POST-only clients discover the new surface on their next
// initialize (seamless push is Phase 2b).

const LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
  params: {},
} as const;

export function wireFailover(deps: {
  presence: { on(ev: "up" | "down", cb: () => void): void };
  live: { teardownAll(): void; notifyAll(msg: object): void };
}): void {
  const { presence, live } = deps;

  // When Obsidian closes: push list_changed to any open SSE channels, then
  // tear down live sessions (their plugin backend is gone).
  presence.on("down", () => {
    live.notifyAll(LIST_CHANGED);
    live.teardownAll();
  });

  // When Obsidian comes back: best-effort nudge; new connects resolve to LIVE
  // via the request-time isLive() check.  Do NOT tear down existing sessions.
  presence.on("up", () => {
    live.notifyAll(LIST_CHANGED);
  });
}

// ── Socket path resolution ────────────────────────────────────────────────────
//
// The plugin writes its Unix socket at `~/.claude/vault-mcp/<slug>.sock` where
// `slug` is the vault name lowercased with non-alphanumeric chars replaced by `-`.
// This mirrors the `vaultSlug()` + `socketPath()` helpers in packages/plugin/src/paths.ts
// without adding a cross-package dependency.
//
// Override order (highest priority first):
//   VAULT_MCP_SOCKET      — absolute path; use exactly as given
//   VAULT_MCP_STATE_DIR   — directory; slug derived from VAULT_PATH basename
//   (default)             — ~/.claude/vault-mcp/<slug>.sock

function resolveSocketPath(): string {
  if (process.env.VAULT_MCP_SOCKET) return process.env.VAULT_MCP_SOCKET;

  const stateDir =
    process.env.VAULT_MCP_STATE_DIR ??
    path.join(homedir(), ".claude", "vault-mcp");

  const vaultPath = process.env.VAULT_PATH ?? "./vault";
  const vaultName = path.basename(path.resolve(vaultPath));
  const slug = vaultName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return path.join(stateDir, `${slug}.sock`);
}

// ── Production entrypoint ─────────────────────────────────────────────────────
//
// Guarded by the isMain check so the module can be imported by tests without
// triggering the startup guards or process.exit() calls.

const _thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === _thisFile) {
  const PORT = Number(process.env.PORT ?? 8787);
  const HOST = process.env.HOST ?? "127.0.0.1";
  const TOKEN = process.env.VAULT_MCP_TOKEN ?? "";
  const BRIDGE =
    process.env.VAULT_MCP_BRIDGE ??
    path.join(homedir(), ".claude", "vault-mcp", "bridge.mjs");
  // Reap sessions idle longer than this. 30 min is generous enough to avoid tearing
  // down a live-but-idle session mid-conversation; clients re-initialize on the
  // next 404 if the session was reaped. Tune via VAULT_MCP_IDLE_MS.
  const IDLE_MS = Number(process.env.VAULT_MCP_IDLE_MS ?? 30 * 60 * 1000);
  // Hard cap on concurrent bridge.mjs backends to prevent process floods.
  const MAX_SESSIONS = Number(process.env.VAULT_MCP_MAX_SESSIONS ?? 32);

  const cfg = loadAuthConfig();

  // Fail-closed: a public endpoint must NEVER run unauthenticated.
  if (!TOKEN && !cfg.enabled) {
    console.error(
      "[front] refusing to start: no auth configured. Set VAULT_MCP_TOKEN " +
        "(static Bearer) and/or AUTH_ENABLED=true with the AUTH_* vars (OAuth). " +
        "A public endpoint must never run unauthenticated.",
    );
    process.exit(1);
  }

  // Fail-closed: OAuth on with no allowlist accepts EVERY valid token — on a
  // public-sign-up AS that is an open vault. Require opt-in.
  if (cfg.enabled && !isAllowlistActive() && !isAllowAnyAuthenticated()) {
    console.error(
      "[front] refusing to start: AUTH_ENABLED=true with no AUTH_ALLOWED_SUBS / " +
        "AUTH_ALLOWED_EMAILS. A valid token would grant vault access to ANY user " +
        "who can sign up at the AS. Set an allowlist, or AUTH_ALLOW_ANY_AUTHENTICATED=true " +
        "to opt in.",
    );
    process.exit(1);
  }

  const socketPath = resolveSocketPath();

  const presence = createPresenceMonitor({
    socketPath,
    pollMs: Number(process.env.VAULT_MCP_PRESENCE_POLL_MS ?? 5000),
  });

  const fsHandler = createFsHandler({ indexStatus: true });

  const liveProxy = createLiveProxy({
    bridgePath: BRIDGE,
    maxSessions: MAX_SESSIONS,
    idleMs: IDLE_MS,
  });

  const app = buildFront({ cfg, token: TOKEN, presence, fs: fsHandler, live: liveProxy });

  presence.start();
  wireFailover({ presence, live: liveProxy });

  fsHandler.ready().catch((e: unknown) => {
    console.error(
      `[front] fs index error — ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  app.listen(PORT, HOST, () => {
    console.error(
      `[front] listening on http://${HOST}:${PORT}/mcp — presence-aware (socket: ${socketPath})`,
    );
  });
}
