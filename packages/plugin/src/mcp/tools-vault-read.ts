// All 9 tools previously in this file are now registered via registerFsTools
// + ObsidianBackend in server.ts (the 17 fs-expressible tools). This module
// is retained as an empty export so existing imports (if any) continue to
// compile, but registerVaultReadTools is a no-op and server.ts no longer
// calls it.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerVaultReadTools(_server: McpServer, _app: App): void {
  // All 9 fs-expressible read tools migrated to registerFsTools in server.ts.
}
