import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectVault,
  filterLive,
  noLiveMessage,
  staleRequestedMessage,
  connectFailMessage,
  resolveTarget,
  deadlineMessage,
} from "../bridge/bridge.ts";

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

test("noLiveMessage: stale discovery names the vault + plugin hint", () => {
  const m = noLiveMessage([A]);
  assert.match(m, /stale discovery for: alpha/);
  assert.match(m, /disabled or Obsidian is closed/);
});
test("noLiveMessage: no discovery gives serving-MCP hint", () => {
  assert.match(noLiveMessage([]), /no vault is currently serving MCP/);
});
test("staleRequestedMessage names the requested vault", () => {
  assert.match(staleRequestedMessage("beta"), /vault 'beta' has a discovery but no live socket/);
});
test("connectFailMessage names vault + socket path", () => {
  const m = connectFailMessage(A);
  assert.match(m, /can't connect to vault 'alpha'/);
  assert.match(m, /\/a\.sock/);
});

// --- resolveTarget: the retry-vs-fail-vs-connect decision ---
test("resolveTarget: single live vault is chosen", () => {
  assert.deepEqual(resolveTarget([A], undefined), { kind: "ok", chosen: A });
});
test("resolveTarget: none live yet is retryable (wait)", () => {
  assert.deepEqual(resolveTarget([], undefined), { kind: "wait" });
});
test("resolveTarget: multiple live + no pick is fatal (waiting can't disambiguate)", () => {
  const t = resolveTarget([A, B], undefined);
  assert.equal(t.kind, "fatal");
  assert.match(t.message, /multiple vaults open/);
});
test("resolveTarget: pinned vault present is chosen", () => {
  assert.deepEqual(resolveTarget([A, B], "beta"), { kind: "ok", chosen: B });
});
test("resolveTarget: pinned vault not live yet waits (even with others live)", () => {
  assert.deepEqual(resolveTarget([A], "beta"), { kind: "wait" });
});

// --- deadlineMessage: the diagnostic after the wait budget is spent ---
test("deadlineMessage: pinned + known but unreachable → stale-requested", () => {
  assert.match(deadlineMessage([B], "beta"), /vault 'beta' has a discovery but no live socket/);
});
test("deadlineMessage: pinned + never seen → no-vault-named + available list", () => {
  const m = deadlineMessage([A], "beta");
  assert.match(m, /no vault named "beta"/);
  assert.match(m, /available: alpha/);
});
test("deadlineMessage: single unreachable discovery → connect-fail names socket", () => {
  assert.match(deadlineMessage([A], undefined), /can't connect to vault 'alpha'/);
});
test("deadlineMessage: nothing discovered → serving-MCP hint", () => {
  assert.match(deadlineMessage([], undefined), /no vault is currently serving MCP/);
});
