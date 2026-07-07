import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Resource-Server auth for the MCP endpoint (Phase 2).
 *
 * Per the MCP authorization spec, THIS server is an OAuth 2.1 *resource server*:
 * it does NOT issue tokens. A separate authorization server (AS) does. This
 * module:
 *   1. Serves the Protected Resource Metadata (PRM) document (RFC 9728) that
 *      tells Claude which AS to use.
 *   2. Validates the Bearer JWT on each request: signature (via the AS's JWKS),
 *      issuer, audience (RFC 8707 resource binding), and expiry.
 *   3. On failure, returns 401 with a WWW-Authenticate header carrying the
 *      resource_metadata URL, as the spec requires.
 *
 * It is intentionally provider-agnostic: point it at any compliant AS (Ory
 * Hydra, WorkOS, Stytch, Keycloak, ...) via env vars. Set AUTH_ENABLED=false to
 * run the Phase 1 authless mode unchanged.
 */

export interface AuthConfig {
  enabled: boolean;
  resourceUrl: string; // canonical identifier for THIS server (the audience)
  issuer: string; // AS issuer URL
  jwksUri: string; // AS JWKS endpoint
  authorizationServers: string[]; // advertised in PRM
  scopesSupported: string[];
}

export function loadAuthConfig(): AuthConfig {
  const enabled = ["true", "1", "yes", "on"].includes(
    (process.env.AUTH_ENABLED ?? "false").trim().toLowerCase(),
  );
  const resourceUrl = process.env.MCP_RESOURCE_URL ?? "";
  const issuer = process.env.AUTH_ISSUER ?? "";
  // Default JWKS to the conventional AS metadata location; override if your AS differs.
  const jwksUri = process.env.AUTH_JWKS_URI ?? (issuer ? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json` : "");
  const authorizationServers = (process.env.AUTH_SERVERS ?? issuer)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scopesSupported = (process.env.AUTH_SCOPES ?? "vault.read vault.write")
    .split(/[\s,]+/)
    .filter(Boolean);

  if (enabled) {
    const missing = [
      ["MCP_RESOURCE_URL", resourceUrl],
      ["AUTH_ISSUER", issuer],
      ["AUTH_JWKS_URI", jwksUri],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new Error(`AUTH_ENABLED=true but missing: ${missing.join(", ")}`);
    }
  }

  return { enabled, resourceUrl, issuer, jwksUri, authorizationServers, scopesSupported };
}

/** RFC 9728 Protected Resource Metadata document. */
export function protectedResourceMetadata(cfg: AuthConfig): Record<string, unknown> {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: cfg.authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: cfg.scopesSupported,
  };
}

export function prmPath(): string {
  return "/.well-known/oauth-protected-resource";
}

/**
 * This server's PRM URL, pinned from MCP_RESOURCE_URL's origin. Deliberately NOT
 * built from X-Forwarded-Host/Proto: those are client-controllable, and a rogue
 * value would steer the RFC 9728 discovery flow to an attacker-chosen AS.
 */
export function resourceMetadataUrl(cfg: AuthConfig): string {
  const origin = cfg.resourceUrl ? new URL(cfg.resourceUrl).origin : "";
  return `${origin}${prmPath()}`;
}

/** RFC 6750 WWW-Authenticate challenge pointing at this server's (pinned) PRM. */
export function bearerChallenge(cfg: AuthConfig, error?: string, desc?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl(cfg)}"`];
  if (error) parts.push(`error="${error}"`);
  if (desc) parts.push(`error_description="${desc}"`);
  return parts.join(", ");
}

/**
 * Validate a Bearer JWT against the AS's JWKS, issuer, and resource audience
 * (RFC 8707). Returns the payload on success, or null on any failure — no
 * jose-internal detail is surfaced to callers (avoids a validation oracle).
 */
export async function verifyBearer(cfg: AuthConfig, token: string): Promise<JWTPayload | null> {
  try {
    // AUTH_SKIP_AUD_CHECK is a bootstrap escape hatch for authorization servers
    // whose access-token `aud` doesn't match the resource URL (RFC 8707 not
    // honored). Signature + issuer are still enforced, and the proxy's sub/email
    // allowlist remains the authorization gate. Remove once the real aud is known.
    const skipAud = !!process.env.AUTH_SKIP_AUD_CHECK;
    const { payload } = await jwtVerify(token, getJwks(cfg), {
      issuer: cfg.issuer,
      ...(skipAud ? {} : { audience: cfg.resourceUrl }),
    });
    return payload;
  } catch {
    return null;
  }
}

// Cache the remote JWKS across requests (jose handles rotation/refresh internally).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(cfg: AuthConfig) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(cfg.jwksUri));
  return jwks;
}

