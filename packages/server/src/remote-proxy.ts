import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  loadAuthConfig,
  protectedResourceMetadata,
  prmPath,
  createAuthGate,
  isAllowlistActive,
  isAllowAnyAuthenticated,
} from "./auth.js";

/**
 * obsidian-vault-mcp-server — remote-proxy (plugin-backed remote mode)
 *
 * A thin, transport-level bridge that exposes the *in-Obsidian* `vault-mcp`
 * plugin as a REMOTE Streamable-HTTP MCP server. Unlike the filesystem server
 * in `index.ts` (which edits markdown on disk), this proxy forwards every MCP
 * message, unchanged, to the plugin's stdio `bridge.mjs` — so all reads AND
 * writes go THROUGH Obsidian's own APIs (canonical metadata, sync-safe).
 *
 *   Claude (HTTP) ─► StreamableHTTPServerTransport ─┐
 *                                                   │  raw JSON-RPC pipe
 *                    StdioClientTransport ◄─────────┘
 *                         │ spawns
 *                    node ~/.claude/vault-mcp/bridge.mjs ─► unix socket ─► plugin
 *
 * One `bridge.mjs` backend is spawned per MCP session (the plugin builds a
 * fresh server per socket connection, so sessions stay isolated). The proxy is
 * a dumb passthrough: it never parses tool schemas, so the full `obsidian_*`
 * toolset flows through with no re-declaration.
 *
 * Auth (dual): a request is accepted if it presents EITHER
 *   (a) the static Bearer token VAULT_MCP_TOKEN — the Claude Code / Claude API
 *       path (those clients send `Authorization: Bearer <token>`); or
 *   (b) a valid OAuth 2.1 JWT bound to this resource — the claude.ai **web**
 *       path, which is OAuth-only. Enabled via AUTH_ENABLED + the AUTH_* env
 *       (see auth.ts); the PRM discovery doc is served at prmPath() so Claude
 *       can find the authorization server.
 * At least one method must be configured or the proxy refuses to start (it must
 * never serve a public endpoint unauthenticated).
 */

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.VAULT_MCP_TOKEN ?? "";
const BRIDGE =
  process.env.VAULT_MCP_BRIDGE ??
  path.join(homedir(), ".claude", "vault-mcp", "bridge.mjs");
// Reap sessions idle longer than this. MCP clients don't reliably send a DELETE
// on disconnect, so without reaping each connection would leak its bridge.mjs
// backend. Real client disconnects fire the transport's onclose promptly; the
// reaper is only a backstop for that, so the window is generous (30 min) to
// avoid tearing down a live-but-idle session mid-conversation. A client whose
// session was reaped simply re-initializes on the next 404. Tune via env.
const IDLE_MS = Number(process.env.VAULT_MCP_IDLE_MS ?? 30 * 60 * 1000);
const REAP_MS = 60 * 1000;
// Hard cap on concurrent bridge.mjs backends (registered + pending init), so a
// retry loop or probe flood can't spawn unbounded node processes and starve the
// interactive Obsidian app the proxy depends on.
const MAX_SESSIONS = Number(process.env.VAULT_MCP_MAX_SESSIONS ?? 32);
// Tear down a backend whose initialize never completes within this window
// (abandoned/malformed initialize would otherwise orphan it — onsessioninitialized
// never fires, so the reaper, which only walks registered sessions, can't see it).
const PENDING_INIT_MS = 30 * 1000;

// OAuth resource-server config (provider-agnostic, env-driven; no-op unless
// AUTH_ENABLED is truthy). Throws on AUTH_ENABLED with missing AUTH_* vars.
const authConfig = loadAuthConfig();

if (!TOKEN && !authConfig.enabled) {
  console.error(
    "[remote-proxy] refusing to start: no auth configured. Set VAULT_MCP_TOKEN " +
      "(static Bearer) and/or AUTH_ENABLED=true with the AUTH_* vars (OAuth). " +
      "A public endpoint must never run unauthenticated.",
  );
  process.exit(1);
}

// Fail CLOSED: with OAuth on but no allowlist, EVERY valid token would be
// accepted — on a public-sign-up AS that's an open vault. Refuse to start unless
// an allowlist is set, or the operator explicitly opts into "any authenticated".
if (authConfig.enabled && !isAllowlistActive() && !isAllowAnyAuthenticated()) {
  console.error(
    "[remote-proxy] refusing to start: AUTH_ENABLED=true with no AUTH_ALLOWED_SUBS / " +
      "AUTH_ALLOWED_EMAILS. A valid token would grant vault access to ANY user who can " +
      "sign up at the AS. Set an allowlist, or AUTH_ALLOW_ANY_AUTHENTICATED=true to opt in.",
  );
  process.exit(1);
}

/**
 * Dual-auth gate for /mcp. Runs BEFORE the body parser (so unauthenticated
 * requests can't force a 10 MB parse) and reads only the Authorization header.
 *
 * Delegates to createAuthGate in auth.ts (moved there so the unified front can
 * reuse the same gate for both plugin-proxy and future local modes).
 */
const authGate = createAuthGate(authConfig, { token: TOKEN });

/** True if a JSON-RPC body (single or batch) contains an `initialize` request. */
function isInitialize(body: unknown): boolean {
  const one = (m: unknown) =>
    !!m && typeof m === "object" && (m as { method?: string }).method === "initialize";
  return Array.isArray(body) ? body.some(one) : one(body);
}

interface Session {
  http: StreamableHTTPServerTransport;
  backend: StdioClientTransport;
  lastSeen: number;
}
const sessions = new Map<string, Session>();
// Counts every live backend, including ones still mid-initialize (not yet in
// `sessions`), so MAX_SESSIONS bounds the true process count.
let liveBackends = 0;

