import type { Request, Response, NextFunction } from "express";
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
