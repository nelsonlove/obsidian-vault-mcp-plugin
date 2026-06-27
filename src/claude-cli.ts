import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

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
    await pexecFile(bin, ["mcp", "get", "vault-mcp"]);
    return true; // exit 0 => present
  } catch {
    return false;
  }
}

export async function claudeRegister(bin: string, bridgePath: string): Promise<void> {
  // Generic registration; Claude Code writes its own user config.
  await pexecFile(bin, ["mcp", "add", "--scope", "user", "vault-mcp", "--", "node", bridgePath]);
}

export async function claudeRemove(bin: string): Promise<void> {
  await pexecFile(bin, ["mcp", "remove", "vault-mcp"]).catch(() => { /* ignore if absent */ });
}
