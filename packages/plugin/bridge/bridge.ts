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

// Millisecond knobs from the environment. `??` alone is wrong here: an empty
// env var would become Number("") = 0 and a typo NaN, silently defeating the
// knob — fall back to the default unless the value is a real non-negative
// number (an explicit "0" is a valid opt-out, e.g. VAULT_MCP_RECONNECT_MS=0
// restores the old die-on-disconnect behavior).
export function envMs(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// How long to keep polling for a live vault socket before giving up, and how
// often to poll. The wait closes the startup-order race: Claude Code often
// spawns the bridge a moment before Obsidian's plugin has bound its socket, and
// the original bridge failed instantly instead of waiting it out.
const WAIT_MS = envMs(process.env.VAULT_MCP_WAIT_MS, 30000);
const POLL_MS = envMs(process.env.VAULT_MCP_POLL_MS, 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A connect-phase errno worth *retrying*: the vault is down or mid-restart and
// the socket may start accepting shortly. A permanent error (the socket is
// owned by another user, or its perms deny us) can never resolve by waiting —
// polling it for the whole deadline just hangs the session for minutes and then
// reports a generic "plugin disabled" message that masks the real cause. Treat
// those as fatal so they surface immediately. Unknown/undefined codes stay
// retryable (fail-open: the deadline still bounds them).
const FATAL_CONNECT_ERRNOS = new Set(["EACCES", "EPERM"]);

export function retryableConnectError(code: string | undefined): boolean {
  return code === undefined || !FATAL_CONNECT_ERRNOS.has(code);
}

// Resolves to a connected socket, or null if the socket file exists but isn't
// accepting yet (stale/just-restarted) — a retryable condition. Rejects on a
// permanent connect error (EACCES/EPERM) so it fast-fails with the real errno
// instead of polling a socket we can never reach.
function tryConnect(chosen: Discovery): Promise<net.Socket | null> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(chosen.socket_path);
    sock.once("connect", () => resolve(sock));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      sock.destroy();
      if (retryableConnectError(err.code)) {
        resolve(null);
        return;
      }
      reject(
        new Error(
          `vault-mcp: cannot connect to vault '${chosen.vault_name}' — ` +
            `${err.code} on ${chosen.socket_path} (a permission error that won't ` +
            `clear by waiting; check the socket's owner and mode)`
        )
      );
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
// new ones briefly, wait for the vault socket to return, replay the handshake
// to the fresh per-connection McpServer (swallowing the duplicate response the
// client already got), and flush the queue.

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
  id?: JsonRpcId | null;
  method?: string;
  result?: unknown;
  error?: unknown;
}

function parseMsg(raw: string): JsonRpcMsg | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as JsonRpcMsg)
      : null;
  } catch {
    return null;
  }
}

// A JSON-RPC batch is an array of messages; normalize both shapes to a list
// so request tracking covers batched requests too.
function parseItems(raw: string): JsonRpcMsg[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) {
      return v.filter(
        (x): x is JsonRpcMsg => x !== null && typeof x === "object"
      );
    }
    return v !== null && typeof v === "object" ? [v as JsonRpcMsg] : [];
  } catch {
    return [];
  }
}

// `id: null` is JSON-RPC's "unidentifiable request" sentinel (error responses
// to unparseable input) — treat it as absent so it can never match a real id.
function msgId(msg: JsonRpcMsg): JsonRpcId | undefined {
  return msg.id === null ? undefined : msg.id;
}

// What to do with a server→client line:
//   forward       — pass it to the client.
//   drop          — the duplicate success response to a replayed initialize;
//                   the client already has one.
//   replay-error  — the fresh server REJECTED the replayed initialize. The
//                   session cannot continue; surface it, don't hide it.
export type ServerVerdict = "forward" | "drop" | "replay-error";

export class RelayState {
  private initializeRaw: string | null = null;
  private initializedRaw: string | null = null;
  private initializeId: JsonRpcId | undefined = undefined;
  private initResponseSeen = false;
  private awaitingReplayResponse = false;
  private outstanding = new Map<JsonRpcId, string>();

