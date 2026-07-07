import { test } from "node:test";
import assert from "node:assert/strict";
import { FS_TOOLS, SHARED_ANNOTATIONS } from "../src/tool-registry.ts";

const EXPECTED_NAMES = [
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
].sort();

test("FS_TOOLS contains exactly the 17 fs-expressible tool names", () => {
  assert.deepEqual(FS_TOOLS.map((t) => t.name).sort(), EXPECTED_NAMES);
});

test("every FS_TOOL has capability === 'fs-expressible'", () => {
  for (const tool of FS_TOOLS) {
    assert.equal(tool.capability, "fs-expressible", `${tool.name} has wrong capability`);
  }
});

test("every FS_TOOL has a plain-object inputSchema (not null/undefined)", () => {
  for (const tool of FS_TOOLS) {
    assert.ok(
      tool.inputSchema !== null && typeof tool.inputSchema === "object",
      `${tool.name} has missing or non-object inputSchema`
    );
  }
});

test("obsidian_read_note is read-only (annotations.readOnlyHint === true)", () => {
  const tool = FS_TOOLS.find((t) => t.name === "obsidian_read_note");
  assert.ok(tool, "obsidian_read_note not found in FS_TOOLS");
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("obsidian_delete_note is not read-only (annotations.readOnlyHint === false)", () => {
  const tool = FS_TOOLS.find((t) => t.name === "obsidian_delete_note");
  assert.ok(tool, "obsidian_delete_note not found in FS_TOOLS");
  assert.equal(tool.annotations.readOnlyHint, false);
});

test("SHARED_ANNOTATIONS has RO, RW, DESTRUCTIVE, DESTRUCTIVE_RECOVERABLE", () => {
  assert.ok(SHARED_ANNOTATIONS.RO, "missing RO");
  assert.ok(SHARED_ANNOTATIONS.RW, "missing RW");
  assert.ok(SHARED_ANNOTATIONS.DESTRUCTIVE, "missing DESTRUCTIVE");
  assert.ok(SHARED_ANNOTATIONS.DESTRUCTIVE_RECOVERABLE, "missing DESTRUCTIVE_RECOVERABLE");
});

test("SHARED_ANNOTATIONS.RO has readOnlyHint=true", () => {
  assert.equal(SHARED_ANNOTATIONS.RO.readOnlyHint, true);
});

test("SHARED_ANNOTATIONS.DESTRUCTIVE has destructiveHint=true", () => {
  assert.equal(SHARED_ANNOTATIONS.DESTRUCTIVE.destructiveHint, true);
});

test("obsidian_resolve has both `refs` (array) and optional `from` in inputSchema", () => {
  const tool = FS_TOOLS.find((t) => t.name === "obsidian_resolve");
  assert.ok(tool, "obsidian_resolve not found in FS_TOOLS");
  assert.ok(tool.inputSchema.refs, "obsidian_resolve should have `refs` field");
  assert.ok(tool.inputSchema.from, "obsidian_resolve should have optional `from` field");
});

test("obsidian_patch_note, obsidian_write_note, obsidian_move_note have DESTRUCTIVE annotations", () => {
  for (const name of ["obsidian_patch_note", "obsidian_write_note", "obsidian_move_note"]) {
    const tool = FS_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} not found in FS_TOOLS`);
    assert.equal(tool.annotations.destructiveHint, true, `${name} should have destructiveHint=true`);
    assert.equal(tool.annotations.readOnlyHint, false, `${name} should have readOnlyHint=false`);
  }
});

test("obsidian_force_reindex has readOnlyHint=false, destructiveHint=false, idempotentHint=true", () => {
  const tool = FS_TOOLS.find((t) => t.name === "obsidian_force_reindex");
  assert.ok(tool, "obsidian_force_reindex not found in FS_TOOLS");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
});
