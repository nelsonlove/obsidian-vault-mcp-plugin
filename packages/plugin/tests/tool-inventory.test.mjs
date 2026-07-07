/**
 * tool-inventory.test.mjs
 *
 * Locks the fs-expressible tool set defined in @vault-mcp/core.
 *
 * Intent: after Phase 1, the 17 fs-expressible tools live exclusively in
 * FS_TOOLS inside @vault-mcp/core.  The plugin must not define its own
 * copies.  This file encodes that contract so any future drift causes an
 * immediate test failure.
 *
 * Two invariants:
 *   1. FS_TOOLS contains exactly these 17 names, byte-for-byte.
 *   2. server.ts delegates to registerFsTools from @vault-mcp/core and
 *      does not define any of the 17 names inline as string literals.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FS_TOOLS } from "@vault-mcp/core";

// ── Locked expected set ───────────────────────────────────────────────────────
// This is the source of truth.  Changes here require deliberate review.
// Names are sorted alphabetically — the order in FS_TOOLS is irrelevant.
const EXPECTED_FS_TOOL_NAMES = [
  "obsidian_append_note",
  "obsidian_delete_note",
  "obsidian_find_by_tag",
  "obsidian_force_reindex",
  "obsidian_get_backlinks",
  "obsidian_get_outlinks",
  "obsidian_list_folders",
  "obsidian_list_notes",
  "obsidian_manage_frontmatter",
  "obsidian_move_note",
  "obsidian_patch_note",
  "obsidian_read_note",
  "obsidian_read_notes",
  "obsidian_resolve",
  "obsidian_search_by_frontmatter",
  "obsidian_search_notes",
  "obsidian_write_note",
];

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fs-expressible tool inventory (#25)", () => {

  test("FS_TOOLS contains exactly 17 tools", () => {
    assert.equal(
      FS_TOOLS.length,
      17,
      `expected 17 fs-expressible tools in FS_TOOLS, got ${FS_TOOLS.length}`,
    );
  });

  test("FS_TOOLS names match the locked expected set, byte-identical", () => {
    const actual = FS_TOOLS.map((t) => t.name).sort();
    const expected = [...EXPECTED_FS_TOOL_NAMES].sort();
    assert.deepEqual(
      actual,
      expected,
      "FS_TOOLS names deviate from the locked expected set — update EXPECTED_FS_TOOL_NAMES if intentional",
    );
  });

  test("all FS_TOOLS entries carry capability='fs-expressible'", () => {
    for (const tool of FS_TOOLS) {
      assert.equal(
        tool.capability,
        "fs-expressible",
        `tool '${tool.name}' has unexpected capability '${tool.capability}'`,
      );
    }
  });

  test("server.ts imports registerFsTools from @vault-mcp/core", async () => {
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");

    assert.ok(
      source.includes("registerFsTools") && source.includes("@vault-mcp/core"),
      "server.ts must import registerFsTools from @vault-mcp/core",
    );

    assert.ok(
      /registerFsTools\s*\(server/.test(source),
      "server.ts must call registerFsTools(server, ...) to register fs-expressible tools",
    );
  });

  test("server.ts does not define any fs-expressible tool inline (no-drift guard)", async () => {
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");

    for (const name of EXPECTED_FS_TOOL_NAMES) {
      assert.ok(
        !source.includes(`"${name}"`),
        `server.ts contains inline string "${name}" — fs-expressible tools must not be re-defined outside FS_TOOLS`,
      );
    }
  });

});
