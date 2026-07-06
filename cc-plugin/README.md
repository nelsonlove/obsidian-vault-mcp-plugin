# vault-mcp-connect

A small Claude Code plugin that makes the [vault-mcp](https://github.com/nelsonlove/obsidian-vault-mcp-plugin)
Obsidian bridge more transparent about its connection state.

The `vault-mcp` MCP server lives inside Obsidian and is reachable only while
Obsidian is running with the **Vault MCP** community plugin enabled. When it
isn't, every `mcp__vault-mcp__*` tool call fails — and because the stdio bridge
can't reconnect mid-session, the failure is easy to misread. This plugin
surfaces that state.

> This plugin does **not** register the MCP server — the Obsidian plugin already
> does that at load time. It only adds connectivity tooling on top, so there's no
> duplicate-server conflict.

## What it does

- **`SessionStart` hook** — probes the vault socket when a session begins. Silent
  when a vault is live; injects a one-line heads-up (with the fix) only when the
  socket is down, so the agent knows the tools will fail and can advise you.
- **`/vault-mcp-status`** — on-demand check of the same probe: reports whether a
  vault socket is live and which vault it's serving.

Both share `hooks/scripts/vault-mcp-health.mjs` (Node only — no extra deps).

## Install

```
/plugin marketplace add nelsonlove/obsidian-vault-mcp-plugin
/plugin install vault-mcp-connect@vault-mcp
```

## Configuration

The probe reads vault discovery from `~/.claude/vault-mcp/*.json` and connects to
each `socket_path`. No configuration required.
