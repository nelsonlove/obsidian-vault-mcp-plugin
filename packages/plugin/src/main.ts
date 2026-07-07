import { Plugin, FileSystemAdapter, Modal, Notice } from "obsidian";
import * as fs from "node:fs";
import { UnixSocketListener } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import { vaultSlug, socketPath, stateDir, bridgeDestPath } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { ConnectionSetupModal, VaultMcpSettingTab } from "./connection-ui.js";
import { findClaudeBinary, claudeIsRegistered, claudeRegister, claudeRemove } from "./claude-cli.js";
import { ExternalToolRegistry, type VaultMcpApi } from "./mcp/external-tools.js";

interface VaultMcpSettings { setupAcknowledged: boolean; readOnly: boolean; allowlist: string[]; enabled: boolean; }
const DEFAULT_SETTINGS: VaultMcpSettings = { setupAcknowledged: false, readOnly: false, allowlist: [], enabled: true };

class DiagnosticsModal extends Modal {
  constructor(app: any, private readonly lines: string[]) { super(app); }
  onOpen() {
    this.titleEl.setText("vault-mcp diagnostics");
    for (const l of this.lines) this.contentEl.createEl("p", { text: l });
  }
  onClose() { this.contentEl.empty(); }
}

export default class VaultMcpPlugin extends Plugin {
  private listener: UnixSocketListener | null = null;
  private slug = "";
  declare settings: VaultMcpSettings;
  private externalRegistry = new ExternalToolRegistry();
  // Public plugin-to-plugin API: app.plugins.plugins['vault-mcp'].api
  api: VaultMcpApi = {
    apiVersion: 1,
    registerTools: (owner, tools) => this.externalRegistry.registerTools(owner, tools),
    unregisterTools: (owner) => this.externalRegistry.unregisterTools(owner),
  };

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  private discoveryCount(): number {
    try { return fs.readdirSync(stateDir()).filter((f) => f.endsWith(".json")).length; }
    catch { return 0; }
  }

  async autoRegister(force = false): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) {
      if (force) new Notice("vault-mcp: `claude` CLI not found. Use the manual command in settings.");
      else this.showFallbackOnce();
      return;
    }
    if (!force && this.discoveryCount() > 1) { this.showFallbackOnce(); return; } // ambiguous: multiple vaults
    try {
      if (await claudeIsRegistered(bin)) {
        // `claude mcp add` errors on a duplicate name, so never re-add.
        if (force) new Notice("vault-mcp: already connected to Claude Code.");
        return;
      }
      await claudeRegister(bin, bridgeDestPath(), this.app.vault.getName());
      new Notice("vault-mcp: connected to Claude Code. Restart any open Claude Code session to use it.");
    } catch (e) {
      new Notice(`vault-mcp: auto-register failed — ${(e as Error).message}. Use the manual command in settings.`);
      this.showFallbackOnce();
    }
  }

  async claudeRemoveRegistration(): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) { new Notice("vault-mcp: `claude` CLI not found."); return; }
    await claudeRemove(bin);
    new Notice("vault-mcp: removed Claude Code registration.");
  }

  private showFallbackOnce(): void {
    if (this.settings.setupAcknowledged) return;
    new ConnectionSetupModal(this.app, async () => { this.settings.setupAcknowledged = true; await this.saveSettings(); }).open();
  }

  async onload() {
    // Load settings FIRST so the enabled gate and guard settings are available.
    await this.loadSettings();

    const vaultName = this.app.vault.getName();
    this.slug = vaultSlug(vaultName);
    const sock = socketPath(this.slug);

    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

    // Write the build-time-embedded bridge into ~/.claude/vault-mcp/.
    try { writeBridge(); }
    catch (e) { console.error("[vault-mcp] writeBridge failed", e); }

    const ctx = {
      pluginVersion: this.manifest.version,
      socketPath: sock,
      vaultName,
      enabledPlugins: () => Array.from((this.app as any).plugins.enabledPlugins as Set<string>),
      getSettings: () => ({ readOnly: this.settings.readOnly, allowlist: this.settings.allowlist }),
      getExternalTools: () => this.externalRegistry.entries(),
    };

    if (this.settings.enabled) {
      // One MCP server per connection → concurrent Claude Code sessions and
      // background agents share the plugin without evicting each other.
      this.listener = new UnixSocketListener(sock, (transport) => {
        const server = buildMcpServer(this.app, ctx);
        server.connect(transport).catch((e) => console.error("[vault-mcp] connect failed", e));
      });
      await this.listener.listen();

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
    } else {
      console.log("[vault-mcp] disabled in settings; socket not started");
    }

    this.addSettingTab(new VaultMcpSettingTab(this.app, this));

    this.addCommand({
      id: "connect-claude-code",
      name: "Connect to Claude Code",
      callback: () => this.autoRegister(true),
    });

    void this.autoRegister();

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

    // Signal publishers (vault-mcp-api SDK) that the api is (re-)available.
    this.app.workspace.trigger("vault-mcp:ready", this.api);
  }

  async onunload() {
    await this.listener?.close();
    removeDiscovery(this.slug);
  }
}
