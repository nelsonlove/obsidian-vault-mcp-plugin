import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wireUpClaudeConfig } from "../src/wire-up.ts";

test("adds mcpServers entry without clobbering existing keys", () => {
  const cfg = path.join(os.tmpdir(), `claude-${process.pid}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: "x" } }, foo: 1 }));
  const r = wireUpClaudeConfig({ bridgePath: "/b/bridge.mjs", vaultName: "obsidian", configPath: cfg });
  assert.equal(r.added, true);
  const out = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal(out.foo, 1);
  assert.equal(out.mcpServers.other.command, "x");
  assert.deepEqual(out.mcpServers["vault-mcp"].args, ["/b/bridge.mjs", "--vault", "obsidian"]);
  fs.unlinkSync(cfg);
});

test("creates config + mcpServers when absent", () => {
  const cfg = path.join(os.tmpdir(), `claude-new-${process.pid}.json`);
  try { fs.unlinkSync(cfg); } catch {}
  wireUpClaudeConfig({ bridgePath: "/b/bridge.mjs", vaultName: "v", configPath: cfg });
  const out = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal(out.mcpServers["vault-mcp"].command, "node");
  fs.unlinkSync(cfg);
});
