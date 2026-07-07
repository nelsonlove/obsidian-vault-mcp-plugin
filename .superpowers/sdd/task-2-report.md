## Task 2 Report: Move `ok`/`fail` into `@vault-mcp/core`

**STATUS: DONE**

**Commit range:** `5afc875..c1c06e0`

**Build + test result:** `npm test --workspaces --if-present` — 109 tests, 109 pass, 0 fail (2 new core + 64 plugin + 43 server). All three packages build cleanly (core tsc, plugin esbuild, server tsc).

---

### What was done

1. **TDD (RED):** Wrote `packages/core/tests/responses.test.mjs` first — asserts `ok({a:1}).structuredContent` deep-equals `{a:1}` and `fail(new Error("boom")).isError === true` with `/boom/` in text. Ran test → failed with `ERR_MODULE_NOT_FOUND` (no `src/responses.ts` yet).

2. **GREEN:** Created `packages/core/src/responses.ts` with the canonical `ok`/`fail` from the plugin (exact `as const` variant). Exported both from `packages/core/src/index.ts` (`export { ok, fail } from "./responses.js"`). Test passed.

3. **Plugin update:** `packages/plugin/src/mcp/helpers.ts` — deleted the inline `ok`/`fail` definitions; added `import { ok } from "@vault-mcp/core"` (needed by `okError` which calls `ok` in its body) and `export { ok, fail } from "@vault-mcp/core"`. `okError` and `validateMoves` remain in the plugin.

4. **Server update:** `packages/server/src/index.ts` — deleted the inline `ok`/`fail` block (lines 51–64); added `import { ok, fail } from "@vault-mcp/core"`.

5. **Package declarations:** Added `"@vault-mcp/core": "*"` to `dependencies` in both `packages/plugin/package.json` and `packages/server/package.json`.

6. **Core exports map:** Updated `packages/core/package.json` exports to the conditional form `{"types": "./dist/index.d.ts", "default": "./dist/index.js"}` so TypeScript's Node16 module resolver finds types via the `exports` map (not just the top-level `types` field).

7. **Core test script:** `"test": "tsc && node --import tsx --test 'tests/*.test.mjs'"` — `tsc` first so downstream packages always find a fresh dist when the workspace runs tests in alphabetical order (core → plugin → server).

---

### Concerns / notes

**One non-obvious fix:** `okError` in `helpers.ts` calls `ok(data)` in its body. Re-exporting `ok` via `export { ok } from "@vault-mcp/core"` doesn't bring `ok` into the local module scope — TypeScript complained `Cannot find name 'ok'`. The fix was to add a separate `import { ok } from "@vault-mcp/core"` alongside the re-export. This is correct and idiomatic TypeScript.

**Build order dependency:** The `npm test --workspaces --if-present` command runs workspaces alphabetically: `@vault-mcp/core` first, which runs `tsc` and emits dist. Plugin tests run second and resolve `@vault-mcp/core` via the workspace symlink → `dist/index.js`. Server tsc runs third and finds `dist/index.d.ts` for type declarations. This ordering is stable as long as workspaces stay named `core`, `plugin`, `server`.

**No project references added:** Server's tsconfig doesn't declare a `references` array pointing at core. This is fine because (a) core is always built before server in the npm test workspace order, and (b) adding composite project references would require server to use `tsc --build` instead of plain `tsc`, changing its existing build/test scripts. The simpler build-order dependency is sufficient.

---

## Fix

**Build-hygiene fixes applied after review.**

### Changes

1. **`packages/plugin/src/mcp/helpers.ts`** — added one-line comment above the `import { ok }` / `export { ok, fail }` pair explaining why both exist (separate import for `okError`'s body call; re-export for public API).

2. **`packages/core/.gitignore`** — new file containing `dist/` and `*.tsbuildinfo`. Ran `git rm -r --cached packages/core/dist packages/core/tsconfig.tsbuildinfo` to untrack the seven previously-committed build artifacts (6 dist files + tsbuildinfo). Files remain on disk.

3. **`packages/core/package.json` scripts** — added `"prepare": "tsc"` so `npm install` builds `dist/` for consumers on a fresh clone without a manual `npm run build`.

4. **`packages/core/package.json` devDependencies** — added `"tsx": "^4.19.0"` and `"typescript": "^5.7.0"` (versions matching `packages/plugin/package.json`) so core's test script doesn't silently rely on root-level hoisting.

### Verification results

| Check | Result |
|---|---|
| `npm install` → `packages/core/dist/index.js` exists | PASS (prepare builds dist on install) |
| `npm test --workspaces --if-present` | PASS — 109 tests, 109 pass (2 core + 64 plugin + 43 server) |
| `npm run build --workspace packages/plugin` | PASS — emits `main.js` (379.6kb) and `bridge.mjs` |
| `npm run build --workspace packages/server` | PASS — `tsc` exits clean |