export interface AuthedRequest extends Request {
  auth?: JWTPayload;
}

/**
 * Express middleware enforcing a valid Bearer token bound to this resource.
 * No-op when auth is disabled (Phase 1).
 */
export function requireBearer(cfg: AuthConfig) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!cfg.enabled) return next();

    const match = (req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res
        .status(401)
        .set("WWW-Authenticate", bearerChallenge(cfg, "invalid_request", "authentication required"))
        .json({ error: "unauthorized" });
      return;
    }

    const payload = await verifyBearer(cfg, match[1]);
    if (!payload) {
      res
        .status(401)
        .set("WWW-Authenticate", bearerChallenge(cfg, "invalid_token", "token rejected"))
        .json({ error: "unauthorized" });
      return;
    }
    req.auth = payload;
    next();
  };
}

/**
 * RFC 7662 token introspection — validate an OPAQUE access token against the
 * authorization server (e.g. Clerk issues opaque tokens by default). Returns the
 * introspection claims ({ active, sub, scope, ... }) when the token is active,
 * else null. Configured via AUTH_INTROSPECTION_URL + AUTH_CLIENT_ID/SECRET;
 * returns null (no-op) if unset. Authenticated with HTTP Basic client creds.
 */
export async function introspectToken(token: string): Promise<Record<string, unknown> | null> {
  const url = process.env.AUTH_INTROSPECTION_URL;
  const cid = process.env.AUTH_CLIENT_ID;
  const csec = process.env.AUTH_CLIENT_SECRET;
  if (!url || !cid || !csec) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(`${cid}:${csec}`).toString("base64"),
      },
      body: new URLSearchParams({ token }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // RFC 7662 `active` only proves the token is valid AT THE AS — not that it
    // was issued for THIS server's client. Bind it to our client_id (confused-
    // deputy guard): a token minted for a different OAuth app in the same
    // instance must not grant vault access.
    const ok = data.active === true && data.client_id === cid;
    if (process.env.VAULT_MCP_DEBUG_AUTH) {
      // No token material or PII (email) — just enough to diagnose auth outcomes.
      console.error(
        `[remote-proxy] introspect-debug: status=${res.status} active=${data.active} client_ok=${data.client_id === cid} sub=${data.sub}`,
      );
    }
    if (!res.ok) return null;
    return ok ? data : null;
  } catch (e) {
    if (process.env.VAULT_MCP_DEBUG_AUTH) console.error("[remote-proxy] introspect-debug: fetch failed", e);
    return null;
  }
}

// ── Auth gate helpers (moved from remote-proxy.ts) ────────────────────────────

/** Compact-JWS shape (three base64url segments): distinguishes an OAuth JWT from an opaque token. */
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Bearer realm for static-token 401 rejections. */
export const STATIC_CHALLENGE = 'Bearer realm="obsidian-vault-mcp"';

/** Extract the Bearer credential from a request, or null. */
function bearerOf(req: Request): string | null {
  const m = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/** Uniform JSON-RPC 401 envelope for MCP endpoint rejections. */
function send401(res: Response, wwwAuthenticate: string): void {
  res
    .status(401)
    .set("WWW-Authenticate", wwwAuthenticate)
    .json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
}

/** Valid token, but the authenticated user isn't allowlisted. */
function send403(res: Response): void {
  res
    .status(403)
    .json({ jsonrpc: "2.0", error: { code: -32003, message: "forbidden: user not authorized" }, id: null });
}

/**
 * True if at least one entry is present in AUTH_ALLOWED_SUBS or AUTH_ALLOWED_EMAILS.
 * Read from process.env at call time so entrypoints can check after startup.
 */
export function isAllowlistActive(): boolean {
  const subs = (process.env.AUTH_ALLOWED_SUBS ?? "").split(/[\s,]+/).filter(Boolean);
  const emails = (process.env.AUTH_ALLOWED_EMAILS ?? "").split(/[\s,]+/).filter(Boolean);
  return subs.length > 0 || emails.length > 0;
}

/** True if AUTH_ALLOW_ANY_AUTHENTICATED is set to a truthy value. */
export function isAllowAnyAuthenticated(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env.AUTH_ALLOW_ANY_AUTHENTICATED ?? "").trim().toLowerCase(),
  );
}