  onClientMessage(raw: string): void {
    const single = parseMsg(raw);
    if (single) {
      const id = msgId(single);
      if (
        single.method === "initialize" &&
        id !== undefined &&
        this.initializeRaw === null
      ) {
        this.initializeRaw = raw;
        this.initializeId = id;
      } else if (
        single.method === "notifications/initialized" &&
        this.initializedRaw === null
      ) {
        this.initializedRaw = raw;
      }
    }
    // Track every request — batched or not — so failOutstanding can answer
    // them. Only requests (id + method) await a response; client→server
    // responses to server-initiated requests carry an id but no method.
    for (const msg of parseItems(raw)) {
      const id = msgId(msg);
      if (id !== undefined && msg.method !== undefined) {
        this.outstanding.set(id, msg.method);
      }
    }
  }

  onServerMessage(raw: string): ServerVerdict {
    const msg = parseMsg(raw);
    if (!msg) {
      // Batch responses resolve their items; the replayed initialize is never
      // sent in a batch, so batches always pass through.
      for (const item of parseItems(raw)) {
        const id = msgId(item);
        if (id !== undefined && item.method === undefined) {
          this.outstanding.delete(id);
        }
      }
      return "forward";
    }
    const id = msgId(msg);
    // Server-initiated requests/notifications have a method; only responses
    // (id, no method) resolve outstanding client requests.
    if (id === undefined || msg.method !== undefined) return "forward";
    this.outstanding.delete(id);
    if (this.initializeId !== undefined && id === this.initializeId) {
      if (this.awaitingReplayResponse) {
        this.awaitingReplayResponse = false;
        return msg.error !== undefined ? "replay-error" : "drop";
      }
      this.initResponseSeen = true;
    }
    return "forward";
  }

  /**
   * JSON-RPC error lines to emit for requests that were in flight when the
   * socket died. An unanswered `initialize` is exempt — the replay resends it
   * and the fresh response is forwarded instead.
   */
  failOutstanding(reason: string): string[] {
    const out: string[] = [];
    for (const [id, method] of [...this.outstanding]) {
      if (
        this.initializeId !== undefined &&
        id === this.initializeId &&
        !this.initResponseSeen
      )
        continue;
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

  /**
   * Decide how to handle a queued client line when the vault won't answer it:
   *   `error` — a JSON-RPC error line to send now (the line's failable
   *             requests, already removed from outstanding); null if none.
   *   `keep`  — the part of the line to re-queue for delivery once the vault
   *             returns (notifications, responses, an unanswered initialize);
   *             null if nothing survives.
   * A single request yields `{error, keep: null}`; a single notification yields
   * `{error: null, keep: line}`. A batch is split: its requests are errored and
   * its notifications are preserved in a `keep` batch — so a `notifications/
   * cancelled` riding alongside a failed request is never lost.
   */
  failRequest(line: string, reason: string): { error: string | null; keep: string | null } {
    const single = parseMsg(line);
    if (single) {
      const id = msgId(single);
      if (id === undefined || single.method === undefined) return { error: null, keep: line };
      if (
        this.initializeId !== undefined &&
        id === this.initializeId &&
        !this.initResponseSeen
      )
        return { error: null, keep: line };
      this.outstanding.delete(id);
      return {
        error: JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `${reason} (request: ${single.method})` },
        }),
        keep: null,
      };
    }
    // Batch: error its requests, but keep its non-request items (notifications,
    // responses) so they can still be delivered after reconnect.
    const errors: unknown[] = [];
    const kept: JsonRpcMsg[] = [];
    for (const msg of parseItems(line)) {
      const id = msgId(msg);
      const isRequest = id !== undefined && msg.method !== undefined;
      const isExemptInitialize =
        this.initializeId !== undefined &&
        id === this.initializeId &&
        !this.initResponseSeen;
      if (!isRequest || isExemptInitialize) {
        kept.push(msg);
        continue;
      }
      this.outstanding.delete(id);
      errors.push({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `${reason} (request: ${msg.method})` },
      });
    }
    return {
      error: errors.length > 0 ? JSON.stringify(errors) : null,
      keep: kept.length > 0 ? JSON.stringify(kept) : null,
    };
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
  clientOut: NodeJS.WritableStream;
  log?: (msg: string) => void;
  exit: (code: number) => void;
}

