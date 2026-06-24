import { test } from "node:test";
import assert from "node:assert/strict";
import { vaultSlug } from "../src/paths.ts";

test("vaultSlug lowercases and dash-replaces", () => {
  assert.equal(vaultSlug("My Vault!"), "my-vault");
  assert.equal(vaultSlug("obsidian"), "obsidian");
  assert.equal(vaultSlug("A  B__C"), "a-b__c");
  assert.equal(vaultSlug("--weird--"), "weird");
});
