import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVault, filterLive } from "../bridge/bridge.ts";

const A = { vault_name: "alpha", socket_path: "/a.sock" };
const B = { vault_name: "beta", socket_path: "/b.sock" };

test("selectVault: --vault flag wins", () => {
  assert.equal(selectVault([A, B], { flag: "beta" }).vault_name, "beta");
});
test("selectVault: env when no flag", () => {
  assert.equal(selectVault([A, B], { env: "alpha" }).vault_name, "alpha");
});
test("selectVault: single discovery auto-selected", () => {
  assert.equal(selectVault([A], {}).vault_name, "alpha");
});
test("selectVault: ambiguous throws", () => {
  assert.throws(() => selectVault([A, B], {}), /specify --vault/);
});
test("selectVault: unknown flag throws", () => {
  assert.throws(() => selectVault([A, B], { flag: "gamma" }), /no vault named/);
});
test("selectVault: empty gives actionable 'serving MCP' message", () => {
  assert.throws(() => selectVault([], {}), /serving MCP/);
});

test("filterLive keeps only discoveries whose socket exists", () => {
  const live = filterLive([A, B], (p) => p === "/a.sock");
  assert.deepEqual(live.map((d) => d.vault_name), ["alpha"]);
});
test("filterLive drops all when no sockets exist", () => {
  assert.equal(filterLive([A, B], () => false).length, 0);
});
test("filterLive treats an exists() throw as not-live", () => {
  assert.equal(filterLive([A], () => { throw new Error("boom"); }).length, 0);
});
