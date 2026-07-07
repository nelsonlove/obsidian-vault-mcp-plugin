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
 *     const dir = await mkdtemp(join(tmpdir(), 'vault-'));
 *     return new FilesystemBackend(dir);
 *   });
 *
 * Each test case calls `makeBackend` independently so every case gets a
 * fresh backend over an empty vault — no shared state between tests.
 *
 * @module vault-backend.contract
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Register the canonical contract tests for a VaultBackend implementation.
 *
 * The three invariants every backend MUST satisfy:
 *   1. Read-after-write — writeNote then readNote returns the same content.
 *   2. Frontmatter round-trip — manageFrontmatter "set" then "get" returns
 *      the written value.
 *   3. Path-traversal rejection — a `../` path must throw, not be served.
 *
 * @param {() => Promise<import('../src/vault-backend.js').VaultBackend>} makeBackend
 *   Factory that creates a fresh backend over a throwaway temp vault.
 *   Called once per test case.
 */
export function makeBackendContractTests(makeBackend) {
  test("VaultBackend contract: read-after-write", async () => {
    const backend = await makeBackend();
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
    const backend = await makeBackend();
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

  test("VaultBackend contract: path-traversal rejection", async () => {
    const backend = await makeBackend();

    // A path that escapes the vault root must throw — not silently serve the
    // file, not return empty content.
    await assert.rejects(
      () => backend.readNote("../etc/passwd"),
      (err) => {
        assert.ok(
          err instanceof Error,
          "expected an Error to be thrown for a path-traversal attempt",
        );
        return true;
      },
    );
  });
}
