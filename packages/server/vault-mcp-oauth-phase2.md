# Phase 2 — OAuth for the Vault MCP Connector

This is the writeup for putting real, per-user authentication in front of the
vault MCP server. It supersedes the earlier `oauth2-proxy` idea (which doesn't
work — that's a browser-cookie gateway, not something Claude's OAuth client can
run a flow against).

> **One-paragraph orientation.** Under the current MCP authorization spec, your
> MCP server is an OAuth 2.1 **resource server** — it validates tokens, it does
> **not** issue them. A separate **authorization server (AS)** issues them.
> Claude is the OAuth **client**. The single most important consequence: you do
> **not** hand-roll the dangerous part. You stand up (or rent) a compliant AS,
> and your server just (a) advertises which AS to use and (b) checks the tokens.
> The resource-server half is already built and tested in this repo
> (`src/auth.ts`); the decision left is which AS to use.

---

## 1. How the flow actually works

When Claude connects to a protected MCP server, the spec-defined dance is:

1. Claude hits `POST /mcp` with no token. Your server returns **401** with a
   `WWW-Authenticate: Bearer ..., resource_metadata="<url>"` header.
2. Claude fetches that **Protected Resource Metadata (PRM)** document
   (RFC 9728) at `/.well-known/oauth-protected-resource`. It lists your
   `authorization_servers`.
3. Claude discovers the AS's endpoints (Authorization Server Metadata / OIDC
   discovery), obtains a client identity (see §3), and runs an **OAuth 2.1
   Authorization Code flow with PKCE**. A browser window opens; you log in and
   consent at the AS.
4. The AS issues an **access token bound to your resource** (RFC 8707 — the
   `resource` parameter, so the token's audience is *your* MCP server and can't
   be replayed elsewhere).
