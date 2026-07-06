# vault-mcp — architecture & working notes for Claude Code

An Obsidian plugin (id `vault-mcp`) embedding an MCP server with direct `app.*` access, reached by Claude Code via a Unix socket + bundled stdio bridge. Local-with-Obsidian counterpart to the remote, filesystem-only `obsidian-vault-mcp-server` (JD 92046). Design specs and implementation plans live in the vault at `00-09 System/03 LLMs & agents/03.20 Vault MCP/` (the former JD 92050 project slot is retired).

## Locked decisions (don't relitigate without reason)

- **Transport: Unix socket + bundled bridge.** Not HTTP. The `chmod 600` socket is the *only* auth boundary — no token, no listening TCP port (a localhost port is reachable by any local process and by browser DNS-rebinding; the socket isn't). `bridge.mjs` is built by esbuild and **embedded into `main.js`** via `define` (`__BRIDGE_SOURCE__` → `src/bridge-asset.ts`), then written to `~/.claude/vault-mcp/` on load. Never ship the bridge as a separate npm install.
- **Multi-client transport.** `UnixSocketListener` accepts each connection and `main.ts` builds a **fresh `McpServer` per connection** (`buildMcpServer`). So concurrent Claude Code sessions / background agents don't evict each other, and *conditional registration at build time is the dynamic-registration mechanism* — there is no `app.plugins.on("change")` + `tools/list_changed` machinery (obviated; new tools appear on session reconnect).
- **State namespace: `~/.claude/vault-mcp/`** holds `bridge.mjs`, `<vault-slug>.sock`, `<vault-slug>.json`. Resolve `~` via `os.homedir()`.
- **Never write `~/.claude.json` directly.** Registration goes only through spawning the `claude` binary (`claudeRegister` in `src/claude-cli.ts`). When spawning `claude`, augment PATH (`spawnEnv`) — Obsidian's GUI PATH is minimal and the `claude` launcher shim runs `#!/usr/bin/env node`.
- **Plugin-gated tools gate on the LOADED instance** (`app.plugins.plugins[id]`), not `app.plugins.enabledPlugins` — `enabledPlugins` can list a configured-but-uninstalled plugin (stale entry).
- **`ok()` returns both `content` (text) and `structuredContent`.** `fail()` returns `isError: true`. Match the 92046 shapes; tool names are the identical `obsidian_*` set (strict-superset).
- **Safety guard** (`src/guard.ts`) is applied by monkey-patching `server.registerTool` in `buildMcpServer` (single interception point). A tool is mutating iff `annotations.readOnlyHint === false`. Read-only mode blocks mutating tools; the path allowlist normalizes paths (`posix.normalize`, reject `..` escapes) before prefix-matching.
- **`isDesktopOnly: true`.** Node `net`/`fs` from the renderer.

## Build / test

- `npm run build` — esbuild, emits `main.js` (+ `bridge.mjs`). `npm test` — `tsc --noEmit && node --import tsx --test`.
- **The editor LSP lags** in this repo — trust `npx tsc --noEmit` (real exit code), not inline diagnostics.
- Install for testing: `cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/` then reload the plugin (or `app.plugins.disablePlugin('vault-mcp').then(()=>app.plugins.enablePlugin('vault-mcp'))` via Advanced URI eval).

## Verifying tools live (important)

Tool handlers that call `app.*` can't be unit-tested headlessly — verify against a running Obsidian by piping JSON-RPC through `node bridge.mjs --vault <name>`.

**Async handlers (anything that `await`s, e.g. `vault.read`) require keeping stdin OPEN.** If the prober's stdin EOFs, `bridge.mjs`'s `stdin.pipe(sock)` half-closes the socket, which aborts in-flight requests *before* their async response is sent — the tool *looks* hung but isn't. Use `( printf '<json>\n…'; sleep 4 ) | node bridge.mjs …`. A real Claude Code session keeps stdin open, so this only bites ad-hoc probes.

Pure logic (`guard.ts`, vault-slug, socket framing, bridge selection, discovery I/O, register-command, claude-cli `findClaudeBinary`/`spawnEnv`) IS unit-tested.

## Git

Feature branch per milestone, PR to `main`, don't self-merge. Auto-review PRs you author.
