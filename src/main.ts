import { Plugin } from "obsidian";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export default class VaultMcpPlugin extends Plugin {
  private server: net.Server | null = null;

  async onload() {
    const dir = path.join(os.homedir(), ".claude", "vault-mcp");
    fs.mkdirSync(dir, { recursive: true });
    const sock = path.join(dir, "spike.sock");
    try { fs.unlinkSync(sock); } catch { /* not present */ }

    this.server = net.createServer((conn) => {
      conn.setEncoding("utf8");
      conn.on("data", (line) => conn.write(`echo: ${line}`));
    });
    this.server.listen(sock, () => {
      fs.chmodSync(sock, 0o600);
      console.log(`[vault-mcp spike] listening on ${sock}`);
    });
    this.server.on("error", (e) => console.error("[vault-mcp spike] error", e));
  }

  async onunload() {
    this.server?.close();
  }
}
