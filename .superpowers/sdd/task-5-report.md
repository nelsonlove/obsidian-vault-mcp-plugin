# Task 5 Report: plugin repo docs + PR

## Changes Made

### `packages/plugin/CLAUDE.md`
Appended one bullet to the "Locked decisions" list documenting the external tool registry: the `src/mcp/external-tools.ts` location, the `plugin.api` surface (`apiVersion: 1`, `registerTools`/`unregisterTools`), the `vault-mcp:ready` event, the JSON-Schema→zod boundary via `json-schema-to-zod.ts`, the mutating-unless-`readOnlyHint: true` polarity (inverse of built-ins), guarded registration through `buildMcpServer`, snapshot-per-connection semantics, and the `vault-mcp-api` SDK reference.

### `README.md` (repo root)
Added a new "Publishing tools from other plugins" section before the existing "Repo" section. It covers: SDK install (`npm install github:nelsonlove/vault-mcp-api#v1.0.0`), a complete `publishTools()` usage example with `onload()` registration, and a prose summary of load-order handling, re-registration on vault-mcp reload, cleanup, tool visibility timing, and guard behavior.

## Test Run

```
npm test -w obsidian-vault-mcp-plugin
```

Result: **79 passing, 0 failing** (tsc --noEmit + node --import tsx --test). No regressions from the docs-only change.

## Commit

`ff66239` — `docs: external tool registry + vault-mcp-api publisher guide`

Branch: `feat/external-tool-registry` pushed to origin.

## PR

https://github.com/nelsonlove/obsidian-vault-mcp-plugin/pull/32

PR title: "External tool registry: other plugins publish MCP tools via plugin.api"

PR body summarizes all 5 commits (4 feature + 1 docs), references issue #30, includes the 79-passing test run note, and carries the Claude Code footer with session URL.

## Notes

- Controller requested no `/code-review` and no self-merge — stopped after PR creation.
- Tasks 6–7 can proceed in parallel; Task 8 needs this PR merged + installed.


---

## Task 5 Addendum: Code-Review Findings (F1–F10) — 2026-07-07

All 10 findings from the /code-review pass on PR #32 have been implemented. Pushed to `feat/external-tool-registry`.

### Commits (new)

- `69d7bf6` — `fix(plugin): harden json-schema-to-zod against null, cyclic, and non-string enum inputs (F2)`
- `6cbab26` — `fix(plugin): external-tool registry validation, wrapper semantics, and F3 allowlist guard (F1,F3,F4,F5,F6,F7,F8,F10,Backstop)`
- `d7422e1` — `chore: add name+version to root package.json to stabilize lockfile name (F9)`
- `2684dd4` — `docs: correct allowlist guard claims for external tools (F3 part 2)`

### Test summary

96 passing, 0 failing (was 79 before; 17 new tests across F1–F8/Backstop).

### Findings addressed

| Finding | Status | Notes |
|---------|--------|-------|
| F1 — obsidian_* collision | DONE | registerTools throws TypeError; registry stays empty |
| F2 — total converter | DONE | null/cyclic/non-string-enum all degrade to z.unknown() |
| F3 — allowlist bypass | DONE | registerExternalTools now takes ServerCtx; mutating+no path key blocked when allowlist active |
| F4 — cross-owner clobber | DONE | Different ownerId → TypeError; same owner replace still works |
| F5 — handler return normalization | DONE | undefined→{ok:true}, primitives/arrays→{result:…} |
| F6 — stale-owner identity | DONE | ownerAtBuild snapshot; reload/unload detected at call time |
| F7 — annotations passthrough | DONE | destructiveHint+idempotentHint widen; tests verify deepEqual |
| F8 — invalid inputSchema | DONE | Zod shapes/non-JSON-Schema → TypeError at registerTools time |
| F9 — lockfile name | DONE | root package.json name:"vault-mcp-monorepo"; lockfile settled |
| F10 — duplicate RO/RW | DONE | Local consts removed; using SHARED_ANNOTATIONS.RO/RW |
| Backstop | DONE | server.registerTool wrapped in try/catch; bad entries logged+skipped |

### Concerns

- F3 existing "stale owner (publisher unloaded)" test updated its error message match from `/no longer loaded/` to `/reloaded or unloaded/` — this is correct since the new F6 message covers both cases.
- The cyclic items test only asserts `doesNotThrow` + shape existence (not value acceptance), since a depth-capped cyclic z.array schema isn't `z.unknown()` — it's a deeply-nested array type that only accepts 16-level arrays. The spec ("returns without throwing") is satisfied.
