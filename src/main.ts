import { Plugin, FileSystemAdapter, Modal } from "obsidian";
import { UnixSocketServerTransport } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import { vaultSlug, socketPath } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { ConnectionSetupModal, VaultMcpSettingTab } from "./connection-ui.js";

interface VaultMcpSettings { setupAcknowledged: boolean; }
const DEFAULT_SETTINGS: VaultMcpSettings = { setupAcknowledged: false };

class DiagnosticsModal extends Modal {
  constructor(app: any, private readonly lines: string[]) { super(app); }
  onOpen() {
    this.titleEl.setText("vault-mcp diagnostics");
    for (const l of this.lines) this.contentEl.createEl("p", { text: l });
  }
  onClose() { this.contentEl.empty(); }
}

export default class VaultMcpPlugin extends Plugin {
  private transport: UnixSocketServerTransport | null = null;
  private slug = "";
  declare settings: VaultMcpSettings;

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

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

    await this.loadSettings();
    this.addSettingTab(new VaultMcpSettingTab(this.app, this));

    this.addCommand({
      id: "connect-claude-code",
      name: "Connect to Claude Code (show setup command)",
      callback: () => new ConnectionSetupModal(this.app).open(),
    });

    if (!this.settings.setupAcknowledged) {
      new ConnectionSetupModal(this.app, async () => {
        this.settings.setupAcknowledged = true;
        await this.saveSettings();
      }).open();
    }

    this.addCommand({
      id: "show-diagnostics",
      name: "Show diagnostics",
      callback: () => {
        const enabled = Array.from((this.app as any).plugins.enabledPlugins as Set<string>);
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"]
          .map((id) => `${id}: ${enabled.includes(id) ? "yes" : "no"}`);
        new DiagnosticsModal(this.app, [
          `Vault: ${this.app.vault.getName()}`,
          `Socket: ${socketPath(this.slug)}`,
          `Version: ${this.manifest.version}`,
          ...integrations,
        ]).open();
      },
    });
  }

  async onunload() {
    await this.transport?.close();
    removeDiscovery(this.slug);
  }
}
