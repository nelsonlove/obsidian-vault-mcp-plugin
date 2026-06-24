import * as os from "node:os";
import * as path from "node:path";
import { Plugin, FileSystemAdapter, Notice } from "obsidian";
import { UnixSocketServerTransport } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import { vaultSlug, socketPath, bridgeDestPath } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { wireUpClaudeConfig } from "./wire-up.js";

export default class VaultMcpPlugin extends Plugin {
  private transport: UnixSocketServerTransport | null = null;
  private slug = "";

  async onload() {
    const vaultName = this.app.vault.getName();
    this.slug = vaultSlug(vaultName);
    const sock = socketPath(this.slug);

    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

    // Write the build-time-embedded bridge into ~/.claude/vault-mcp/.
    try { writeBridge(); }
    catch (e) { console.error("[vault-mcp] writeBridge failed", e); }

    this.transport = new UnixSocketServerTransport(sock);
    const server = buildMcpServer(this.app, {
      pluginVersion: this.manifest.version,
      socketPath: sock,
      vaultName,
      enabledPlugins: () => Array.from((this.app as any).plugins.enabledPlugins as Set<string>),
    });

    await this.transport.listen();
    await server.connect(this.transport);

    const discovery: Discovery = {
      socket_path: sock,
      vault_path: basePath,
      vault_name: vaultName,
      plugin_version: this.manifest.version,
      obsidian_version: (this.app as any).appVersion ?? "",
      started_at: new Date().toISOString(),
    };
    writeDiscovery(this.slug, discovery);
    console.log(`[vault-mcp] listening on ${sock}`);

    this.addCommand({
      id: "wire-up-claude-code",
      name: "Wire up Claude Code",
      callback: () => {
        try {
          const configPath = path.join(os.homedir(), ".claude.json");
          wireUpClaudeConfig({ bridgePath: bridgeDestPath(), vaultName: this.app.vault.getName(), configPath });
          new Notice("vault-mcp: wrote mcpServers entry to ~/.claude.json. Restart your Claude Code session.");
        } catch (e) {
          new Notice(`vault-mcp: wire-up failed — ${(e as Error).message}`);
        }
      },
    });
  }

  async onunload() {
    await this.transport?.close();
    removeDiscovery(this.slug);
  }
}