type AuthClaims = { sub?: string; email?: unknown; email_verified?: unknown };

/**
 * Dual-auth gate factory. Returns an Express middleware that accepts requests with:
 *   (a) the static owner token (opts.token, allowlist-exempt), OR
 *   (b) a valid OAuth 2.1 Bearer credential bound to this resource (cfg.enabled).
 *
 * Reads AUTH_ALLOWED_SUBS / AUTH_ALLOWED_EMAILS from process.env at creation time
 * so tests can set them before calling createAuthGate. Does NOT call process.exit —
 * fail-closed startup checks belong in the entrypoint.
 *
 * Mount BEFORE body-parsing middleware; the gate reads only the Authorization header
 * so unauthenticated callers cannot force a JSON parse.
 */
export function createAuthGate(cfg: AuthConfig, opts: { token?: string }): RequestHandler {
  const TOKEN = opts.token ?? "";
  const TOKEN_BUF = Buffer.from(TOKEN);

  // Capture allowlist from env at gate creation time.
  const allowedSubs = new Set(
    (process.env.AUTH_ALLOWED_SUBS ?? "").split(/[\s,]+/).filter(Boolean),
  );
  const allowedEmails = new Set(
    (process.env.AUTH_ALLOWED_EMAILS ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
  );
  const allowlistActive = allowedSubs.size > 0 || allowedEmails.size > 0;

  /**
   * Is this authenticated subject authorized? `sub` is the primary gate. `email`
   * is honored ONLY when the AS asserts it is verified (`email_verified === true`)
   * — an unverified email an attacker set to the owner's address must not pass.
   */
  function subjectAllowed(claims: AuthClaims): boolean {
    if (!allowlistActive) return true; // only reachable under AUTH_ALLOW_ANY (guarded at startup)
    if (claims.sub && allowedSubs.has(claims.sub)) return true;
    if (
      claims.email_verified === true &&
      typeof claims.email === "string" &&
      allowedEmails.has(claims.email.toLowerCase())
    ) {
      return true;
    }
    return false;
  }

  async function impl(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tok = bearerOf(req);
    if (process.env.VAULT_MCP_DEBUG_AUTH) {
      const shape = !tok ? "none" : JWT_RE.test(tok) ? "jwt" : `opaque(len=${tok.length})`;
      console.error(`[remote-proxy] auth-debug: ${req.method} bearer=${shape}`);
    }
    // Static owner token — the owner's own secret; exempt from the OAuth allowlist.
    if (tok && TOKEN && tok.length === TOKEN_BUF.length && timingSafeEqual(Buffer.from(tok), TOKEN_BUF)) {
      return next();
    }

    if (!cfg.enabled) return send401(res, STATIC_CHALLENGE);

    // No credential → advertise the AS so a web client can discover + authenticate.
    if (!tok) return send401(res, bearerChallenge(cfg, "invalid_request", "authentication required"));

    if (!JWT_RE.test(tok)) {
      // A non-JWT bearer the length of the static token is almost certainly a
      // mistyped VAULT_MCP_TOKEN → reject locally: don't ship the secret to the AS
      // introspection endpoint, and don't push a Claude Code client into OAuth.
      if (TOKEN && tok.length === TOKEN_BUF.length) return send401(res, STATIC_CHALLENGE);
      // Implausible length → reject locally so garbage can't amplify into a flood
      // of outbound introspection POSTs against the AS.
      if (tok.length < 16 || tok.length > 4096) {
        return send401(res, bearerChallenge(cfg, "invalid_token", "token rejected"));
      }
    }

    // AUTHENTICATE: JWT via JWKS (issuer + audience), else opaque via RFC 7662
    // introspection (bound to our client_id). Both return claims or null.
    const claims: AuthClaims | null = JWT_RE.test(tok)
      ? await verifyBearer(cfg, tok)
      : ((await introspectToken(tok)) as AuthClaims | null);

    if (process.env.VAULT_MCP_DEBUG_AUTH) {
      console.error(`[remote-proxy] auth-debug: authn ${claims ? "ok" : "rejected"} sub=${claims?.sub}`);
    }
    if (!claims) return send401(res, bearerChallenge(cfg, "invalid_token", "token rejected"));

    // AUTHORIZE: one allowlist check for both token types.
    if (!subjectAllowed(claims)) return send403(res);
    return next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    impl(req, res, next).catch(next);
  };
}
