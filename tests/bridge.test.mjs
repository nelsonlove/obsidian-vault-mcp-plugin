import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVault } from "../bridge/bridge.ts";

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
