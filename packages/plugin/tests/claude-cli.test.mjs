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

// ── #38: auto-provision vault-mcp-connect ─────────────────────────────────────

import {
  marketplaceAddArgs,
  connectInstallArgs,
  hasMarketplace,
  hasConnectPlugin,
  claudeEnsureConnectPlugin,
} from "../src/claude-cli.ts";

test("marketplaceAddArgs adds the GitHub-sourced marketplace", () => {
  assert.deepEqual(marketplaceAddArgs(), [
    "plugin", "marketplace", "add", "nelsonlove/claude-code-plugins",
  ]);
});

test("connectInstallArgs installs pinned plugin@marketplace at user scope", () => {
  assert.deepEqual(connectInstallArgs(), [
    "plugin", "install", "vault-mcp-connect@claude-code-plugins-mac", "--scope", "user",
  ]);
});

test("hasMarketplace matches the marketplace name in list output", () => {
  const out = "Configured marketplaces:\n\n  ❯ claude-plugins-official\n    Source: GitHub (anthropics/claude-plugins-official)\n\n  ❯ claude-code-plugins-mac\n    Source: Directory (/Users/nelson/repos/claude-code-plugins)\n";
  assert.equal(hasMarketplace(out), true);
  assert.equal(hasMarketplace("Configured marketplaces:\n\n  ❯ claude-plugins-official\n"), false);
});

test("hasConnectPlugin matches vault-mcp-connect@ in plugin list output", () => {
  assert.equal(hasConnectPlugin("Installed plugins:\n  ❯ vault-mcp-connect@claude-code-plugins-mac\n"), true);
  assert.equal(hasConnectPlugin("Installed plugins:\n  ❯ vault-skills@claude-code-plugins-mac\n"), false);
  assert.equal(hasConnectPlugin("No plugins installed\n"), false);
});

test("claudeEnsureConnectPlugin: already provisioned → no mutating calls", async () => {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "plugin marketplace list") return { stdout: "❯ claude-code-plugins-mac\n" };
    if (args.join(" ") === "plugin list") return { stdout: "❯ vault-mcp-connect@claude-code-plugins-mac\n" };
    throw new Error("unexpected call: " + args.join(" "));
  };
  const result = await claudeEnsureConnectPlugin("claude", { exec });
  assert.equal(result, "already");
  assert.deepEqual(calls, ["plugin marketplace list", "plugin list"]);
});

test("claudeEnsureConnectPlugin: missing both → adds marketplace then installs", async () => {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "plugin marketplace list") return { stdout: "❯ claude-plugins-official\n" };
    if (args.join(" ") === "plugin list") return { stdout: "No plugins installed\n" };
    return { stdout: "" }; // add/install succeed
  };
  const result = await claudeEnsureConnectPlugin("claude", { exec });
  assert.equal(result, "installed");
  assert.deepEqual(calls, [
    "plugin marketplace list",
    "plugin marketplace add nelsonlove/claude-code-plugins",
    "plugin list",
    "plugin install vault-mcp-connect@claude-code-plugins-mac --scope user",
  ]);
});
