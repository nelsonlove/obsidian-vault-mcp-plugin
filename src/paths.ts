import * as os from "node:os";
import * as path from "node:path";

export function vaultSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function stateDir(): string {
  return path.join(os.homedir(), ".claude", "vault-mcp");
}

export function socketPath(slug: string): string {
  return path.join(stateDir(), `${slug}.sock`);
}

export function discoveryPath(slug: string): string {
  return path.join(stateDir(), `${slug}.json`);
}

export function bridgeDestPath(): string {
  return path.join(stateDir(), "bridge.mjs");
}
