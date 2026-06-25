import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisterCommand } from "../src/register-command.ts";

test("generic command omits --vault", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/p/bridge.mjs" }),
    "claude mcp add --scope user vault-mcp -- node /p/bridge.mjs"
  );
});

test("named command appends --vault, quoting spaces", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/p/bridge.mjs", vaultName: "My Vault" }),
    "claude mcp add --scope user vault-mcp -- node /p/bridge.mjs --vault 'My Vault'"
  );
});
