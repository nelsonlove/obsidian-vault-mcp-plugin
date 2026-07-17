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

// --- Reconnect-aware relay ---
//
// The bridge used to be a dumb byte pipe that exited when the socket closed,
// so every Obsidian restart (or vault-mcp plugin reload) killed the MCP server
// for the whole Claude Code session. Instead we parse the NDJSON stream just
// enough to survive a restart: capture the client's `initialize` handshake,
// and when the socket dies with the client still attached, fail in-flight
// requests (they may have had partial effects, so they can't be resent), queue
// new ones, wait for the vault socket to return, replay the handshake to the
// fresh per-connection McpServer (swallowing the duplicate response the client
// already got), and flush the queue.

export function splitLines(
  buffer: string,
  chunk: string
): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
      .filter((l) => l.length > 0),
    rest,
  };
}

type JsonRpcId = string | number;

interface JsonRpcMsg {
  id?: JsonRpcId;
  method?: string;
  result?: unknown;
  error?: unknown;
}

function parseMsg(raw: string): JsonRpcMsg | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" ? (v as JsonRpcMsg) : null;
  } catch {
    return null;
  }
}

export class RelayState {
  private initializeRaw: string | null = null;
  private initializedRaw: string | null = null;
  private initializeId: JsonRpcId | null = null;
  private initResponseSeen = false;
  private awaitingReplayResponse = false;
  private outstanding = new Map<JsonRpcId, string>();

  onClientMessage(raw: string): void {
    const msg = parseMsg(raw);
    if (!msg) return;
    if (
      msg.method === "initialize" &&
      msg.id !== undefined &&
      this.initializeRaw === null
    ) {
      this.initializeRaw = raw;
      this.initializeId = msg.id;
    } else if (
      msg.method === "notifications/initialized" &&
      this.initializedRaw === null
    ) {
      this.initializedRaw = raw;
    }
    // Only requests (id + method) await a response; client→server responses to
    // server-initiated requests carry an id but no method.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.outstanding.set(msg.id, msg.method);
    }
  }

  /** @returns true when the server line should be forwarded to the client. */
  onServerMessage(raw: string): boolean {
    const msg = parseMsg(raw);
    if (!msg) return true;
    // Server-initiated requests/notifications have a method; only responses
    // (id, no method) resolve outstanding client requests.
    if (msg.id === undefined || msg.method !== undefined) return true;
    this.outstanding.delete(msg.id);
    if (msg.id === this.initializeId) {
      if (this.awaitingReplayResponse) {
        // The client already has its initialize response; this one only
        // exists to satisfy the fresh server's handshake.
        this.awaitingReplayResponse = false;
        return false;
      }
      this.initResponseSeen = true;
    }
    return true;
  }

  /**
   * JSON-RPC error lines to emit for requests that were in flight when the
   * socket died. An unanswered `initialize` is exempt — the replay resends it
   * and the fresh response is forwarded instead.
   */
  failOutstanding(reason: string): string[] {
    const out: string[] = [];
    for (const [id, method] of [...this.outstanding]) {
      if (id === this.initializeId && !this.initResponseSeen) continue;
      out.push(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `${reason} (request: ${method})` },
        })
      );
      this.outstanding.delete(id);
    }
    return out;
  }

  /** Handshake lines to send to a fresh server before resuming traffic. */
  replayMessages(): string[] {
    const out: string[] = [];
    if (this.initializeRaw !== null) {
      out.push(this.initializeRaw);
      // Swallow the duplicate response only if the client already got one;
      // otherwise the fresh response answers the still-outstanding request.
      if (this.initResponseSeen) this.awaitingReplayResponse = true;
    }
    if (this.initializedRaw !== null) out.push(this.initializedRaw);
    return out;
  }
}

export interface RelayIO {
  clientIn: NodeJS.ReadableStream;
  /** Write one NDJSON line (no trailing newline) to the client. */
  writeToClient: (line: string) => void;
  log?: (msg: string) => void;
  exit: (code: number) => void;
}

export class BridgeRelay {
  readonly state = new RelayState();
  private sock: net.Socket | null = null;
  private inBuf = "";
  private sockBuf = "";
  private clientEnded = false;
  private pending: string[] = [];

  constructor(
    private io: RelayIO,
    private reconnect: () => Promise<net.Socket>
  ) {}

