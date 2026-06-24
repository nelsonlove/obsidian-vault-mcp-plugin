import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Discovery {
  vault_name: string;
  socket_path: string;
  [k: string]: unknown;
}

export function selectVault(
  discoveries: Discovery[],
  opts: { flag?: string; env?: string }
): Discovery {
  const pick = opts.flag ?? opts.env;
  if (pick) {
    const found = discoveries.find((d) => d.vault_name === pick);
    if (!found) {
      throw new Error(
        `no vault named "${pick}"; available: ${discoveries.map((d) => d.vault_name).join(", ") || "(none)"}`
      );
    }
    return found;
  }
  if (discoveries.length === 1) return discoveries[0];
  if (discoveries.length === 0) throw new Error("no vault discovery files found in ~/.claude/vault-mcp/");
  throw new Error(
    `multiple vaults open; specify --vault <name>: ${discoveries.map((d) => d.vault_name).join(", ")}`
  );
}

function loadDiscoveries(): Discovery[] {
  const dir = path.join(os.homedir(), ".claude", "vault-mcp");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: Discovery[] = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch { /* skip */ }
  }
  return out;
}

function parseFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Entry point (skipped under test import; runs when executed as a script).
if (process.argv[1] && process.argv[1].endsWith("bridge.mjs")) {
  try {
    const chosen = selectVault(loadDiscoveries(), {
      flag: parseFlag(process.argv, "vault"),
      env: process.env.VAULT_MCP_VAULT,
    });
    const sock = net.createConnection(chosen.socket_path);
    sock.on("connect", () => {
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
    });
    sock.on("error", (e) => { process.stderr.write(`vault-mcp bridge: ${e.message}\n`); process.exit(1); });
    sock.on("close", () => process.exit(0));
  } catch (e) {
    process.stderr.write(`vault-mcp bridge: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