export interface RelayOpts {
  /** How long queued requests wait for a reconnect before failing (ms). */
  queueGraceMs?: number;
  /** Give up once this many socket deaths flap within the flap window. */
  rapidFailMax?: number;
  /** Per-death spacing knob; the flap window is rapidFailMax × this (ms). */
  rapidFailWindowMs?: number;
  /** Cap on lines held in the disconnected queue before backpressure kicks in. */
  maxPending?: number;
}

// True once the most recent `maxDeaths` socket deaths all fall within `spanMs`.
// Replaces the old "reset the counter whenever one connection outlived the
// window" rule, which a vault dying reliably *just past* the window (≈6s vs a
// 5s window) slipped through forever — each connection looked healthy, so the
// counter reset every cycle and the reconnect loop spun unbounded. A rolling
// window over the deaths themselves catches sustained flapping at any spacing
// up to the window, while human-paced restarts (minutes apart) never trip it.
export function flapExceeded(
  deathTimes: number[],
  maxDeaths: number,
  spanMs: number
): boolean {
  if (deathTimes.length < maxDeaths) return false;
  const recent = deathTimes.slice(-maxDeaths);
  return recent[recent.length - 1] - recent[0] <= spanMs;
}

const DISCONNECT_REASON =
  "vault-mcp: connection to Obsidian lost (restarting?) — retry shortly";

export class BridgeRelay {
  readonly state = new RelayState();
  private sock: net.Socket | null = null;
  private inBuf = "";
  private sockBuf = "";
  private clientEnded = false;
  private pending: string[] = [];
  private graceTimer: NodeJS.Timeout | null = null;
  private graceExpired = false;
  private deathTimes: number[] = [];
  private clientPausedForQueue = false;
  private readonly queueGraceMs: number;
  private readonly rapidFailMax: number;
  private readonly flapSpanMs: number;
  private readonly maxPending: number;

  constructor(
    private io: RelayIO,
    private reconnect: () => Promise<net.Socket>,
    opts: RelayOpts = {}
  ) {
    this.queueGraceMs = opts.queueGraceMs ?? 30000;
    this.rapidFailMax = opts.rapidFailMax ?? 5;
    this.flapSpanMs = this.rapidFailMax * (opts.rapidFailWindowMs ?? 5000);
    this.maxPending = opts.maxPending ?? 10000;
  }

  // Queue a line for later delivery, applying backpressure: once the
  // disconnected queue fills, pause the client so an outage can't grow memory
  // without bound (the connected path pauses on sock overflow the same way).
  private enqueue(line: string): void {
    this.pending.push(line);
    if (this.pending.length >= this.maxPending && !this.clientPausedForQueue) {
      this.clientPausedForQueue = true;
      this.io.clientIn.pause();
    }
  }

  // Undo an enqueue-induced pause once the queue has drained enough.
  private resumeClient(): void {
    if (this.clientPausedForQueue && this.pending.length < this.maxPending) {
      this.clientPausedForQueue = false;
      this.io.clientIn.resume();
    }
  }

  start(first: net.Socket): void {
    // utf8 via setEncoding, NOT per-chunk Buffer.toString(): a multi-byte
    // character split across chunks must be carried, not mangled to U+FFFD.
    this.io.clientIn.setEncoding("utf8");
    this.io.clientIn.on("data", (chunk: Buffer | string) =>
      this.onClientData(typeof chunk === "string" ? chunk : chunk.toString())
    );
    this.io.clientIn.on("end", () => {
      this.clientEnded = true;
      // The old pipe forwarded every byte before half-closing; flush an
      // unterminated final message rather than dropping it.
      if (this.inBuf.length > 0) this.onClientData("\n");
      // Socket up: half-close and let onSocketClose exit. Socket down (mid-
      // reconnect): shutdown() answers anything still queued before exiting —
      // a bare exit(0) here would silently drop requests the client awaits.
      if (this.sock) this.sock.end();
      else this.shutdown(0);
    });
    this.attach(first);
  }