5. Claude retries `POST /mcp` with `Authorization: Bearer <token>`. Your server
   validates signature (via the AS's JWKS), issuer, audience, and expiry, then
   serves the request.
6. On expiry, Claude refreshes reactively on a 401 (and proactively ~5 min
   before expiry). Your AS must return RFC 6749 error codes (`invalid_grant`)
   when a refresh token is dead.

Steps 1, 2, and 5 are the resource-server half — **done and tested** in this
repo. Steps 3–4 and 6 are the AS's job.

---

## 2. The single-user simplification (read before picking an AS)

The spec's client-registration priority is: **pre-registration → CIMD → DCR →
ask the user for client details.** Most write-ups obsess over DCR (Dynamic
Client Registration) because public directory connectors need clients to
self-register. **You are one user with one connector**, so you can skip DCR
entirely and **pre-register a single OAuth client** at your AS:

- redirect URI: `https://claude.ai/api/mcp/auth_callback`
  (the callback for all hosted Claude surfaces — web, Desktop, mobile, Cowork)
- grant: authorization_code + refresh_token, with PKCE

Then, when adding the custom connector in claude.ai, supply that `client_id`
(and client secret if you made it a confidential client — the secret field is
optional in Claude's custom-connector UI). This means **your AS does not need a
DCR endpoint**, which removes the single most error-prone and DoS-prone piece.
Keep this in mind: it makes several AS options far simpler than their docs
suggest.

(If you ever publish to the directory, you'd revisit this and add CIMD or DCR.
For private personal use, pre-registration is correct and simplest.)

---

## 3. Choosing the authorization server

You need an AS that speaks OAuth 2.1 + PKCE and lets you pre-register a client.
Honest options, single-user lens:

### Option A — Managed MCP-auth provider (least work)
Services like **WorkOS AuthKit**, **Stytch**, or **Scalekit** now offer
purpose-built MCP auth: they are the AS, handle discovery/DCR/PKCE, and federate
login to Google/GitHub/passkeys. Free tiers comfortably cover one user.
- **Pro:** correct by construction; minutes to set up; nothing security-critical
  to maintain.
- **Con:** an external dependency in your otherwise self-contained stack — the
  thing you said you wanted to avoid. But note the dependency is only at
  *connect/refresh* time, and the blast radius is just this connector.

### Option B — Self-hosted Ory Hydra (most reproducible)
**Ory Hydra** is a focused OAuth 2.1 / OIDC server, packaged in nixpkgs, that
does **not** manage users itself — it delegates login/consent to a small app you
run, which in turn federates to GitHub/Google. Everything lives in your flake.
- **Pro:** fully declarative and self-hosted; no vendor; matches your "reproduce
  from a clean box" requirement end to end.
- **Con:** you must run Hydra **plus** a login/consent app (a small service that
  shows the login page and calls Hydra's admin API to accept the
  login/consent). That's the real work. Hydra supports DCR if you ever want it,
  but with §2 pre-registration you can leave DCR off.

### Option C — Keycloak / Zitadel / Authentik / Logto (full IAM)
Heavier identity platforms that include their own user store and login UI, so
**no separate consent app needed** — a middle ground between A and B. Keycloak
and Zitadel both support pre-registered clients and PKCE; several support DCR.
- **Pro:** batteries-included login UI; self-hosted; declarable (Keycloak is
  JVM-heavy; Zitadel and Authentik lighter).
- **Con:** more moving parts and RAM than Hydra; more than one user needs.

**Recommendation for your case:** if the self-contained/reproducible goal is
paramount and you don't mind an afternoon of wiring, **Option B (Hydra + a tiny
consent app, federating to GitHub)** is the cleanest fit and keeps the whole
system in the flake. If you'd rather not run auth infrastructure at all and can
accept one external dependency scoped to this connector, **Option A** is the
pragmatic choice and you'll be done in well under an hour. I'd avoid C unless you
already want a general-purpose IdP for other things.

---

## 4. What's already built (resource-server half)

`src/auth.ts` implements, and `src/index.ts` wires in:

- `GET /.well-known/oauth-protected-resource` → the PRM document, listing your
  `authorization_servers`, `bearer_methods_supported`, and `scopes_supported`.
- `requireBearer` middleware on `POST /mcp`: validates the JWT against the AS's
  **JWKS** (`createRemoteJWKSet`, with rotation handled), enforcing **issuer**
  and **audience** (audience = your resource URL, the RFC 8707 binding) and
  expiry. On any failure it returns **401** with the spec's `WWW-Authenticate`
  header pointing back at the PRM.

It is **provider-agnostic** — it works with any of the options above via env
vars, and it's a no-op when `AUTH_ENABLED=false` (Phase 1). Tested end-to-end:
valid resource-bound token → 200; missing / wrong-audience / malformed token →
401 with the correct challenge header. The wrong-audience rejection is the
token-replay protection working.

Enable it with:

```bash
AUTH_ENABLED=true
MCP_RESOURCE_URL=https://vault-mcp.nelson.love/mcp   # your server's canonical id == token audience
AUTH_ISSUER=https://auth.nelson.love               # your AS issuer URL
AUTH_JWKS_URI=https://auth.nelson.love/.well-known/jwks.json   # from your AS metadata
AUTH_SERVERS=https://auth.nelson.love              # advertised in PRM (defaults to issuer)
AUTH_SCOPES="vault.read vault.write"
```

> **One caveat to verify against your AS:** the middleware validates a **JWT**
> access token via JWKS. Some authorization servers (notably some configs of
> WorkOS/Stytch and Hydra's "opaque token" mode) issue **opaque** access tokens
> that must be checked via a **token introspection** endpoint (RFC 7662)
> instead. If your chosen AS issues opaque tokens, configure it to issue JWT
> access tokens (Hydra: enable JWT access tokens; Keycloak/Zitadel: JWTs by
> default), **or** swap the `jwtVerify` call in `auth.ts` for an introspection
> call. JWT-via-JWKS is the simpler and more common path; pick a JWT config and
> the code as written is correct.

---

## 5. Deployment changes (on top of the main build plan, HANDOFF.md)

### Caddy
Caddy already terminates TLS and proxies `/mcp`. Two additions:

- The PRM well-known path is served by the MCP server itself, so it's already
  proxied — no extra Caddy config needed if `/.well-known/oauth-protected-resource`
  routes to the app. Confirm your `reverse_proxy` covers it (a catch-all to the
  app does).
- **Relax the Anthropic-IP-only rule once OAuth is live.** In Phase 1 the
  firewall dropped non-Anthropic traffic to 443. With OAuth, identity (not
  network position) is doing the work, and the **browser leg of the login flow
  comes from your own device, not Anthropic's range** — so keeping the hard IP
  lock can break interactive login. Move from "drop all non-Anthropic" to
  defense-in-depth: keep TLS + OAuth mandatory, and optionally keep the IP
  allowlist only on `/mcp` itself (the token-bearing API calls do come from
  Anthropic) while leaving the AS endpoints reachable. Simplest correct setting:
  drop the blanket IP rule, rely on OAuth.

### If self-hosting the AS (Option B/C), add to the flake
- A `services.ory.hydra` (or Keycloak/Zitadel) module, issuing **JWT** access
  tokens, with issuer `https://auth.nelson.love`.
- A Caddy vhost for `auth.nelson.love` → the AS.
- The tiny **login/consent app** (Option B only) as another systemd service,
  federating to GitHub (an OAuth app you register at GitHub with callback at
  your consent app).
- Pre-register the Claude client at the AS (redirect
  `https://claude.ai/api/mcp/auth_callback`).
- Secrets (GitHub OAuth app secret, Hydra system secret, client secret) via
  **agenix**, exactly like the Tailscale key — ciphertext in git, decrypted to
  `/run/secrets` at activation. Never inline; the Nix store is world-readable.

### If using a managed AS (Option A)
- No flake services for auth. Set the five `AUTH_*` env vars on the `vault-mcp`
  service to your provider's issuer/JWKS.
- Pre-register the Claude client (redirect `https://claude.ai/api/mcp/auth_callback`)
  in the provider's dashboard; note the `client_id`/secret for the connector.
- Record the dashboard config in your README — this is the one bit that lives
  outside the flake, so write it down (the "what did I do a month ago" rule).

---

## 6. Connecting it in Claude

1. In **claude.ai (desktop browser)** → Settings → Connectors → your custom
   connector → it will now detect auth is required.
2. Provide the pre-registered `client_id` (and secret if confidential).
3. Complete the OAuth login/consent in the popup.
4. The authenticated connector **syncs to iOS automatically** — no phone-side
   setup, same as before.

---

## 7. Honest status

- **Resource-server half:** built, wired, and tested in this repo. Confident.
- **Authorization-server half:** a real decision with real setup, not a
  copy-paste. The §2 single-user pre-registration insight removes the worst of
  it (no DCR), but you still stand up or rent an AS. I did **not** hand you a
  hand-rolled AS, on purpose — a subtly-wrong OAuth server guarding your vault
  is precisely the mistake worth avoiding.
- **Next concrete step:** pick Option A or B. If A, I can walk you through the
  specific provider's pre-registration and the exact `AUTH_*` values. If B, I
  can sketch the Hydra + consent-app flake module and the GitHub federation.
