import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import { findClaudeBinary, claudeIsRegistered } from "./claude-cli.js";

export function registerCommandFor(_app: App): string {
  return buildRegisterCommand({ bridgePath: bridgeDestPath() });
}

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
    new Setting(containerEl)
      .addButton((b) => b.setButtonText("Copy command").setCta().onClick(() => copyToClipboard(cmd)))
      .addButton((b) => b.setButtonText("Open setup popup").onClick(() => new ConnectionSetupModal(this.app).open()));
  }
}
