import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisterCommand } from "../src/register-command.ts";

test("builds the claude mcp add line with simple names", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/Users/n/.claude/vault-mcp/bridge.mjs", vaultName: "obsidian" }),
    "claude mcp add --scope user vault-mcp -- node /Users/n/.claude/vault-mcp/bridge.mjs --vault obsidian"
  );
});

test("quotes a vault name with spaces", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/p/bridge.mjs", vaultName: "My Vault" }),
    "claude mcp add --scope user vault-mcp -- node /p/bridge.mjs --vault 'My Vault'"
  );
});
