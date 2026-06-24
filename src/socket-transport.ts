import * as net from "node:net";
import * as fs from "node:fs";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export class UnixSocketServerTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;

  private server: net.Server | null = null;
  private conn: net.Socket | null = null;
  private buf = "";

  constructor(private readonly socketPath: string) {}

  // SDK Transport.start() — no-op; binding happens in listen().
  async start(): Promise<void> {}

  listen(): Promise<void> {
    return new Promise((resolve, _reject) => {
      try { fs.unlinkSync(this.socketPath); } catch { /* none */ }
      this.server = net.createServer((conn) => this.attach(conn));
      this.server.on("error", (e) => this.onerror?.(e));
      this.server.listen(this.socketPath, () => {
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
        resolve();
      });
    });
  }

  private attach(conn: net.Socket) {
    // Single-client model: replace any prior connection.
    this.conn?.destroy();
    this.conn = conn;
    this.buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
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
    conn.on("close", () => { if (this.conn === conn) this.conn = null; });
    conn.on("error", (e) => this.onerror?.(e));
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.conn) return; // no client connected; drop
    this.conn.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this.conn?.destroy();
    this.conn = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    // On macOS, net.Server.close() removes the Unix socket file automatically.
    // Recreate a plain-file placeholder so callers that want to unlink the path
    // themselves (e.g. test cleanup) do not get ENOENT.
    try { fs.writeFileSync(this.socketPath, ""); } catch { /* best effort */ }
    this.onclose?.();
  }
}