  private onClientData(chunk: string): void {
    const { lines, rest } = splitLines(this.inBuf, chunk);
    this.inBuf = rest;
    const sock = this.sock;
    let overflowed = false;
    for (const line of lines) {
      this.state.onClientMessage(line);
      if (sock) {
        if (!sock.write(`${line}\n`)) overflowed = true;
      } else if (this.graceExpired) {
        // The vault has been gone past the grace budget: answer new requests
        // immediately instead of letting the client hang on the queue, but
        // still keep notifications so they're delivered once the vault returns.
        const { error, keep } = this.state.failRequest(line, DISCONNECT_REASON);
        if (error) this.io.clientOut.write(`${error}\n`);
        if (keep) this.enqueue(keep);
      } else {
        this.enqueue(line);
      }
    }
    // pipe()-equivalent backpressure: pause the source until the sink drains.
    if (overflowed && sock && sock === this.sock) {
      this.io.clientIn.pause();
      sock.once("drain", () => this.io.clientIn.resume());
    }
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.sockBuf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onServerData(chunk, sock));
    sock.on("error", () => {
      /* 'close' always follows; the reconnect path handles it */
    });
    sock.on("close", () => this.onSocketClose());
  }

  private onServerData(chunk: string, sock: net.Socket): void {
    const { lines, rest } = splitLines(this.sockBuf, chunk);
    this.sockBuf = rest;
    let overflowed = false;
    for (const line of lines) {
      const verdict = this.state.onServerMessage(line);
      if (verdict === "replay-error") {
        this.io.log?.(`vault rejected the replayed initialize: ${line}`);
        this.shutdown(1);
        return;
      }
      if (verdict === "forward" && !this.io.clientOut.write(`${line}\n`)) {
        overflowed = true;
      }
    }
    if (overflowed && sock === this.sock) {
      sock.pause();
      this.io.clientOut.once("drain", () => sock.resume());
    }
  }

  private onSocketClose(): void {
    this.sock = null;
    if (this.clientEnded) {
      this.io.exit(0);
      return;
    }
    // A stream paused for backpressure would otherwise stay paused forever;
    // the queue-pause flag is cleared with it so enqueue can re-arm cleanly.
    this.clientPausedForQueue = false;
    this.io.clientIn.resume();
    // A vault that keeps dying is unhealthy — reconnect deadlines never bind
    // (each connect "succeeds"), so bound the churn: give up once deaths flap
    // within the window instead of looping the replay forever.
    this.deathTimes.push(Date.now());
    if (this.deathTimes.length > this.rapidFailMax) this.deathTimes.shift();
    for (const line of this.state.failOutstanding(DISCONNECT_REASON)) {
      this.io.clientOut.write(`${line}\n`);
    }
    if (flapExceeded(this.deathTimes, this.rapidFailMax, this.flapSpanMs)) {
      this.io.log?.(
        `giving up: the vault socket died ${this.rapidFailMax} times within ` +
          `${this.flapSpanMs}ms — the vault plugin looks unhealthy`
      );
      this.shutdown(1);
      return;
    }
    this.graceExpired = false;
    if (this.queueGraceMs > 0) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.graceExpired = true;
        const kept: string[] = [];
        for (const line of this.pending) {
          const { error, keep } = this.state.failRequest(line, DISCONNECT_REASON);
          if (error) this.io.clientOut.write(`${error}\n`);
          if (keep) kept.push(keep);
        }
        this.pending = kept;
        this.resumeClient();
      }, this.queueGraceMs);
    }
    this.io.log?.("socket closed; waiting for Obsidian to come back");
    this.reconnect().then(
      (sock) => {
        // The client EOF'd while we were reconnecting: the session is already
        // shut down. Don't attach/replay against a dead client — just drop the
        // freshly-won socket (and leave no orphaned live connection behind).
        if (this.clientEnded) {
          sock.destroy();
          return;
        }
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.graceExpired = false;
        this.attach(sock);
        // All synchronous, so nothing can interleave: handshake replay first,
        // then everything queued while the vault was down. A handshake message
        // that arrived DURING the outage sits in both places — replay wins,
        // the queued copy is skipped, so the fresh server sees it once.
        const replayed = this.state.replayMessages();
        for (const m of replayed) sock.write(`${m}\n`);
        for (const line of this.pending.splice(0)) {
          if (replayed.includes(line)) continue;
          sock.write(`${line}\n`);
        }
        this.resumeClient();
        this.io.log?.("reconnected");
      },
      (e: unknown) => {
        // Already shut down by the EOF path — nothing left to fail or exit.
        if (this.clientEnded) return;
        this.io.log?.((e as Error).message);
        this.shutdown(1);
      }
    );
  }

  private shutdown(code: number): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // Answer whatever is still queued so the client isn't left hanging.
    for (const line of this.pending.splice(0)) {
      const { error } = this.state.failRequest(line, DISCONNECT_REASON);
      if (error) this.io.clientOut.write(`${error}\n`);
    }
    // Don't exit until clientOut has flushed. clientOut is process.stdout, an
    // async pipe when Claude Code spawns us; process.exit() truncates its
    // unflushed writes, so the synthesized error responses above (and any
    // written earlier this tick by failOutstanding) would never reach the
    // client and it would hang instead of seeing "connection lost". Write
    // callbacks fire in order, so deferring the exit to a final flush's
    // callback guarantees every prior write landed first.
    this.io.clientOut.write("", () => this.io.exit(code));
  }
}

