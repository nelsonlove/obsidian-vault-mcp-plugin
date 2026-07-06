import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

// Obsidian's GUI process inherits a minimal PATH. The `claude` launcher is
// commonly a shell shim that runs `#!/usr/bin/env node`, which fails with
// ENOENT when node's directory isn't on PATH. Augment PATH for spawned calls
// so the shim (and any node-based CLI) can resolve `node`.
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const parts = [base.PATH, ...EXTRA_BIN_DIRS].filter(Boolean) as string[];
  return { ...base, PATH: parts.join(":") };
}

// Pure + testable: returns the first candidate that exists, else null.
export function findClaudeBinary(opts?: {
  candidates?: string[];
  fileExists?: (p: string) => boolean;
}): string | null {
  const home = os.homedir();
  const candidates = opts?.candidates ?? [
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const exists = opts?.fileExists ?? ((p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

export async function claudeIsRegistered(bin: string): Promise<boolean> {
  try {
    await pexecFile(bin, ["mcp", "get", "vault-mcp"], { env: spawnEnv() });
    return true; // exit 0 => present
  } catch {
    return false;
  }
}

// Pure + testable: the `claude mcp add` argv. Pins `--vault <name>` when given
// so the bridge is unambiguous once a second vault starts serving MCP (without
// it, the bridge aborts with "multiple vaults open; specify --vault").
export function registerArgs(bridgePath: string, vaultName?: string): string[] {
  const args = ["mcp", "add", "--scope", "user", "vault-mcp", "--", "node", bridgePath];
  if (vaultName) args.push("--vault", vaultName);
  return args;
}

export async function claudeRegister(bin: string, bridgePath: string, vaultName?: string): Promise<void> {
  // Claude Code writes its own user config; we only invoke the CLI.
  await pexecFile(bin, registerArgs(bridgePath, vaultName), { env: spawnEnv() });
}

export async function claudeRemove(bin: string): Promise<void> {
  await pexecFile(bin, ["mcp", "remove", "vault-mcp"], { env: spawnEnv() }).catch(() => { /* ignore if absent */ });
}
