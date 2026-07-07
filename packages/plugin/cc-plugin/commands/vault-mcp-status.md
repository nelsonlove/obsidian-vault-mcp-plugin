---
name: vault-mcp-status
description: Report whether the vault-mcp Obsidian bridge is live and which vault it's serving.
---

Check vault-mcp connectivity and report the result to the user:

1. Call the `mcp__vault-mcp__obsidian_doctor` tool.
2. **If it returns**, summarize what it reports — the bound vault, socket path, and
   plugin version — and confirm vault-mcp is live and the `mcp__vault-mcp__*` tools
   are available.
3. **If the call fails or the server is unavailable**, tell the user vault-mcp is
   **down**: the `mcp__vault-mcp__*` tools will fail this session. Fix: open Obsidian
   and enable the "Vault MCP" community plugin (Settings → Community plugins), then
   run `/mcp` and reconnect vault-mcp.
