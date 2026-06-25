import * as net from "node:net";
import * as fs from "node:fs";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * SDK Transport for a SINGLE Unix-socket connection. Frames newline-delimited
 * JSON-RPC. One of these is created per accepted connection, so concurrent
 * MCP clients each get their own independent session.
 */
export class UnixSocketConnTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;

  private buf = "";
  private started = false;

  constructor(private readonly conn: net.Socket) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.conn.setEncoding("utf8");
    this.conn.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch (e) {
          this.onerror?.(e as Error);
        }
      }
    });
    this.conn.on("close", () => this.onclose?.());
    this.conn.on("error", (e) => this.onerror?.(e));
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.conn.destroyed) return; // peer gone; drop
    const data = JSON.stringify(message) + "\n";
    await new Promise<void>((res, rej) => this.conn.write(data, (err) => (err ? rej(err) : res())));
  }

  async close(): Promise<void> {
    this.conn.destroy();
  }
}

/**
 * Listens on a Unix socket and hands each accepted connection to `onConnection`
 * as its own transport. The caller wires a fresh MCP server per connection, so
 * multiple Claude Code sessions (and background agents) can connect at once
 * without evicting one another.
 */
export class UnixSocketListener {
  private server: net.Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly onConnection: (transport: UnixSocketConnTransport) => void,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        reject(new Error("already listening"));
        return;
      }
      try { fs.unlinkSync(this.socketPath); } catch { /* none */ }
      const server = net.createServer((conn) => {
        // Guard the window before the transport attaches its own error handler,
        // so a connection error can't crash the whole socket server.
        conn.on("error", () => { /* surfaced again via the transport once started */ });
        this.onConnection(new UnixSocketConnTransport(conn));
      });
      this.server = server;
      const onListenErr = (e: Error) => reject(e);
      server.once("error", onListenErr);
      server.listen(this.socketPath, () => {
        server.off("error", onListenErr);
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch (e) {
          reject(e as Error);
          return;
        }
        server.on("error", (e) => console.error("[vault-mcp] socket server error", e));
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    // Defensive cleanup: some platforms don't auto-remove the socket file.
    try { fs.unlinkSync(this.socketPath); } catch { /* already gone */ }
  }
}
