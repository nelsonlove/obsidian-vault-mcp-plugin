/**
 * live-proxy — LIVE-mode session factory
 *
 * Extracts the HTTP ⇄ plugin-socket transport-level session machinery from
 * remote-proxy.ts into a reusable `createLiveProxy` factory.  The unified
 * front (Task 5) uses this when Obsidian is live; Task 6 uses notifyAll /
 * teardownAll to react to presence changes.
 *
 * Architecture:
 *
 *   createLiveProxy({ bridgePath })
 *     → LiveProxy.handle(req, res)
 *         route(req)
 *           makeSession()   ← spawns bridge.mjs (or opts.makeBackend stub)
 *             StdioClientTransport ←→ StreamableHTTPServerTransport
 *             (bidirectional message pipe at transport level)
 *
 * One bridge.mjs backend is spawned per MCP session.  Sessions are reaped
 * after IDLE_MS of inactivity; an orphan timer reaps sessions whose
 * initialize never completes within PENDING_INIT_MS.
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// ── Internal transport interfaces ─────────────────────────────────────────────

/**
 * Minimal interface for the HTTP-facing transport.
 * Satisfied by both StreamableHTTPServerTransport and test stubs.
 */
export interface HttpTransportLike {
  readonly sessionId: string | undefined;
  send(msg: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  start(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest(req: any, res: any, body?: unknown): Promise<void>;
  // Optional to match SDK's getter/setter pattern and Transport interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage?: any;
  onclose?: (() => void) | undefined;
}

/**
 * Minimal interface for the backend (stdio) transport.
 * Satisfied by both StdioClientTransport and test stubs.
 */
export interface BackendTransportLike {
  send(msg: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  start(): Promise<void>;
  // Optional to match SDK's Transport interface (all callbacks are optional there)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage?: any;
  onclose?: (() => void) | undefined;
  onerror?: ((err: Error) => void) | undefined;
}

// ── Session ───────────────────────────────────────────────────────────────────

interface Session {
  http: HttpTransportLike;
  backend: BackendTransportLike;
  lastSeen: number;
  /** Idempotent teardown — clears the session from the map and closes both transports. */
  _teardown: () => void;
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface LiveProxy {
  /** Handle an incoming /mcp request, routing it to an existing or new session. */
  handle(req: Request, res: Response): Promise<void>;
  /** Number of fully-initialized sessions (registered in the sessions Map). */
  sessionCount(): number;
  /** Sessions that are mid-initialize (liveBackends − registeredSessions). */
  pendingCount(): number;
  /**
   * Best-effort: send msg to every live session's HTTP transport.
   * Per-session errors are caught and suppressed (a session without an open
   * SSE channel will throw / reject; that's expected and harmless).
   */
  notifyAll(msg: object): void;
  /** Close every session (used when presence drops). Clears the sessions Map. */
  teardownAll(): void;
  /** Stop the idle-reaper interval (unref'd at creation, so this is mainly for clean test exit). */
  stop(): void;
  /**
   * TEST SEAM — directly register a session in the internal Map, bypassing the
   * HTTP initialize handshake.  Unit tests use this instead of spinning up a
   * real StreamableHTTPServerTransport + StdioClientTransport.
   * @internal — only for use in __tests__/
   */
  _registerSessionForTest(
    sid: string,
    http: HttpTransportLike,
    backend: BackendTransportLike,
  ): void;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Reap a backend whose initialize never completes within this window. */
const PENDING_INIT_MS = 30_000;
/** Interval at which the reaper walks the sessions Map. */
const REAP_MS = 60_000;

// ── Factory ───────────────────────────────────────────────────────────────────

export function createLiveProxy(opts: {
  /** Absolute path to bridge.mjs (used by the default makeBackend). */
  bridgePath: string;
  /** Max concurrent backends (registered + pending). Defaults to 32. */
  maxSessions?: number;
  /** Idle timeout in ms before a session is reaped. Defaults to 1 800 000 (30 min). */
  idleMs?: number;
  /**
   * Factory for the stdio backend transport.  Defaults to spawning bridge.mjs.
   * Override in tests to inject a stub and avoid spawning real processes.
   */
  makeBackend?: () => BackendTransportLike;
}): LiveProxy {
  const maxSessions = opts.maxSessions ?? 32;
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;

  const sessions = new Map<string, Session>();
  /**
   * Counts every live backend, including ones still mid-initialize (not yet in
   * `sessions`), so maxSessions bounds the true process count.
   */
  let liveBackends = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isInitialize(body: unknown): boolean {
    const one = (m: unknown) =>
      !!m && typeof m === "object" && (m as { method?: string }).method === "initialize";
    return Array.isArray(body) ? body.some(one) : one(body);
  }

  function makeDefaultBackend(): BackendTransportLike {
    return new StdioClientTransport({
      command: process.execPath, // node
      args: [opts.bridgePath],
      stderr: "inherit",
    });
  }

  // ── Session creation ────────────────────────────────────────────────────────

  /**
   * Spawn a new session: a fresh StdioClientTransport (bridge.mjs) wired
   * bidirectionally to a fresh StreamableHTTPServerTransport.  The session is
   * registered in `sessions` via onsessioninitialized once the client sends
   * its initialize request.
   */
  async function makeSession(): Promise<HttpTransportLike> {
    const backend = (opts.makeBackend ?? makeDefaultBackend)();
    liveBackends++;

    // Cast required: StreamableHTTPServerTransport satisfies HttpTransportLike
    // structurally, but TypeScript can't see that through the getter/setter pair
    // on onmessage.  The cast is safe — every method we call exists.
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        clearTimeout(initTimer);
        sessions.set(sid, { http: http as unknown as HttpTransportLike, backend, lastSeen: Date.now(), _teardown: teardown });
        console.error(`[live-proxy] session ${sid} opened (${liveBackends} live)`);
      },
    }) as unknown as HttpTransportLike;

    let torndown = false;
    const teardown = () => {
      if (torndown) return;
      torndown = true;
      clearTimeout(initTimer);
      liveBackends = Math.max(0, liveBackends - 1);
      const sid = http.sessionId;
      if (sid) sessions.delete(sid);
      backend.close().catch(() => {});
      http.close().catch(() => {});
      console.error(`[live-proxy] session ${sid ?? "(uninitialized)"} closed (${liveBackends} live)`);
    };

    // Client → plugin.  If the backend is gone, answer the pending request with a
    // JSON-RPC error instead of silently dropping it (client would otherwise hang).
    http.onmessage = (msg: JSONRPCMessage) => {
      backend.send(msg).catch((e: unknown) => {
        console.error("[live-proxy] backend.send failed", e);
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
      http.send(msg).catch((e: unknown) => console.error("[live-proxy] http.send failed", e));
    };

    http.onclose = teardown;
    backend.onclose = teardown;
    backend.onerror = (e: Error) => console.error("[live-proxy] backend error", e);

    // Reap the backend if the client never completes initialize within PENDING_INIT_MS.
    // onsessioninitialized clears this timer on success.  Orphaned initializes
    // would otherwise live until the next reaper pass (which only sees registered sessions).
    const initTimer = setTimeout(() => {
      if (!torndown && !http.sessionId) {
        console.error("[live-proxy] initialize did not complete; reaping orphan backend");
        teardown();
      }
    }, PENDING_INIT_MS);
    // unref so a hanging test/process isn't blocked waiting for this timer
    initTimer.unref();

    await backend.start();
    await http.start();
    return http;
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  async function route(
    req: Request,
  ): Promise<HttpTransportLike | { error: number; message: string }> {
    const sid = req.header("mcp-session-id");
    if (sid) {
      const s = sessions.get(sid);
      if (!s) return { error: 404, message: "unknown or expired session" };
      s.lastSeen = Date.now();
      return s.http;
    }
    if (isInitialize(req.body)) {
      if (liveBackends >= maxSessions) {
        return { error: 503, message: "too many active sessions; try again shortly" };
      }
      return makeSession();
    }
    return { error: 400, message: "missing Mcp-Session-Id (no active session)" };
  }

  // ── Idle reaper ────────────────────────────────────────────────────────────

  // Reap idle sessions so orphaned bridge.mjs backends don't accumulate.
  // MCP clients don't reliably send DELETE on disconnect; real disconnects fire
  // transport.onclose promptly, so this is a generous backstop.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        console.error(`[live-proxy] reaping idle session ${sid}`);
        s._teardown();
      }
    }
  }, Math.min(REAP_MS, idleMs));
  // CRITICAL: unref so `node --test` (and any other runner) can exit cleanly.
  // Without unref(), the interval keeps the event loop alive after all tests finish.
  reaper.unref();

  // ── LiveProxy implementation ───────────────────────────────────────────────

  return {
    async handle(req: Request, res: Response): Promise<void> {
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
        // The usual cause: backend died (Obsidian closed / plugin disabled / socket gone).
        // Surface that distinctly from a real proxy bug.
        console.error("[live-proxy] handler error", e);
        if (!((res as { headersSent?: boolean }).headersSent)) {
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
    },

    sessionCount(): number {
      return sessions.size;
    },

    pendingCount(): number {
      // liveBackends includes both registered (in map) and mid-initialize backends.
      return Math.max(0, liveBackends - sessions.size);
    },

    notifyAll(msg: object): void {
      for (const [, s] of sessions) {
        try {
          // best-effort: a session without an open SSE channel will reject — that's OK
          s.http.send(msg as JSONRPCMessage).catch(() => {});
        } catch {
          // per-session catch: don't let one broken session abort the rest
        }
      }
    },

    teardownAll(): void {
      // Snapshot and pre-clear the map so re-entrant teardown callbacks find it
      // empty (preventing double-dequeue while still allowing them to run once).
      const snapshot = [...sessions.values()];
      sessions.clear();
      for (const s of snapshot) {
        // Each _teardown() decrements liveBackends and closes the transports.
        // The torndown guard inside each closure prevents double-execution.
        s._teardown();
      }
      // Force reset to 0 to account for any pending (not-yet-registered) backends
      // that won't reach their own teardown paths after this point.
      liveBackends = 0;
    },

    stop(): void {
      clearInterval(reaper);
    },

    _registerSessionForTest(
      sid: string,
      http: HttpTransportLike,
      backend: BackendTransportLike,
    ): void {
      liveBackends++;
      let torndown = false;
      const teardown = () => {
        if (torndown) return;
        torndown = true;
        liveBackends = Math.max(0, liveBackends - 1);
        sessions.delete(sid);
        backend.close().catch(() => {});
        http.close().catch(() => {});
      };
      sessions.set(sid, { http, backend, lastSeen: Date.now(), _teardown: teardown });
    },
  };
}
