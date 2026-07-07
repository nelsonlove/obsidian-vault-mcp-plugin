/**
 * TDD tests for buildFront (packages/server/src/front.ts).
 *
 * Drives the unified front via a real ephemeral Express server (listen(0)) +
 * Node built-in fetch. Injects stub presence / fs / live deps into buildFront
 * so no real socket, vault index, or bridge.mjs process is needed.
 *
 * Assertions:
 *   1. presence.isLive()===true + valid static token → POST /mcp calls live.handle.
 *   2. presence.isLive()===false + valid token → POST /mcp calls fs.handle.
 *   3. Unauthenticated POST /mcp → 401; neither handler called; no body required.
 *   4. GET /health → 200 with mode reflecting presence.isLive(); flips on toggle.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type express from "express";
import { buildFront } from "../front.js";
import type { AuthConfig } from "../auth.js";

// ── Auth config — static-token only (enabled=false) ──────────────────────────
//
// Using cfg.enabled=false + a static token:
//   - valid Bearer <TOKEN> → next()
//   - anything else → 401 STATIC_CHALLENGE
// This is the simplest way to verify auth runs before body-parse and routing.

const cfg: AuthConfig = {
  enabled: false,
  resourceUrl: "",
  issuer: "",
  jwksUri: "",
  authorizationServers: [],
  scopesSupported: [],
};

const TOKEN = "test-static-secret-tok";

// ── Handler spy factory ────────────────────────────────────────────────────────

interface HandlerSpy {
  handle(req: express.Request, res: express.Response): Promise<void>;
  callCount: number;
  reset(): void;
}

function makeHandlerSpy(name: string): HandlerSpy {
  let calls = 0;
  return {
    async handle(_req: express.Request, res: express.Response): Promise<void> {
      calls++;
      res.status(200).json({ handled: name });
    },
    get callCount() {
      return calls;
    },
    reset() {
      calls = 0;
    },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("buildFront", () => {
  let server: http.Server;
  let port: number;
  // mutable — tests flip this to exercise both routing branches
  let liveState = true;

  let fsSpy: HandlerSpy;
  let liveSpy: HandlerSpy;

  before(async () => {
    fsSpy = makeHandlerSpy("fs");
    liveSpy = makeHandlerSpy("live");

    // Presence stub reads from the mutable liveState closure on every isLive() call
    const presence = { isLive: () => liveState };

    const app = buildFront({
      cfg,
      token: TOKEN,
      presence,
      fs: fsSpy,
      live: liveSpy,
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  });

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  function reset(): void {
    fsSpy.reset();
    liveSpy.reset();
  }

  // ── 1. Live mode: valid token + presence up → live.handle ─────────────────

  test("presence isLive=true + valid token → live.handle called, fs.handle not called", async () => {
    reset();
    liveState = true;

    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    assert.equal(resp.status, 200, "expect 200 from live stub");
    assert.equal(liveSpy.callCount, 1, "live.handle must be called exactly once");
    assert.equal(fsSpy.callCount, 0, "fs.handle must NOT be called when live");
  });

  // ── 2. Fallback mode: valid token + presence down → fs.handle ────────────

  test("presence isLive=false + valid token → fs.handle called, live.handle not called", async () => {
    reset();
    liveState = false;

    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    assert.equal(resp.status, 200, "expect 200 from fs stub");
    assert.equal(fsSpy.callCount, 1, "fs.handle must be called exactly once when presence is down");
    assert.equal(liveSpy.callCount, 0, "live.handle must NOT be called when presence is down");
  });

  // ── 3. Unauthenticated → 401, neither handler called, body not required ───
  //
  // The key invariant: body-parse is wired AFTER authGate, so an unauthenticated
  // request never forces a JSON parse — and therefore doesn't need a body at all.

  test("unauthenticated POST /mcp (no Authorization) → 401; neither handler called", async () => {
    reset();

    // No Authorization header, no body — proves auth fires before body-parse
    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
    });

    assert.equal(resp.status, 401, "must respond 401 for missing auth");
    assert.equal(fsSpy.callCount, 0, "fs.handle must NOT be called on 401");
    assert.equal(liveSpy.callCount, 0, "live.handle must NOT be called on 401");
  });

  // ── 4. GET /health reflects presence.isLive() dynamically ─────────────────
  //
  // /health must NOT require auth.  `mode` must flip when liveState changes.

  test("GET /health returns mode reflecting presence.isLive(); mode flips on toggle", async () => {
    // Live state → mode:"live"
    liveState = true;
    let resp = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(resp.status, 200, "health must return 200 (no auth required)");
    let body = (await resp.json()) as { status: string; mode: string; authEnabled: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.mode, "live", "mode must be 'live' when presence.isLive()===true");
    assert.equal(body.authEnabled, false, "authEnabled must match cfg.enabled");

    // Toggle to down → mode:"fs"
    liveState = false;
    resp = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(resp.status, 200);
    body = (await resp.json()) as { status: string; mode: string; authEnabled: boolean };
    assert.equal(body.mode, "fs", "mode must flip to 'fs' when presence.isLive()===false");
  });
});
