import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Discovery {
  vault_name: string;
  socket_path: string;
  [k: string]: unknown;
}

const ENABLE_HINT =
  "open Obsidian and enable the 'Vault MCP' plugin (Settings → Community plugins)";

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
  if (discoveries.length === 0)
    throw new Error(`no vault is currently serving MCP — ${ENABLE_HINT}`);
  throw new Error(
    `multiple vaults open; specify --vault <name>: ${discoveries.map((d) => d.vault_name).join(", ")}`
  );
}

// A discovery is "live" only if its Unix socket still exists. A disabled plugin
// or closed Obsidian leaves a stale *.json behind pointing at a socket that's gone.
export function filterLive(
  discoveries: Discovery[],
  exists: (p: string) => boolean = fs.existsSync
): Discovery[] {
  return discoveries.filter((d) => {
    try {
      return exists(d.socket_path);
    } catch {
      return false;
    }
  });
}

// --- Actionable diagnostics (pure, so they can be unit-tested) ---

export function noLiveMessage(all: Discovery[]): string {
  return all.length > 0
    ? `vault-mcp: found vault discovery but no live socket — the 'Vault MCP' plugin is ` +
        `disabled or Obsidian is closed.\n  Fix: ${ENABLE_HINT}.\n` +
        `  (stale discovery for: ${all.map((d) => d.vault_name).join(", ")})`
    : `vault-mcp: no vault is currently serving MCP — ${ENABLE_HINT}.`;
}

export function staleRequestedMessage(pick: string): string {
  return (
    `vault-mcp: vault '${pick}' has a discovery but no live socket — the 'Vault MCP' ` +
    `plugin is disabled or Obsidian isn't running.\n  Fix: ${ENABLE_HINT}.`
  );
}

export function connectFailMessage(chosen: Discovery): string {
  return (
    `vault-mcp: can't connect to vault '${chosen.vault_name}' — the 'Vault MCP' plugin ` +
    `is disabled or Obsidian isn't running.\n  Fix: ${ENABLE_HINT}.\n  (socket: ${chosen.socket_path})`
  );
}

function loadDiscoveries(): Discovery[] {
  const dir = path.join(os.homedir(), ".claude", "vault-mcp");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Discovery[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      /* skip */
    }
  }
  return out;
}

function parseFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Given the current discovery snapshot, decide what to do. Separated from the
// wait loop so it stays pure and unit-testable.
//   ok    — a vault is live and unambiguously chosen; connect to it.
//   wait  — nothing usable *yet*, but a live vault could still appear
//           (Obsidian mid-launch, plugin re-enabling). Retry until the deadline.
//   fatal — waiting cannot help (multiple live vaults, none pinned). Fail now.
export type Target =
  | { kind: "ok"; chosen: Discovery }
  | { kind: "wait" }
  | { kind: "fatal"; message: string };

export function resolveTarget(
  live: Discovery[],
  pick: string | undefined
): Target {
  if (pick) {
    const hit = live.find((d) => d.vault_name === pick);
    // A pinned vault that isn't live yet is retryable — it may still register.
    return hit ? { kind: "ok", chosen: hit } : { kind: "wait" };
  }
  if (live.length === 1) return { kind: "ok", chosen: live[0] };
  if (live.length === 0) return { kind: "wait" };
  return {
    kind: "fatal",
    message: `vault-mcp: multiple vaults open; specify --vault <name>: ${live
      .map((d) => d.vault_name)
      .join(", ")}`,
  };
}

// The diagnostic to emit once the wait budget is exhausted, mirroring the
// precise cause the original one-shot bridge would have reported.
export function deadlineMessage(
  all: Discovery[],
  pick: string | undefined
): string {
  if (pick) {
    return all.some((d) => d.vault_name === pick)
      ? staleRequestedMessage(pick)
      : `vault-mcp: no vault named "${pick}"; available: ${all.map((d) => d.vault_name).join(", ") || "(none)"}`;
  }
  // Exactly one discovery we still couldn't reach: name it and its socket.
  if (all.length === 1) return connectFailMessage(all[0]);
  return noLiveMessage(all);
}

// Synchronous write to fd 2 so the message flushes before exit even when stderr
// is a POSIX pipe (as it is when Claude Code spawns the bridge as an MCP server).
function fail(msg: string): never {
  try {
    fs.writeSync(2, `${msg}\n`);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

// How long to keep polling for a live vault socket before giving up, and how
// often to poll. The wait closes the startup-order race: Claude Code often
// spawns the bridge a moment before Obsidian's plugin has bound its socket, and
// the original bridge failed instantly instead of waiting it out.
const WAIT_MS = Number(process.env.VAULT_MCP_WAIT_MS ?? 30000);
const POLL_MS = Number(process.env.VAULT_MCP_POLL_MS ?? 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves to a connected socket, or null if the socket file exists but isn't
// accepting yet (stale/just-restarted) — a retryable condition. Rejects only on
// unexpected errors worth surfacing immediately.
function tryConnect(chosen: Discovery): Promise<net.Socket | null> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(chosen.socket_path);
    sock.once("connect", () => resolve(sock));
    sock.once("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      sock.destroy();
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve(null);
      else reject(e);
    });
  });
}

// Entry point (skipped under test import; runs when executed as a script).
if (process.argv[1] && process.argv[1].endsWith("bridge.mjs")) {
  const pick = parseFlag(process.argv, "vault") ?? process.env.VAULT_MCP_VAULT;
  const deadline = Date.now() + WAIT_MS;
  (async () => {
    for (;;) {
      const all = loadDiscoveries();
      const target = resolveTarget(filterLive(all), pick);
      if (target.kind === "fatal") fail(target.message);
      if (target.kind === "ok") {
        const sock = await tryConnect(target.chosen);
        if (sock) {
          process.stdin.pipe(sock);
          sock.pipe(process.stdout);
          sock.on("close", () => process.exit(0));
          return;
        }
        // Socket file present but not accepting yet — fall through and retry.
      }
      if (Date.now() >= deadline) fail(deadlineMessage(all, pick));
      await sleep(POLL_MS);
    }
  })().catch((e) => fail(`vault-mcp bridge: ${(e as Error).message}`));
}
