# vault-mcp Plugin — Authoritative Tool Inventory

Source of record for every tool the plugin's MCP server registers.  Generated
by reading `packages/plugin/src/mcp/server.ts` and all `tools-*.ts` files.
The fs-expressible list is locked by `tests/tool-inventory.test.mjs` (#25).

**Count summary:** 17 fs-expressible + 22 always-live = **39 base** tools,
plus up to 6 conditional integration tools = **up to 45 total**.

Cross-check: the observed live set with Dataview + Templater + Metadata Menu
loaded (but NOT Omnisearch) reports 44 tools: 39 + 5 = 44. ✓

---

## Section 1 — fs-expressible (17)

Defined in `@vault-mcp/core`'s `FS_TOOLS` (`packages/core/src/tool-registry.ts`).
Registered in the plugin via `registerFsTools(server, new ObsidianBackend(app))`
in `server.ts`.  The server package registers the same 17 via `registerFsTools`
against its `FilesystemBackend`.

| Tool name | Capability |
|---|---|
| `obsidian_append_note` | fs-expressible |
| `obsidian_delete_note` | fs-expressible |
| `obsidian_find_by_tag` | fs-expressible |
| `obsidian_force_reindex` | fs-expressible |
| `obsidian_get_backlinks` | fs-expressible |
| `obsidian_get_outlinks` | fs-expressible |
| `obsidian_list_folders` | fs-expressible |
| `obsidian_list_notes` | fs-expressible |
| `obsidian_manage_frontmatter` | fs-expressible |
| `obsidian_move_note` | fs-expressible |
| `obsidian_patch_note` | fs-expressible |
| `obsidian_read_note` | fs-expressible |
| `obsidian_read_notes` | fs-expressible |
| `obsidian_resolve` | fs-expressible |
| `obsidian_search_by_frontmatter` | fs-expressible |
| `obsidian_search_notes` | fs-expressible |
| `obsidian_write_note` | fs-expressible |

---

## Section 2 — live-only, always registered (21)

These tools depend on live Obsidian `app.*` state and cannot be expressed on the
filesystem.  They are unconditionally registered on every `buildMcpServer` call,
regardless of which community plugins are installed.

### `tools-core.ts` — `registerCoreTools` (2 tools)

| Tool name | Description |
|---|---|
| `obsidian_doctor` | Vault-mcp health, socket path, integration detection |
| `obsidian_get_active_note` | Currently focused note + editor selection |

### `tools-vault-write.ts` — `registerVaultWriteTools` (2 tools)

| Tool name | Description |
|---|---|
| `obsidian_move_notes` | Batch move/rename (live-only — not in the shared 17) |
| `obsidian_repoint_link` | Repoint every `[[link_name]]` at `target_path`, vault-wide (live-only; fixes broken links that rename-based rewrite can't touch) |

### `tools-complementary.ts` — `registerComplementaryTools` (9 tools)

| Tool name | Description |
|---|---|
| `obsidian_append_at_heading` | Insert content under a heading, create if missing |
| `obsidian_environment_info` | Obsidian version, platform, enabled plugins |
| `obsidian_get_command_ids` | List all registered Obsidian command IDs |
| `obsidian_open_in_editor` | Open a note in Obsidian's editor |
| `obsidian_read_note_parsed` | Structured metadata from Obsidian's live cache |
| `obsidian_run_command` | Execute an Obsidian command by ID |
| `obsidian_tags_list` | All tags with usage counts (live metadata cache) |
| `obsidian_trash` | Move a note to the system trash (recoverable) |
| `obsidian_vault_info` | Vault name, base path, config dir, attachment folder |

### `tools-nav.ts` — `registerNavTools` (9 tools)

| Tool name | Description |
|---|---|
| `obsidian_jump_to` | Open a note and scroll to heading/block/line |
| `obsidian_list_bookmarks` | All bookmarks (requires core Bookmarks plugin) |
| `obsidian_list_workspaces` | All saved workspace names (requires Workspaces plugin) |
| `obsidian_open_bookmark` | Open a bookmark by title |
| `obsidian_open_workspace` | Load a named workspace layout |
| `obsidian_periodic_note` | Open/create daily-weekly-monthly note |
| `obsidian_plugin_toggle` | Enable or disable a community plugin |
| `obsidian_save_workspace` | Save the current layout as a named workspace |
| `obsidian_toggle_view_mode` | Switch active leaf: source / preview / live-preview |

---

## Section 3 — live-only, conditional (up to 6)

Registered only when the gating community plugin's instance is actually loaded
(`app.plugins.plugins[id]` is truthy — NOT just in `enabledPlugins`, which can
list stale/uninstalled entries).  New tools appear on session reconnect.

| Tool name | Gating plugin | Plugin ID |
|---|---|---|
| `obsidian_dataview_list_query` | Dataview | `dataview` |
| `obsidian_dataview_table_query` | Dataview | `dataview` |
| `obsidian_create_note_from_template` | Templater | `templater-obsidian` |
| `obsidian_omnisearch` | Omnisearch | `omnisearch` |
| `obsidian_fileclass_schema` | Metadata Menu | `metadata-menu` |
| `obsidian_fileclass_insert_fields` | Metadata Menu | `metadata-menu` |

---

## Observed live set cross-check

The 43-tool set observed with Dataview + Templater + Metadata Menu loaded
(Omnisearch absent) maps exactly to the inventory above:

- 17 fs-expressible ✓
- 21 always-live ✓
- 5 integration (Dataview×2 + Templater×1 + Metadata Menu×2) ✓
- `obsidian_omnisearch` absent — Omnisearch plugin not loaded ✓

**No tool in the observed-43 list is unaccounted for in source.**

---

## Source file map

| File | Registration function | Tools registered |
|---|---|---|
| `packages/core/src/tool-registry.ts` | — (FS_TOOLS definition) | 17 fs-expressible |
| `packages/plugin/src/mcp/server.ts` | `registerFsTools` | 17 fs-expressible |
| `packages/plugin/src/mcp/tools-core.ts` | `registerCoreTools` | 2 always-live |
| `packages/plugin/src/mcp/tools-vault-write.ts` | `registerVaultWriteTools` | 1 always-live |
| `packages/plugin/src/mcp/tools-complementary.ts` | `registerComplementaryTools` | 9 always-live |
| `packages/plugin/src/mcp/tools-nav.ts` | `registerNavTools` | 9 always-live |
| `packages/plugin/src/mcp/tools-integrations.ts` | `registerIntegrationTools` | up to 6 conditional |
| `packages/plugin/src/mcp/tools-vault-read.ts` | `registerVaultReadTools` (no-op stub) | 0 (all 9 migrated) |
