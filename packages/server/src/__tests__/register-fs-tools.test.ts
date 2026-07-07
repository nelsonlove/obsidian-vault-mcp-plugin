/**
 * Integration tests for registerFsTools + the server's makeBackend adapter.
 *
 * Uses the MCP SDK's InMemoryTransport to spin up a real McpServer with
 * registerFsTools wired to a fake VaultBackend, then drives it through a
 * Client — the same protocol path a real MCP caller would use.
 *
 * Verifies:
 *   1. tools/list returns exactly 17 tools, names match FS_TOOLS.
 *   2. obsidian_read_note includes index_status in its response.
 *   3. obsidian_read_notes includes the `truncated` field per note.
 *   4. obsidian_write_note + obsidian_read_note round-trip.
 *   5. obsidian_force_reindex returns timing fields.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FS_TOOLS,
  registerFsTools,
} from "@vault-mcp/core";
import type {
  VaultBackend,
  NoteRef,
  SearchHit,
  SearchMode,
  ReadNotesResult,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
  FrontmatterEditValue,
  PatchAnchor,
  PatchOp,
} from "@vault-mcp/core";

// ── Fake in-memory VaultBackend ───────────────────────────────────────────────

class FakeVaultBackend implements VaultBackend {
  private notes: Map<string, string> = new Map();
  reindexCalled = 0;
  /**
   * When true, moveNote returns null for both backlink-count fields (simulating
   * the live Obsidian backend that can't cheaply count rewrites). When false
   * (default), returns realistic non-zero counts to exercise the FS path.
   */
  nullCounts = false;

  async listNotes(_subdir?: string, limit = 100, offset = 0): Promise<{ total: number; notes: NoteRef[] }> {
    const all = [...this.notes.keys()].sort();
    const page = all.slice(offset, offset + limit);
    return { total: all.length, notes: page.map((path) => ({ path })) };
  }

  async listFolders(_subdir?: string): Promise<Array<{ path: string; note_count: number }>> {
    return [];
  }

  async readNote(relPath: string): Promise<string> {
    const content = this.notes.get(relPath);
    if (content === undefined) throw new Error(`not found: ${relPath}`);
    return content;
  }

  async readNotes(paths: string[]): Promise<ReadNotesResult> {
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          return { path: p, content: await this.readNote(p) };
        } catch (e) {
          return { path: p, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return { results };
  }

  async searchNotes(_query: string, _limit: number, _mode: SearchMode): Promise<SearchHit[]> {
    return [];
  }

  async findByTag(_tag: string, _limit: number): Promise<NoteRef[]> {
    return [];
  }

  async searchByFrontmatter(_property: string, _value: string): Promise<FrontmatterSearchResult[]> {
    return [];
  }

  async resolve(refs: string[], _from?: string): Promise<ResolveResult[]> {
    return refs.map((ref) => ({ ref }));
  }

  async getBacklinks(_notePath: string): Promise<string[]> {
    return [];
  }

  async getOutlinks(_notePath: string): Promise<OutlinkEntry[]> {
    return [];
  }

  async forceReindex(): Promise<void> {
    this.reindexCalled += 1;
  }

  async manageFrontmatter(
    _relPath: string,
    _key: string,
    op: "get" | "set" | "delete",
    _value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult> {
    if (op === "get") return { value: undefined };
    if (op === "delete") return { existed: false };
    return { previous: undefined, created_frontmatter: false };
  }

  async patchNote(
    _relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    _content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    return { found: false, anchor, op };
  }

  async writeNote(relPath: string, content: string, overwrite: boolean): Promise<{ path: string; created: boolean }> {
    const existed = this.notes.has(relPath);
    if (existed && !overwrite) throw new Error(`already exists: ${relPath}`);
    this.notes.set(relPath, content);
    return { path: relPath, created: !existed };
  }

  async appendNote(relPath: string, content: string): Promise<{ path: string; created: boolean }> {
    const existed = this.notes.has(relPath);
    const current = this.notes.get(relPath) ?? "";
    this.notes.set(relPath, existed ? current + "\n" + content : content);
    return { path: relPath, created: !existed };
  }

  async moveNote(
    fromRel: string,
    toRel: string,
    _options: { update_backlinks: boolean; overwrite: boolean },
  ): Promise<{ from: string; to: string; backlinks_updated: number | null; backlinks_files_touched: number | null }> {
    const content = this.notes.get(fromRel);
    if (content === undefined) throw new Error(`not found: ${fromRel}`);
    this.notes.delete(fromRel);
    this.notes.set(toRel, content);
    // nullCounts=true simulates the live Obsidian backend (can't count rewrites).
    // nullCounts=false (default) simulates the FS backend with real counts.
    return {
      from: fromRel,
      to: toRel,
      backlinks_updated: this.nullCounts ? null : 3,
      backlinks_files_touched: this.nullCounts ? null : 2,
    };
  }

  async deleteNote(relPath: string, _confirm: true): Promise<{ path: string; deleted: true }> {
    this.notes.delete(relPath);
    return { path: relPath, deleted: true };
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

/** Wire up a server + client via InMemoryTransport for a single test. */
async function makeClientServer(
  backend: FakeVaultBackend,
  indexStatusFn?: () => { status: string; count: number; last_built_at?: string; error?: string },
): Promise<{ client: Client; teardown: () => Promise<void> }> {
  const server = new McpServer({ name: "test-server", version: "0.0.1" });

  registerFsTools(server, backend, {
    decodeHtml: false,
    includeIndexStatus: indexStatusFn,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "0.0.1" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerFsTools", () => {
  test("tools/list returns exactly 17 tools", async () => {
    const backend = new FakeVaultBackend();
    const { client, teardown } = await makeClientServer(backend);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 17, `expected 17 tools, got ${tools.length}`);

      const names = tools.map((t) => t.name).sort();
      const expected = FS_TOOLS.map((t) => t.name).sort();
      assert.deepEqual(names, expected, "tool names do not match FS_TOOLS");
    } finally {
      await teardown();
    }
  });

  test("tool input schemas include all required fields from FS_TOOLS", async () => {
    const backend = new FakeVaultBackend();
    const { client, teardown } = await makeClientServer(backend);
    try {
      const { tools } = await client.listTools();
      // Spot-check obsidian_resolve has `refs` (array) not `ref` (single), plus optional `from`
      const resolve = tools.find((t) => t.name === "obsidian_resolve");
      assert.ok(resolve, "obsidian_resolve not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schema = resolve.inputSchema as any;
      assert.ok(schema.properties?.refs, "obsidian_resolve should have `refs` array field");
      assert.equal(schema.properties.refs.type, "array", "refs should be array type");
      assert.ok(!schema.properties?.ref, "obsidian_resolve should NOT have single `ref` field");
      assert.ok(schema.properties?.from !== undefined, "obsidian_resolve should have optional `from` field");
      // `from` should NOT be in required (it's optional)
      const required: string[] = schema.required ?? [];
      assert.ok(!required.includes("from"), "`from` should be optional (not in required array)");

      // Spot-check obsidian_move_note has update_backlinks
      const move = tools.find((t) => t.name === "obsidian_move_note");
      assert.ok(move, "obsidian_move_note not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const moveSchema = move.inputSchema as any;
      assert.ok(moveSchema.properties?.update_backlinks, "obsidian_move_note should have update_backlinks");
    } finally {
      await teardown();
    }
  });

  test("obsidian_read_note includes index_status when includeIndexStatus is set", async () => {
    const backend = new FakeVaultBackend();
    await backend.writeNote("Test/Note.md", "# Hello\nworld", true);

    const fakeStatus = { status: "ready", count: 42 };
    const { client, teardown } = await makeClientServer(backend, () => fakeStatus);
    try {
      const result = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Test/Note.md" } });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);

      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const data = JSON.parse(text);
      assert.ok(data.index_status, "index_status field missing from obsidian_read_note response");
      assert.equal(data.index_status.status, "ready");
      assert.equal(data.index_status.count, 42);
      assert.equal(data.content, "# Hello\nworld");
    } finally {
      await teardown();
    }
  });

  test("obsidian_read_note does NOT include index_status when includeIndexStatus is unset", async () => {
    const backend = new FakeVaultBackend();
    await backend.writeNote("A.md", "content", true);
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({ name: "obsidian_read_note", arguments: { path: "A.md" } });
      assert.ok(!result.isError);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.ok(!("index_status" in data), "index_status should be absent when not configured");
    } finally {
      await teardown();
    }
  });

  test("obsidian_read_notes returns truncated field per note", async () => {
    const backend = new FakeVaultBackend();
    await backend.writeNote("Short.md", "short content", true);
    // Create a note whose content is already marked as truncated by the server
    // (content.length > CHARACTER_LIMIT after readNote's trailer). For this fake
    // backend, just verify the `truncated` key is present in the result.
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({
        name: "obsidian_read_notes",
        arguments: { paths: ["Short.md"] },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.ok(Array.isArray(data.notes), "notes array missing");
      assert.equal(data.notes.length, 1);
      assert.ok("truncated" in data.notes[0], "truncated field missing from note result");
      assert.equal(data.notes[0].truncated, false, "short content should not be truncated");
    } finally {
      await teardown();
    }
  });

  test("obsidian_write_note + obsidian_read_note round-trip", async () => {
    const backend = new FakeVaultBackend();
    const { client, teardown } = await makeClientServer(backend);
    try {
      const writeResult = await client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "Round/Trip.md", content: "# Round Trip\nHello!", overwrite: false },
      });
      assert.ok(!writeResult.isError, `write failed: ${JSON.stringify(writeResult.content)}`);
      const writeData = JSON.parse((writeResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(writeData.path, "Round/Trip.md");
      assert.equal(writeData.created, true);

      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "Round/Trip.md" },
      });
      assert.ok(!readResult.isError, `read failed: ${JSON.stringify(readResult.content)}`);
      const readData = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(readData.content, "# Round Trip\nHello!");
    } finally {
      await teardown();
    }
  });

  test("obsidian_force_reindex returns timing fields and calls backend.forceReindex()", async () => {
    const backend = new FakeVaultBackend();
    let count = 0;
    const statusFn = () => ({ status: "ready", count: ++count });
    const { client, teardown } = await makeClientServer(backend, statusFn);
    try {
      const result = await client.callTool({ name: "obsidian_force_reindex", arguments: {} });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.ok("status" in data, "status field missing");
      assert.ok("prev_count" in data, "prev_count missing");
      assert.ok("count" in data, "count missing");
      assert.ok("duration_ms" in data, "duration_ms missing");
      assert.ok(typeof data.duration_ms === "number", "duration_ms should be a number");
      assert.equal(backend.reindexCalled, 1, "backend.forceReindex() should have been called once");
    } finally {
      await teardown();
    }
  });

  test("obsidian_read_note returns error for missing note", async () => {
    const backend = new FakeVaultBackend();
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({ name: "obsidian_read_note", arguments: { path: "Missing.md" } });
      // The server uses fail() which sets isError: true
      assert.ok(result.isError === true, "expected isError for missing note");
    } finally {
      await teardown();
    }
  });

  test("obsidian_move_note with numeric counts includes them in response (FS backend path)", async () => {
    const backend = new FakeVaultBackend();
    await backend.writeNote("Source.md", "# Source", true);
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({
        name: "obsidian_move_note",
        arguments: { from: "Source.md", to: "Dest.md", update_backlinks: true, overwrite: false },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.from, "Source.md");
      assert.equal(data.to, "Dest.md");
      // FS backend returns real numeric counts — they must appear in the response.
      assert.ok("backlinks_updated" in data, "backlinks_updated should be present for numeric-count backend");
      assert.ok("backlinks_files_touched" in data, "backlinks_files_touched should be present for numeric-count backend");
      assert.equal(data.backlinks_updated, 3);
      assert.equal(data.backlinks_files_touched, 2);
    } finally {
      await teardown();
    }
  });

  test("obsidian_move_note with null counts omits them from response (live Obsidian backend path)", async () => {
    const backend = new FakeVaultBackend();
    backend.nullCounts = true; // simulate live Obsidian backend
    await backend.writeNote("A.md", "# A", true);
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({
        name: "obsidian_move_note",
        arguments: { from: "A.md", to: "B.md", update_backlinks: true, overwrite: false },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.from, "A.md");
      assert.equal(data.to, "B.md");
      // Live backend can't count rewrites — these fields must be ABSENT (not 0).
      assert.ok(!("backlinks_updated" in data), "backlinks_updated must be absent when count is unknown");
      assert.ok(!("backlinks_files_touched" in data), "backlinks_files_touched must be absent when count is unknown");
    } finally {
      await teardown();
    }
  });

  test("obsidian_force_reindex without includeIndexStatus returns live-cache shape", async () => {
    // Simulates the live Obsidian plugin path (no persistent index, includeIndexStatus omitted).
    const backend = new FakeVaultBackend();
    const { client, teardown } = await makeClientServer(backend); // no statusFn
    try {
      const result = await client.callTool({ name: "obsidian_force_reindex", arguments: {} });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.status, "live", "status should be 'live' for the live-cache path");
      assert.ok("duration_ms" in data, "duration_ms should be present");
      assert.ok(typeof data.duration_ms === "number", "duration_ms should be a number");
      // Misleading count fields must be absent on the live path.
      assert.ok(!("prev_count" in data), "prev_count must be absent on live-cache path");
      assert.ok(!("count" in data), "count must be absent on live-cache path");
    } finally {
      await teardown();
    }
  });

  test("obsidian_manage_frontmatter op=set requires value", async () => {
    const backend = new FakeVaultBackend();
    await backend.writeNote("Fm.md", "---\ntitle: test\n---\n", true);
    const { client, teardown } = await makeClientServer(backend);
    try {
      const result = await client.callTool({
        name: "obsidian_manage_frontmatter",
        arguments: { path: "Fm.md", key: "title", op: "set" },
      });
      // value is undefined → should return an error
      assert.ok(result.isError === true, "expected isError when value missing for op=set");
    } finally {
      await teardown();
    }
  });
});