// How long a live session waits for the vault socket to come back after it
// drops (Obsidian restart, plugin reload) before giving up and exiting.
const RECONNECT_MS = envMs(process.env.VAULT_MCP_RECONNECT_MS, 300000);
// How long queued requests wait for that reconnect before failing fast.
const QUEUE_GRACE_MS = envMs(process.env.VAULT_MCP_QUEUE_GRACE_MS, 30000);
// Cap on lines held in the disconnected queue before the client is paused, so
// a long outage streaming notifications can't grow memory without bound.
const MAX_PENDING = envMs(process.env.VAULT_MCP_MAX_PENDING, 10000);

// The startup wait loop, reused for reconnects: poll discoveries until the
// pinned (or sole) vault accepts a connection, else throw the same actionable
// diagnostic the one-shot bridge reported.
async function waitForVault(
  pick: string | undefined,
  deadline: number
): Promise<{ sock: net.Socket; chosen: Discovery }> {
  for (;;) {
    const all = loadDiscoveries();
    // When pinned, only the matching vault can ever be chosen — don't touch
    // (or later, probe) unrelated vaults on every poll tick.
    const candidates = pick ? all.filter((d) => d.vault_name === pick) : all;
    const target = resolveTarget(filterLive(candidates), pick);
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
        clientOut: process.stdout,
        log: (msg) => {
          try {
            fs.writeSync(2, `vault-mcp: ${msg}\n`);
          } catch {
            /* ignore */
          }
        },
        exit: (code) => process.exit(code),
      },
      async () => (await waitForVault(pinned, Date.now() + RECONNECT_MS)).sock,
      { queueGraceMs: QUEUE_GRACE_MS, maxPending: MAX_PENDING }
    );
    relay.start(sock);
  })().catch((e) => {
    // Diagnostics from waitForVault already carry the vault-mcp prefix;
    // don't stutter it.
    const msg = (e as Error).message;
    fail(msg.startsWith("vault-mcp") ? msg : `vault-mcp bridge: ${msg}`);
  });
}
