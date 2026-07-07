# Task 2 Report — Auth Gate Promotion (createAuthGate)

**Status:** DONE  
**Commit range:** `b53a1d2`..`90454b9` (branch `phase2a-presence-front`)

## Files changed

- `packages/server/src/auth.ts` — new exports: `createAuthGate`, `isAllowlistActive`, `isAllowAnyAuthenticated`, `STATIC_CHALLENGE`; moved helpers: `JWT_RE`, `bearerOf`, `send401`, `send403`, `subjectAllowed` (inlined in factory), `AuthClaims` type; added `timingSafeEqual` + `RequestHandler` imports
- `packages/server/src/remote-proxy.ts` — removed all moved helpers; replaced inline `authGateImpl`/`authGate` with `const authGate = createAuthGate(authConfig, { token: TOKEN })`; replaced module-level allowlist constants with `isAllowlistActive()`/`isAllowAnyAuthenticated()` calls; removed `TOKEN_BUF` and `timingSafeEqual` import
- `packages/server/src/__tests__/auth-gate.test.ts` — new (6 tests, written first per TDD plan)

## Build + test result

| Check | Result |
|-------|--------|
| `npm run build --workspace packages/server` | CLEAN (tsc, 0 errors) |
| `npm test --workspace packages/server` (27 tests) | 27/27 PASS, process exits |
| `npm test --workspaces` (150 tests total) | 150/150 PASS |

## Tests written (auth-gate.test.ts)

1. Static token match → `next()` (allowlist-exempt)
2. `cfg.enabled=false`, no auth header → 401 with `STATIC_CHALLENGE`
3. `cfg.enabled=false`, wrong static token → 401 with `STATIC_CHALLENGE`
4. `cfg.enabled=true`, no authorization → 401 with `resource_metadata` URL in `WWW-Authenticate`
5. Valid locally-signed JWT (EC P-256, local JWKS HTTP server) with allowlisted sub → `next()`
6. Valid JWT with non-allowlisted sub → 403

JWT tests use `jose` to generate an EC key pair, export the JWKS, serve it from a `node:http` server started in `before()`, and sign test tokens with `SignJWT`. The JWKS server is torn down in `after()`.

## Behavior verification

`remote-proxy.ts` compiles and its `/mcp` route (`app[method]("/mcp", authGate, parseBody, ...)`) now uses `const authGate = createAuthGate(authConfig, { token: TOKEN })`. The gate path, all 401/403 shapes, the `VAULT_MCP_DEBUG_AUTH` log prefix (`[remote-proxy]`), and the body-parse-after-auth ordering are all preserved unchanged.

`createAuthGate` reads the allowlist from `process.env` at gate-creation time (not module level), which is what makes test isolation work without dynamic imports or module cache tricks.
