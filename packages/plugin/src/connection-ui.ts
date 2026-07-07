import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import { findClaudeBinary, claudeIsRegistered } from "./claude-cli.js";

export function registerCommandFor(app: App): string {
  // Pin the current vault so the command stays unambiguous once a second vault
  // starts serving MCP. To point Claude Code at a different vault, re-run this
  // from that vault (or edit the `--vault <name>` value in the registered config).
  return buildRegisterCommand({ bridgePath: bridgeDestPath(), vaultName: app.vault.getName() });
}

// Shown alongside the manual command so the pinned `--vault` isn't a surprise.
export const SWITCH_VAULT_NOTE =
  "This command pins Claude Code to this vault via `--vault`. To switch vaults later, run Connect from the other vault, or edit the `--vault <name>` value in the config.";

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice("Copied. Paste it in a terminal, then restart any open Claude Code session.");
}

export class ConnectionSetupModal extends Modal {
  constructor(app: App, private onAck?: () => void) { super(app); }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Connect vault-mcp to Claude Code (manual fallback)");
    contentEl.createEl("p", {
      text: "Couldn't auto-register (claude CLI not found or multiple vaults). Run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    contentEl.createEl("pre").createEl("code", { text: cmd });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const copyBtn = btns.createEl("button", { text: "Copy command", cls: "mod-cta" });
    copyBtn.onclick = () => copyToClipboard(cmd);
    const ackBtn = btns.createEl("button", { text: "I've run it — don't show again" });
    ackBtn.onclick = () => { this.onAck?.(); this.close(); };
    contentEl.createEl("p", { cls: "mod-warning", text: SWITCH_VAULT_NOTE });
    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Paste in a terminal where the `claude` CLI is available. Restart any running Claude Code session afterward.",
    });
  }
  onClose() { this.contentEl.empty(); }
}

export class VaultMcpSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultMcpPlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Claude Code connection" });

    // Async status line: render placeholder then update after await.
    const statusEl = containerEl.createEl("p", { text: "Checking registration status…" });
    const bin = findClaudeBinary();
    if (!bin) {
      statusEl.setText("Registered with Claude Code: claude CLI not found — use the manual command below.");
    } else {
      claudeIsRegistered(bin).then((registered) => {
        statusEl.setText(`Registered with Claude Code: ${registered ? "yes" : "no"}`);
      }).catch(() => {
        statusEl.setText("Registered with Claude Code: (error checking status)");
      });
    }

    // Connect / Disconnect buttons.
    new Setting(containerEl)
      .setName("Registration")
      .setDesc("Connect or disconnect this vault's MCP server from Claude Code.")
      .addButton((b) =>
        b.setButtonText("Connect to Claude Code").setCta().onClick(() => this.plugin.autoRegister(true))
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(() => this.plugin.claudeRemoveRegistration())
      );

    // Manual fallback command.
    containerEl.createEl("h4", { text: "Manual setup (fallback)" });
    containerEl.createEl("p", {
      text: "If auto-register didn't work, run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    containerEl.createEl("pre").createEl("code", { text: cmd });
    containerEl.createEl("p", { cls: "setting-item-description", text: SWITCH_VAULT_NOTE });
    new Setting(containerEl)
      .addButton((b) => b.setButtonText("Copy command").setCta().onClick(() => copyToClipboard(cmd)))
      .addButton((b) => b.setButtonText("Open setup popup").onClick(() => new ConnectionSetupModal(this.app).open()));

    // Security settings.
    containerEl.createEl("h3", { text: "Security" });

    new Setting(containerEl)
      .setName("Read-only mode")
      .setDesc("Block all mutating tools (write, move, delete, patch, etc.). Read and search tools remain available.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnly).onChange(async (value) => {
          this.plugin.settings.readOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Path allowlist")
      .setDesc("Restrict file operations to these vault-relative prefixes (one per line). Leave empty to allow the whole vault.")
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.allowlist.join("\n"));
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.allowlist = value.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Socket enabled")
      .setDesc(
        this.plugin.settings.enabled
          ? "The MCP socket is enabled. Toggle to disable (reload required)."
          : "The MCP socket is disabled. Toggle to re-enable (reload required)."
      )
      .addButton((b) => {
        b.setButtonText(this.plugin.settings.enabled ? "Disable socket" : "Enable socket");
        b.onClick(async () => {
          this.plugin.settings.enabled = !this.plugin.settings.enabled;
          await this.plugin.saveSettings();
          new Notice("vault-mcp: reload the plugin (or restart Obsidian) for this change to take effect.");
          this.display();
        });
      });
  }
}