/**
 * Create a new session: a fresh HTTP transport wired straight to a freshly
 * spawned `bridge.mjs`. Messages are piped at the transport level in both
 * directions; closing either end tears down the other. A pending-init timer
 * reaps the backend if the client never finishes initializing.
 */
async function makeSession(): Promise<StreamableHTTPServerTransport> {
  const backend = new StdioClientTransport({
    command: process.execPath, // node
    args: [BRIDGE],
    stderr: "inherit",
  });
  liveBackends++;

  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      clearTimeout(initTimer);
      sessions.set(sid, { http, backend, lastSeen: Date.now() });
      console.error(`[remote-proxy] session ${sid} opened (${liveBackends} live)`);
    },
  });

  let torndown = false;
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    clearTimeout(initTimer);
    liveBackends--;
    const sid = http.sessionId;
    if (sid) sessions.delete(sid);
    backend.close().catch(() => {});
    http.close().catch(() => {});
    console.error(`[remote-proxy] session ${sid ?? "(uninitialized)"} closed (${liveBackends} live)`);
  };

  // Client → plugin. If the backend is gone, answer the pending request with a
  // JSON-RPC error instead of silently dropping it (client would otherwise hang).
  http.onmessage = (msg: JSONRPCMessage) => {
    backend.send(msg).catch((e) => {
      console.error("[remote-proxy] backend.send failed", e);
      const id = (msg as { id?: string | number | null }).id;
      if (id !== undefined && id !== null) {
        http
          .send({ jsonrpc: "2.0", id, error: { code: -32001, message: "backend unavailable" } })
          .catch(() => {});
      }
    });
  };
  // Plugin → client.
  backend.onmessage = (msg: JSONRPCMessage) => {
    http.send(msg).catch((e) => console.error("[remote-proxy] http.send failed", e));
  };

  http.onclose = teardown;
  backend.onclose = teardown;
  backend.onerror = (e) => console.error("[remote-proxy] backend error", e);

  const initTimer = setTimeout(() => {
    if (!torndown && !http.sessionId) {
      console.error("[remote-proxy] initialize did not complete; reaping orphan backend");
      teardown();
    }
  }, PENDING_INIT_MS);
  initTimer.unref();

  await backend.start();
  await http.start();
  return http;
}

const app = express();

// Body parsing is scoped to the /mcp routes and applied AFTER authGate, so an
// unauthenticated caller can't force a 10 MB JSON parse before the 401.
const parseBody = express.json({ limit: "10mb" });

// Minimal liveness probe. Leaks nothing about the host (no paths, no session
// details); `authEnabled` lets an operator confirm the OAuth path is engaged.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", authEnabled: authConfig.enabled });
});

// OAuth Protected Resource Metadata (RFC 9728) — how claude.ai web discovers the
// authorization server. Public by spec (it names the AS, no secrets). Served at
// both the bare path and the resource-scoped path (RFC 9728 §3 path-insertion for
// the /mcp resource) so either discovery probe works. Only when OAuth is enabled.
if (authConfig.enabled) {
  const prm = (_req: Request, res: Response) => res.json(protectedResourceMetadata(authConfig));
  app.get(prmPath(), prm);
  app.get(`${prmPath()}/mcp`, prm);
}

/** Resolve the HTTP transport for a request, creating a session on initialize. */
async function route(
  req: Request,
): Promise<StreamableHTTPServerTransport | { error: number; message: string }> {
  const sid = req.header("mcp-session-id");
  if (sid) {
    const s = sessions.get(sid);
    if (!s) return { error: 404, message: "unknown or expired session" };
    s.lastSeen = Date.now();
    return s.http;
  }
  if (isInitialize(req.body)) {
    if (liveBackends >= MAX_SESSIONS) {
      return { error: 503, message: "too many active sessions; try again shortly" };
    }
    return makeSession();
  }
  return { error: 400, message: "missing Mcp-Session-Id (no active session)" };
}

for (const method of ["post", "get", "delete"] as const) {
  app[method]("/mcp", authGate, parseBody, async (req, res) => {
    try {
      const r = await route(req);
      if ("error" in r) {
        res.status(r.error).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: r.message },
          id: null,
        });
        return;
      }
      await r.handleRequest(req, res, req.body);
    } catch (e) {
      // The usual cause here is the backend dying (Obsidian closed / vault-mcp
      // plugin disabled / socket gone), so surface that distinctly from a real
      // proxy bug rather than an opaque 500.
      console.error("[remote-proxy] handler error", e);
      if (!res.headersSent) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "backend unavailable — is Obsidian running with the vault-mcp plugin?",
          },
          id: null,
        });
      }
    }
  });
}

// Turn body-parser failures (notably oversized payloads) into JSON-RPC errors
// instead of Express's default HTML error page, which an MCP client can't parse.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const e = err as { type?: string; message?: string };
  const tooLarge = e?.type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({
    jsonrpc: "2.0",
    error: { code: -32600, message: tooLarge ? "request body too large" : e?.message ?? "bad request" },
    id: null,
  });
});

// Reap idle sessions so orphaned bridge.mjs backends don't accumulate.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > IDLE_MS) {
      console.error(`[remote-proxy] reaping idle session ${sid}`);
      s.http.close().catch(() => {}); // triggers teardown → backend.close()
    }
  }
}, Math.min(REAP_MS, IDLE_MS));
reaper.unref();

app.listen(PORT, HOST, () => {
  console.error(`[remote-proxy] listening on http://${HOST}:${PORT}/mcp → ${BRIDGE}`);
});
