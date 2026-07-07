# vault-mcp

An Obsidian plugin that embeds a **Model Context Protocol (MCP) server** inside the running app, giving Claude Code direct, canonical access to a live vault through Obsidian's own APIs — backlinks, link resolution, Dataview queries with native types, Templater rendering, Metadata Menu fileClass schemas, workspace/bookmark control, and more.

It is the **local-with-Obsidian** counterpart to [`obsidian-vault-mcp-server`](https://github.com/nelsonlove/obsidian-vault-mcp-server) (a remote, filesystem-only MCP server). Same `obsidian_*` tool names; this one runs inside Obsidian so its returns are canonical (live metadata cache, real plugin APIs) instead of parsed from disk.

> **Desktop only.** Uses Node `net`/`fs` from Obsidian's renderer; `isDesktopOnly: true`.

## How it works

```
┌─ Obsidian (renderer) ─────────┐        ┌─ Claude Code session ──────┐
│  vault-mcp plugin             │        │  MCP client (stdio)        │
│   ├─ MCP server (app.* direct)│        │       │                    │
│   └─ Unix socket  ◄───────────┼────────┼─ bridge.mjs (spawned)      │
│      ~/.claude/vault-mcp/     │  socket│   reads discovery, proxies │
│      <vault>.sock (chmod 600) │        │   stdio ↔ socket           │
└───────────────────────────────┘        └────────────────────────────┘
```

- The plugin runs an MCP server in Obsidian's renderer and listens on a per-vault **Unix socket** (`~/.claude/vault-mcp/<vault-slug>.sock`, `chmod 600` — the only auth boundary).
- A tiny bundled **`bridge.mjs`** (written to `~/.claude/vault-mcp/` on load) is what Claude Code spawns; it proxies stdio ↔ the socket.
- A fresh MCP server is built **per connection**, so multiple Claude Code sessions and background agents share the plugin without evicting each other.

## Install

1. **Build** (or download a release):
   ```bash
   npm install && npm run build      # emits main.js (bridge embedded) + manifest.json
   ```
2. **Copy into your vault** and enable it:
   ```bash
   cp main.js manifest.json <vault>/.obsidian/plugins/vault-mcp/
   ```
   Then Settings → Community plugins → enable **Vault MCP**.
3. **Connect Claude Code** — run the command **`vault-mcp: Connect to Claude Code`** from the command palette. It runs `claude mcp add --scope user vault-mcp -- node ~/.claude/vault-mcp/bridge.mjs --vault <this vault>` for you (one-time, persists across sessions). The `--vault` pin keeps the registration unambiguous once a second vault also serves MCP — without it the bridge aborts with `multiple vaults open; specify --vault`. If the `claude` CLI can't be found, it shows the exact line to paste; the same line is always available in **Settings → Vault MCP → Claude Code connection**. To point Claude Code at a different vault later, run Connect from that vault (or edit the `--vault <name>` value in the config).
4. **Restart any open Claude Code session** — MCP servers load at session start.

On the Mac, **disconnect the remote `obsidian-vault-mcp-server` connector** for that session so you don't have two Obsidian tool sets at once. They share `obsidian_*` names by design; this local one gives canonical returns.

## Tools

**43 tools.** 37 are always available; 6 are **plugin-gated** (register only when their backing plugin is loaded):

- **Core (read/write, live `app.*`):** list/read/write/append/move/delete notes, backlinks, outlinks, resolve, frontmatter (atomic multi-key), patch, search, find-by-tag, …
- **Complementary:** trash, parsed read, append-at-heading, run-command, command list, vault/tags/environment info, active note, open-in-editor.
- **Navigation/control:** jump-to, view-mode, workspaces (open/save/list), bookmarks (open/list), periodic note, plugin toggle.
- **Plugin-gated:** `dataview_list_query`, `dataview_table_query` (Dataview); `create_note_from_template` (Templater); `omnisearch` (Omnisearch); `fileclass_schema`, `fileclass_insert_fields` (Metadata Menu).

Run **`obsidian_doctor`** (tool) or **`vault-mcp: Show diagnostics`** (command) to see which integrations the plugin currently detects.

## Settings (Settings → Vault MCP)

- **Claude Code connection** — status + the `claude mcp add` line + copy button.
- **Read-only mode** — blocks all mutating tools (write/delete/move/trash/frontmatter-set/…). Reads still work. Useful when you don't want Claude touching the vault this session.
- **Path allowlist** — one vault-relative prefix per line (empty = whole vault). File operations outside every prefix are refused (`..` traversal is normalized and blocked). Useful to sandbox Claude to one area.
- **Disable socket** — stops the server without uninstalling the plugin (takes effect on plugin reload).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Claude Code says the MCP is unreachable | Obsidian isn't running, or the plugin is disabled. Open Obsidian / enable the plugin. |
| "auto register failed, no such file or directory" | The `claude` launcher needs `node` on PATH; the plugin augments PATH with `/opt/homebrew/bin` + `/usr/local/bin`. If your `node`/`claude` live elsewhere, run the `claude mcp add` line manually in a terminal where `claude` works. |
| Tools don't appear in a session | You registered after the session started — restart the Claude Code session (MCP loads at start). |
| Multiple vaults open | The registration must pin `--vault <name>` (Connect does this for the vault you run it from); `obsidian_doctor` reports the bound vault. A registration made before a second vault existed may be generic — re-run Connect, or add `--vault <name>` to the existing `claude mcp` entry. |
| A plugin-gated tool is missing | Its backing plugin isn't loaded. Enable it; the tool appears on the next session connect. |

## Publishing tools from other plugins

Other Obsidian plugins can publish their own MCP tools through vault-mcp's bridge. Add the SDK:

    npm install github:nelsonlove/vault-mcp-api#v1.0.0

then in your plugin's `onload()`:

    import { publishTools } from "vault-mcp-api";
    import { z } from "zod";

    this.register(
      publishTools(this, [{
        name: "my_tool",                      // published as <your-plugin-id>_my_tool
        description: "What it does.",
        inputSchema: { arg: z.string().describe("…") },
        readOnly: false,                      // omit or false ⇒ blocked in read-only mode
        handler: async ({ arg }) => ({ result: "plain JSON out" }),
      }])
    );

The SDK handles load order (registers now or on the `vault-mcp:ready` event), re-registration when vault-mcp reloads, and cleanup. Tools appear to new Claude Code sessions on their next connect; they are guarded by vault-mcp's read-only mode and path allowlist like built-ins.

## Repo

`~/repos/obsidian-vault-mcp-plugin`. See `CLAUDE.md` for the locked architecture decisions.
