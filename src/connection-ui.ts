import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";

export function registerCommandFor(app: App): string {
  return buildRegisterCommand({ bridgePath: bridgeDestPath(), vaultName: app.vault.getName() });
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice("Copied. Paste it in a terminal, then restart any open Claude Code session.");
}

export class ConnectionSetupModal extends Modal {
  constructor(app: App, private onAck?: () => void) { super(app); }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Connect vault-mcp to Claude Code");
    contentEl.createEl("p", {
      text: "One-time setup. This plugin runs an MCP server for the vault. To let Claude Code use it, register the bridge with Claude Code once — it then works in every future session.",
    });
    const cmd = registerCommandFor(this.app);
    contentEl.createEl("pre").createEl("code", { text: cmd });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const copyBtn = btns.createEl("button", { text: "Copy command", cls: "mod-cta" });
    copyBtn.onclick = () => copyToClipboard(cmd);
    const ackBtn = btns.createEl("button", { text: "I've run it — don't show again" });
    ackBtn.onclick = () => { this.onAck?.(); this.close(); };
    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Paste in a terminal where the `claude` CLI is available. Restart any running Claude Code session afterward.",
    });
  }
  onClose() { this.contentEl.empty(); }
}

export class VaultMcpSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: VaultMcpPlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Claude Code connection" });
    containerEl.createEl("p", {
      text: "Run this once in a terminal to let Claude Code use this vault's MCP server (persists across sessions):",
    });
    const cmd = registerCommandFor(this.app);
    containerEl.createEl("pre").createEl("code", { text: cmd });
    new Setting(containerEl)
      .addButton((b) => b.setButtonText("Copy command").setCta().onClick(() => copyToClipboard(cmd)))
      .addButton((b) => b.setButtonText("Open setup popup").onClick(() => new ConnectionSetupModal(this.app).open()));
  }
}
