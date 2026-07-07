/**
 * Contract tests for FilesystemBackend against the VaultBackend contract suite.
 *
 * Wires the 3 canonical contract tests (read-after-write, frontmatter
 * round-trip, vault containment) to a real FilesystemBackend over a
 * fresh temp directory.
 *
 * Each test case gets its own temp vault via makeBackend(); tests are
 * independent (no shared state).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.ts";
import { makeBackendContractTests } from "./vault-backend.contract.mjs";

makeBackendContractTests(async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), "vault-contract-"));
  const backend = new FilesystemBackend(vaultRoot);
  return { backend, vaultRoot };
});
