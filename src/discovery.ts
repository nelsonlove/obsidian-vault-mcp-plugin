import * as fs from "node:fs";
import { stateDir, discoveryPath, bridgeDestPath } from "./paths.js";
import { BRIDGE_SOURCE } from "./bridge-asset.js";

export interface Discovery {
  socket_path: string;
  vault_path: string;
  vault_name: string;
  plugin_version: string;
  obsidian_version: string;
  started_at: string;
}

export function writeDiscovery(slug: string, d: Discovery): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(discoveryPath(slug), JSON.stringify(d, null, 2), { mode: 0o600 });
}

export function removeDiscovery(slug: string): void {
  try { fs.unlinkSync(discoveryPath(slug)); } catch { /* gone */ }
}

// Writes the build-time-embedded bridge text to ~/.claude/vault-mcp/bridge.mjs.
export function writeBridge(): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(bridgeDestPath(), BRIDGE_SOURCE, { mode: 0o755 });
}
