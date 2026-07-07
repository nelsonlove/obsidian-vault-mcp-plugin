import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// VAULT_PATH must be set BEFORE the module is imported — vault.ts captures
// VAULT_ROOT at module load. Same dance as index-store.test.ts. On macOS,
// tmpdir() lives under /var → /private/var, so the vault root itself is
// behind a symlink — which exercises the realpath comparison for free.
let tmpRoot: string;
let outsideRoot: string;
let vault: typeof import("../vault.js");

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  outsideRoot = await mkdtemp(path.join(tmpdir(), "vault-outside-"));
  process.env.VAULT_PATH = tmpRoot;
  vault = await import("../vault.js");
});

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});

describe("resolveInVault — lexical guards", () => {
  test("resolves a plain relative path inside the vault", () => {
    const abs = vault.resolveInVault("Projects/Plan.md");
    assert.ok(abs.endsWith(path.join("Projects", "Plan.md")));
  });

  test("strips leading ../ rather than escaping", () => {
    const abs = vault.resolveInVault("../../etc/passwd");
    // Must stay inside the vault root, not resolve to the real /etc/passwd.
    assert.ok(abs.startsWith(tmpRoot + path.sep));
  });

  test("refuses ignored folders", () => {
    assert.throws(() => vault.resolveInVault(".obsidian/app.json"), /ignored folder/);
    assert.throws(() => vault.resolveInVault(".git/config"), /ignored folder/);
  });

  test("nonexistent nested path is allowed (writeNote creates parents)", () => {
    const abs = vault.resolveInVault("new/deeply/nested/note.md");
    assert.ok(abs.includes("nested"));
  });
});

describe("resolveInVault — symlink escape guard", () => {
  test("refuses a symlinked FILE pointing outside the vault", async () => {
    const secret = path.join(outsideRoot, "secret.md");
    await writeFile(secret, "outside the vault", "utf8");
    await symlink(secret, path.join(tmpRoot, "link.md"));
    assert.throws(() => vault.resolveInVault("link.md"), /symlink/);
  });

  test("refuses a path THROUGH a symlinked dir pointing outside the vault", async () => {
    const outDir = path.join(outsideRoot, "notes");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "note.md"), "outside", "utf8");
    await symlink(outDir, path.join(tmpRoot, "sub"));
    assert.throws(() => vault.resolveInVault("sub/note.md"), /symlink/);
  });

  test("refuses a NONEXISTENT path under a symlinked dir (write-side escape)", async () => {
    const outDir = path.join(outsideRoot, "writable");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "drop"));
    // drop/new.md doesn't exist yet — the guard must still catch the dir.
    assert.throws(() => vault.resolveInVault("drop/new.md"), /symlink/);
  });

  test("allows a symlink that stays within the vault", async () => {
    await writeFile(path.join(tmpRoot, "real.md"), "hello", "utf8");
    await symlink(path.join(tmpRoot, "real.md"), path.join(tmpRoot, "alias.md"));
    const abs = vault.resolveInVault("alias.md");
    assert.ok(abs.endsWith("alias.md"));
  });

  test("readNote through an escaping symlink fails", async () => {
    const secret = path.join(outsideRoot, "creds.md");
    await writeFile(secret, "token", "utf8");
    await symlink(secret, path.join(tmpRoot, "creds.md"));
    await assert.rejects(() => vault.readNote("creds.md"), /symlink/);
  });

  test("writeNote into an escaping symlinked dir fails and writes nothing outside", async () => {
    const outDir = path.join(outsideRoot, "target");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "evil"));
    await assert.rejects(() => vault.writeNote("evil/x.md", "payload", false), /symlink/);
  });
});
