/**
 * TDD tests for createAuthGate (packages/server/src/auth.ts).
 *
 * Drives the gate as Express middleware via stub req/res/next objects.
 * JWT tests use a locally-generated EC key pair + local JWKS HTTP server
 * so no network access is required.
 *
 * Assertions:
 *   1. Static token match → next() (allowlist-exempt).
 *   2. cfg.enabled=false, no/wrong static → 401 with STATIC_CHALLENGE.
 *   3. cfg.enabled=true, no Authorization header → 401 with resource_metadata URL in WWW-Authenticate.
 *   4. Valid locally-signed JWT with allowlisted sub → next().
 *   5. Valid JWT with non-allowlisted sub → 403.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { createAuthGate, STATIC_CHALLENGE, type AuthConfig } from "../auth.js";

// ── Minimal Express stubs ─────────────────────────────────────────────────────

/** A minimal stub of Express's Request — only what the gate reads. */
function makeReq(authorization?: string): Request {
  const headers: Record<string, string | undefined> = { authorization };
  const stub = {
    headers,
    /** Express-compatible case-insensitive header lookup. */
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    method: "POST",
  };
  return stub as unknown as Request;
}

interface ResStub {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
  status(n: number): this;
  set(name: string, val: string): this;
  json(body: unknown): this;
}

function makeRes(): ResStub {
  return {
    _status: 0,
    _headers: {},
    _body: undefined,
    status(n: number) {
      this._status = n;
      return this;
    },
    set(name: string, val: string) {
      this._headers[name.toLowerCase()] = val;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
}

/**
 * Drive a gate handler and wait until either next() or res.json() is called.
 * createAuthGate returns a sync wrapper around an async impl; this helper
 * bridges the gap so tests can await the result.
 */
async function runGate(
  gate: RequestHandler,
  req: Request,
  res: ResStub,
): Promise<{ nextCalled: boolean; nextError?: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (nextCalled: boolean, nextError?: unknown) => {
      if (!settled) {
        settled = true;
        resolve({ nextCalled, nextError });
      }
    };

    const timer = setTimeout(() => reject(new Error("gate timed out after 5 s")), 5000);

    // Intercept res.json to detect that the gate sent a response.
    const origJson = res.json.bind(res);
    res.json = function (body: unknown) {
      clearTimeout(timer);
      const r = origJson(body);
      settle(false);
      return r;
    };

    const next: NextFunction = (err?: unknown) => {
      clearTimeout(timer);
      settle(true, err);
    };

    gate(req, res as unknown as Response, next);
  });
}

// ── Shared JWKS server (used by tests 4 & 5) ─────────────────────────────────

