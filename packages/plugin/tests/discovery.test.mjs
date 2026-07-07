import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeDiscovery, removeDiscovery } from "../src/discovery.ts";

test("writeDiscovery then removeDiscovery round-trips a file", () => {
  const slug = `t${process.pid}`;
  const d = {
    socket_path: "/x.sock", vault_path: "/v", vault_name: slug,
    plugin_version: "0.1.0", obsidian_version: "1.6.6", started_at: "2026-01-01T00:00:00",
  };
  writeDiscovery(slug, d);
  const p = path.join(os.homedir(), ".claude", "vault-mcp", `${slug}.json`);
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).vault_name, slug);
  removeDiscovery(slug);
  assert.equal(fs.existsSync(p), false);
});
