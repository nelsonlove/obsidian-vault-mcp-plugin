import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeBinary, spawnEnv, registerArgs } from "../src/claude-cli.ts";

test("registerArgs omits --vault when no vault name", () => {
  assert.deepEqual(
    registerArgs("/p/bridge.mjs"),
    ["mcp", "add", "--scope", "user", "vault-mcp", "--", "node", "/p/bridge.mjs"]
  );
});

test("registerArgs pins --vault when given (spaces kept intact — argv, not shell)", () => {
  assert.deepEqual(
    registerArgs("/p/bridge.mjs", "My Vault"),
    ["mcp", "add", "--scope", "user", "vault-mcp", "--", "node", "/p/bridge.mjs", "--vault", "My Vault"]
  );
});

test("returns first existing candidate", () => {
  const got = findClaudeBinary({
    candidates: ["/a/claude", "/b/claude", "/c/claude"],
    fileExists: (p) => p === "/b/claude",
  });
  assert.equal(got, "/b/claude");
});

test("returns null when none exist", () => {
  assert.equal(findClaudeBinary({ candidates: ["/x"], fileExists: () => false }), null);
});

test("spawnEnv appends node-bearing bin dirs to a minimal PATH", () => {
  const env = spawnEnv({ HOME: "/h", PATH: "/usr/bin:/bin" });
  const dirs = env.PATH.split(":");
  assert.ok(dirs.includes("/opt/homebrew/bin"), "must add /opt/homebrew/bin so the claude shim finds node");
  assert.ok(dirs.includes("/usr/local/bin"));
  assert.equal(dirs[0], "/usr/bin"); // original PATH preserved, extras appended
  assert.equal(env.HOME, "/h"); // other env preserved
});

test("spawnEnv tolerates an absent PATH", () => {
  const env = spawnEnv({ HOME: "/h" });
  assert.ok(env.PATH.includes("/opt/homebrew/bin"));
});