let privateKey!: KeyLike;
let jwksUri: string;
let jwksServer: http.Server;
const TEST_ISSUER = "https://test.issuer.example";
const TEST_RESOURCE = "https://test.resource.example";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createAuthGate", () => {
  before(async () => {
    const kp = await generateKeyPair("ES256");
    privateKey = kp.privateKey;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = "test-key-1";
    jwk.use = "sig";
    const jwksPayload = JSON.stringify({ keys: [jwk] });

    jwksServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwksPayload);
    });

    await new Promise<void>((resolve) =>
      jwksServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = jwksServer.address() as { port: number };
    jwksUri = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
  });

  after(() => {
    jwksServer.close();
  });

  // ── 1. Static token match ────────────────────────────────────────────────────

  test("static token match → next() (allowlist-exempt)", async () => {
    const cfg: AuthConfig = {
      enabled: false,
      resourceUrl: "",
      issuer: "",
      jwksUri: "",
      authorizationServers: [],
      scopesSupported: [],
    };
    const gate = createAuthGate(cfg, { token: "my-secret-token" });
    const req = makeReq("Bearer my-secret-token");
    const res = makeRes();

    const { nextCalled } = await runGate(gate, req, res);

    assert.equal(nextCalled, true, "next() must be called for matching static token");
    assert.equal(res._status, 0, "no status should be set when auth succeeds");
  });

  // ── 2. Disabled auth, no/wrong static → 401 with STATIC_CHALLENGE ────────────

  test("cfg.enabled=false, no auth → 401 with STATIC_CHALLENGE", async () => {
    const cfg: AuthConfig = {
      enabled: false,
      resourceUrl: "",
      issuer: "",
      jwksUri: "",
      authorizationServers: [],
      scopesSupported: [],
    };
    const gate = createAuthGate(cfg, { token: "my-secret-token" });
    const req = makeReq(); // no Authorization header
    const res = makeRes();

    const { nextCalled } = await runGate(gate, req, res);

    assert.equal(nextCalled, false, "next() must not be called");
    assert.equal(res._status, 401);
    assert.equal(
      res._headers["www-authenticate"],
      STATIC_CHALLENGE,
      "WWW-Authenticate must be the plain static challenge",
    );
  });

  test("cfg.enabled=false, wrong static token → 401 with STATIC_CHALLENGE", async () => {
    const cfg: AuthConfig = {
      enabled: false,
      resourceUrl: "",
      issuer: "",
      jwksUri: "",
      authorizationServers: [],
      scopesSupported: [],
    };
    const gate = createAuthGate(cfg, { token: "my-secret-token" });
    // wrong token (same length → triggers same-length non-JWT path when OAuth is on,
    // but with enabled=false, falls through to the !cfg.enabled branch first)
    const req = makeReq("Bearer not-the-right-t");
    const res = makeRes();

    const { nextCalled } = await runGate(gate, req, res);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 401);
    assert.equal(res._headers["www-authenticate"], STATIC_CHALLENGE);
  });

  // ── 3. OAuth on, no credential → 401 with resource_metadata URL ───────────────

  test("cfg.enabled=true, no authorization → 401 with resource_metadata in WWW-Authenticate", async () => {
    const cfg: AuthConfig = {
      enabled: true,
      resourceUrl: TEST_RESOURCE,
      issuer: TEST_ISSUER,
      jwksUri,
      authorizationServers: [TEST_ISSUER],
      scopesSupported: ["vault.read"],
    };
    // Set a minimal allowlist so the gate doesn't assert AUTH_ALLOW_ANY_AUTHENTICATED
    // (that check is the entrypoint's job; the gate itself doesn't enforce it).
    process.env.AUTH_ALLOWED_SUBS = "irrelevant-for-this-test";
    const gate = createAuthGate(cfg, {});
    delete process.env.AUTH_ALLOWED_SUBS;

    const req = makeReq(); // no Authorization header
    const res = makeRes();

    const { nextCalled } = await runGate(gate, req, res);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 401);
    assert.ok(
      res._headers["www-authenticate"]?.includes("resource_metadata="),
      `WWW-Authenticate must contain resource_metadata, got: "${res._headers["www-authenticate"]}"`,
    );
    // The resource_metadata URL must be pinned to the resource's origin (not attacker-controlled).
    assert.ok(
      res._headers["www-authenticate"]?.includes("test.resource.example"),
      "resource_metadata URL must reference the resource's own origin",
    );
  });

  // ── 4. Valid JWT with allowlisted sub → next() ───────────────────────────────

  test("valid JWT with allowlisted sub → next()", async () => {
    process.env.AUTH_ALLOWED_SUBS = "user-allow-1234";
    try {
      const cfg: AuthConfig = {
        enabled: true,
        resourceUrl: TEST_RESOURCE,
        issuer: TEST_ISSUER,
        jwksUri,
        authorizationServers: [TEST_ISSUER],
        scopesSupported: ["vault.read"],
      };
      const gate = createAuthGate(cfg, {});

      const jwt = await new SignJWT({ sub: "user-allow-1234" })
        .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_RESOURCE)
        .setExpirationTime("1h")
        .sign(privateKey);

      const req = makeReq(`Bearer ${jwt}`);
      const res = makeRes();
      const { nextCalled } = await runGate(gate, req, res);

      assert.equal(nextCalled, true, "next() must be called for valid JWT with allowlisted sub");
      assert.equal(res._status, 0, "no error status for successful auth");
    } finally {
      delete process.env.AUTH_ALLOWED_SUBS;
    }
  });

  // ── 5. Valid JWT with non-allowlisted sub → 403 ──────────────────────────────

  test("valid JWT with non-allowlisted sub → 403", async () => {
    process.env.AUTH_ALLOWED_SUBS = "user-allow-1234";
    try {
      const cfg: AuthConfig = {
        enabled: true,
        resourceUrl: TEST_RESOURCE,
        issuer: TEST_ISSUER,
        jwksUri,
        authorizationServers: [TEST_ISSUER],
        scopesSupported: ["vault.read"],
      };
      const gate = createAuthGate(cfg, {});

      const jwt = await new SignJWT({ sub: "user-not-in-allowlist" })
        .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
        .setIssuer(TEST_ISSUER)
        .setAudience(TEST_RESOURCE)
        .setExpirationTime("1h")
        .sign(privateKey);

      const req = makeReq(`Bearer ${jwt}`);
      const res = makeRes();
      const { nextCalled } = await runGate(gate, req, res);

      assert.equal(nextCalled, false, "next() must not be called for non-allowlisted sub");
      assert.equal(res._status, 403, "response must be 403 Forbidden");
    } finally {
      delete process.env.AUTH_ALLOWED_SUBS;
    }
  });
});