  start(first: net.Socket): void {
    this.io.clientIn.on("data", (chunk: Buffer | string) =>
      this.onClientData(chunk.toString())
    );
    this.io.clientIn.on("end", () => {
      this.clientEnded = true;
      // Half-close so the server can finish in-flight work, then exit on its
      // 'close' — matching the old pipe behavior.
      if (this.sock) this.sock.end();
      else this.io.exit(0);
    });
    this.attach(first);
  }

  private onClientData(chunk: string): void {
    const { lines, rest } = splitLines(this.inBuf, chunk);
    this.inBuf = rest;
    for (const line of lines) {
      this.state.onClientMessage(line);
      if (this.sock) this.sock.write(`${line}\n`);
      else this.pending.push(line);
    }
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.sockBuf = "";
    sock.on("data", (chunk) => this.onServerData(chunk.toString()));
    sock.on("error", () => {
      /* 'close' always follows; the reconnect path handles it */
    });
    sock.on("close", () => this.onSocketClose());
  }

  private onServerData(chunk: string): void {
    const { lines, rest } = splitLines(this.sockBuf, chunk);
    this.sockBuf = rest;
    for (const line of lines) {
      if (this.state.onServerMessage(line)) this.io.writeToClient(line);
    }
  }

  private onSocketClose(): void {
    this.sock = null;
    if (this.clientEnded) {
      this.io.exit(0);
      return;
    }
    for (const line of this.state.failOutstanding(
      "vault-mcp: connection to Obsidian lost (restarting?) — retry shortly"
    )) {
      this.io.writeToClient(line);
    }
    this.io.log?.("socket closed; waiting for Obsidian to come back");
    this.reconnect().then(
      (sock) => {
        this.attach(sock);
        // All synchronous, so nothing can interleave: handshake replay first,
        // then everything queued while the vault was down.
        for (const m of this.state.replayMessages()) sock.write(`${m}\n`);
        for (const line of this.pending.splice(0)) sock.write(`${line}\n`);
        this.io.log?.("reconnected");
      },
      (e: unknown) => {
        this.io.log?.((e as Error).message);
        this.io.exit(1);
      }
    );
  }
}

// How long a live session waits for the vault socket to come back after it
// drops (Obsidian restart, plugin reload) before giving up and exiting.
const RECONNECT_MS = Number(process.env.VAULT_MCP_RECONNECT_MS ?? 300000);

// The startup wait loop, reused for reconnects: poll discoveries until the
// pinned (or sole) vault accepts a connection, else throw the same actionable
// diagnostic the one-shot bridge reported.
async function waitForVault(
  pick: string | undefined,
  deadline: number
): Promise<{ sock: net.Socket; chosen: Discovery }> {
  for (;;) {
    const all = loadDiscoveries();
    const target = resolveTarget(filterLive(all), pick);
    if (target.kind === "fatal") throw new Error(target.message);
    if (target.kind === "ok") {
      const sock = await tryConnect(target.chosen);
      if (sock) return { sock, chosen: target.chosen };
      // Socket file present but not accepting yet — fall through and retry.
    }
    if (Date.now() >= deadline) throw new Error(deadlineMessage(all, pick));
    await sleep(POLL_MS);
  }
}

// Entry point (skipped under test import; runs when executed as a script).
if (process.argv[1] && process.argv[1].endsWith("bridge.mjs")) {
  const pick = parseFlag(process.argv, "vault") ?? process.env.VAULT_MCP_VAULT;
  (async () => {
    const { sock, chosen } = await waitForVault(pick, Date.now() + WAIT_MS);
    // Pin reconnects to the vault we first connected to, so another vault
    // appearing mid-session can neither divert nor ambiguate the reconnect.
    const pinned = chosen.vault_name;
    const relay = new BridgeRelay(
      {
        clientIn: process.stdin,
        writeToClient: (line) => process.stdout.write(`${line}\n`),
        log: (msg) => {
          try {
            fs.writeSync(2, `vault-mcp: ${msg}\n`);
          } catch {
            /* ignore */
          }
        },
        exit: (code) => process.exit(code),
      },
      async () => (await waitForVault(pinned, Date.now() + RECONNECT_MS)).sock
    );
    relay.start(sock);
  })().catch((e) => fail(`vault-mcp bridge: ${(e as Error).message}`));
}
