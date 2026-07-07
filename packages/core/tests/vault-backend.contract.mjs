/**
 * Reusable backend contract-test factory.
 *
 * This file uses the `.contract.mjs` suffix intentionally — it is NOT a test
 * file itself and is excluded from the `tests/*.test.mjs` glob used by
 * `npm test`. Task 5 (FilesystemBackend) imports and invokes it.
 *
 * Usage in a concrete backend test file:
 *
 *   import { makeBackendContractTests } from '../path/to/vault-backend.contract.mjs';
 *
 *   makeBackendContractTests(async () => {
 *     const vaultRoot = await mkdtemp(join(tmpdir(), 'vault-'));
 *     const backend = new FilesystemBackend(vaultRoot);
 *     return { backend, vaultRoot };
 *   });
 *
 * The factory MUST return `{ backend, vaultRoot }`:
 *   - `backend`   — the VaultBackend implementation under test.
 *   - `vaultRoot` — the absolute path to the fresh temp vault directory.
 *                   The contract suite uses this to place sentinel files
 *                   OUTSIDE the vault root and verify vault containment.
 *
 * Each test case calls `makeBackend` independently so every case gets a
 * fresh backend over an empty vault — no shared state between tests.
 *
 * @module vault-backend.contract
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Generate a short random hex string for unique filenames.
 * @returns {string}
 */
function uid() {
  return randomBytes(6).toString("hex");
}

/**
 * Register the canonical contract tests for a VaultBackend implementation.
 *
 * The three invariants every backend MUST satisfy:
 *   1. Read-after-write — writeNote then readNote returns the same content.
 *   2. Frontmatter round-trip — manageFrontmatter "set" then "get" returns
 *      the written value.
 *   3. Vault containment — no read or write operation may escape the vault
 *      root via path-traversal sequences (e.g. `../`). A backend that reads
 *      or creates files outside the vault root MUST fail this test.
 *
 * @param {() => Promise<{ backend: import('../src/vault-backend.js').VaultBackend, vaultRoot: string }>} makeBackend
 *   Factory that creates a fresh backend over a throwaway temp vault.
 *   Must return `{ backend, vaultRoot }` where `vaultRoot` is the absolute
 *   path of the temp vault directory. Called once per test case.
 */
export function makeBackendContractTests(makeBackend) {
  test("VaultBackend contract: read-after-write", async () => {
    const { backend } = await makeBackend();
    const notePath = "contract-read-after-write.md";
    const content = "# Contract test\n\nHello from the contract suite.";

    await backend.writeNote(notePath, content, false);
    const read = await backend.readNote(notePath);

    assert.equal(
      read,
      content,
      "readNote should return the exact content written by writeNote",
    );
  });

  test("VaultBackend contract: frontmatter round-trip", async () => {
    const { backend } = await makeBackend();
    const notePath = "contract-frontmatter-roundtrip.md";

    // Create the note so there is a file to attach frontmatter to.
    await backend.writeNote(notePath, "# Frontmatter test\n", false);

    // Set a key.
    await backend.manageFrontmatter(notePath, "status", "set", "active");

    // Read it back — the "get" result must carry the value we wrote.
    const result = await backend.manageFrontmatter(notePath, "status", "get");
    assert.equal(
      result.value,
      "active",
      'manageFrontmatter "get" should return the value written by "set"',
    );
  });

  test("VaultBackend contract: path-traversal cannot escape vault root", async () => {
    const { backend, vaultRoot } = await makeBackend();

    // Place a sentinel file ONE level above the vault root. A porous backend
    // would expose this content via "../sentinelName"; a correct backend must
    // NOT — it either strips the traversal (returning a different/nonexistent
    // path) or throws. Both outcomes satisfy the invariant; returning the
    // sentinel's actual content does not.
    const parentDir = path.dirname(vaultRoot);
    const sentinelName = `contract-sentinel-${uid()}.txt`;
    const sentinelPath = path.join(parentDir, sentinelName);
    const sentinelContent = `SENTINEL_OUTSIDE_VAULT_${uid()}`;
    await fs.writeFile(sentinelPath, sentinelContent, "utf8");

    try {
      // ── READ containment ────────────────────────────────────────────────
      // Test both a single-level and a deeper escape. The single-level case
      // (`../sentinel`) is the primary differentiator: a porous backend would
      // return sentinelContent, a correct one throws or returns vault-internal
      // content. The deeper case (`../../../../sentinel`) exercises that deep
      // traversal sequences are also handled.
      for (const traversalPath of [
        `../${sentinelName}`,
        `../../../../${sentinelName}`,
      ]) {
        let readResult = null;
        try {
          readResult = await backend.readNote(traversalPath);
        } catch {
          // threw — acceptable: the backend rejected the traversal attempt
          readResult = null;
        }
        assert.ok(
          readResult !== sentinelContent,
          `readNote('${traversalPath}') returned the outside sentinel's content — ` +
            `vault containment FAILED (backend must strip or reject traversal sequences)`,
        );
      }

      // ── WRITE containment ──────────────────────────────────────────────
      // A backend that honors ../ would create a file at parentDir/escapee.md.
      // A correct backend either throws or creates the file inside the vault.
      const escapeeBasename = `contract-escapee-${uid()}.md`;
      const escapeeInParent = path.join(parentDir, escapeeBasename);

      try {
        await backend.writeNote(`../${escapeeBasename}`, "escaped write", true);
      } catch {
        // threw — acceptable; what matters is no outside file was created
      }

      let createdOutside = false;
      try {
        await fs.access(escapeeInParent);
        createdOutside = true;
      } catch {
        // file absent — correct
      }
      if (createdOutside) {
        // clean up debris before asserting so the temp dir isn't leaked
        await fs.unlink(escapeeInParent).catch(() => {});
      }
      assert.ok(
        !createdOutside,
        `writeNote('../${escapeeBasename}') created a file OUTSIDE the vault root ` +
          `at '${escapeeInParent}' — vault containment FAILED`,
      );
    } finally {
      await fs.unlink(sentinelPath).catch(() => {});
    }
  });
}
