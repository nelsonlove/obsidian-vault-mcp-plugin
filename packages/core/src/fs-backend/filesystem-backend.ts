import { createVaultAt } from "./vault.js";
import { IndexStore } from "./index-store.js";
import type {
  VaultBackend,
  NoteRef,
  SearchHit,
  SearchMode,
  ReadNotesResult,
  PatchAnchor,
  PatchOp,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
  FrontmatterEditValue,
} from "../vault-backend.js";

/**
 * `FilesystemBackend` implements the `VaultBackend` interface over a plain
 * filesystem vault directory. It owns both the on-disk vault access
 * (via VaultImpl) and the in-memory index (via IndexStore), wiring them
 * together for operations like `moveNote` that need both.
 *
 * Per-instance: each FilesystemBackend holds its own VaultImpl + IndexStore,
 * so multiple instances in the same process can operate on different vault
 * roots without interfering. The module-level singletons in vault.ts and
 * index-store.ts (used by the server's legacy function-call API) are separate.
 *
 * Note: the index starts empty (status: "indexing"). Call `forceReindex()`
 * to populate it before using index-dependent operations (resolve, backlinks,
 * outlinks, searchByFrontmatter). The vault watcher (vault-watcher.ts) is NOT
 * auto-started here — it's infrastructure that the server layer manages.
 */
export class FilesystemBackend implements VaultBackend {
  private readonly vault: ReturnType<typeof createVaultAt>;
  private readonly index: IndexStore;
  private readonly vaultRootPath: string;

  constructor(vaultRoot: string) {
    this.vaultRootPath = vaultRoot;
    this.vault = createVaultAt(vaultRoot);
    this.index = new IndexStore(vaultRoot);
  }

  // ── Read: listing & navigation ─────────────────────────────────────────────

  async listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ total: number; notes: NoteRef[] }> {
    return this.vault.listNotes(subdir, limit, offset);
  }

  async listFolders(
    subdir: string | undefined,
  ): Promise<Array<{ path: string; note_count: number }>> {
    return this.vault.listFolders(subdir);
  }

  // ── Read: note reading ─────────────────────────────────────────────────────

  async readNote(relPath: string): Promise<string> {
    return this.vault.readNote(relPath);
  }

  async readNotes(paths: string[]): Promise<ReadNotesResult> {
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const content = await this.vault.readNote(p);
          return { path: p, content } as const;
        } catch (e) {
          return { path: p, error: e instanceof Error ? e.message : String(e) } as const;
        }
      })
    );
    return { results };
  }

  // ── Read: search ───────────────────────────────────────────────────────────

  async searchNotes(query: string, limit: number, mode: SearchMode): Promise<SearchHit[]> {
    return this.vault.searchNotes(query, limit, mode);
  }

  async findByTag(tag: string, limit: number): Promise<NoteRef[]> {
    return this.vault.findByTag(tag, limit);
  }

  async searchByFrontmatter(property: string, value: string): Promise<FrontmatterSearchResult[]> {
    const matches = this.index.searchByFrontmatter(property, value);
    return matches.map((n) => ({ path: n.path, frontmatter: n.frontmatter }));
  }

  // ── Read: link resolution ──────────────────────────────────────────────────

  async resolve(refs: string[]): Promise<ResolveResult[]> {
    return this.index.resolveRefs(refs);
  }

  async getBacklinks(notePath: string): Promise<string[]> {
    return this.index.getBacklinks(notePath);
  }

  async getOutlinks(notePath: string): Promise<OutlinkEntry[]> {
    return this.index.getOutlinks(notePath);
  }

  // ── Read: index management ─────────────────────────────────────────────────

  async forceReindex(): Promise<void> {
    await this.index.buildIndex();
  }

  // ── Write: frontmatter ─────────────────────────────────────────────────────

  async manageFrontmatter(
    relPath: string,
    key: string,
    op: "get" | "set" | "delete",
    value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult> {
    if (op === "get") {
      const v = await this.vault.getFrontmatterField(relPath, key);
      return { value: v };
    }
    if (op === "delete") {
      return this.vault.deleteFrontmatterField(relPath, key);
    }
    // op === "set"
    if (value === undefined) {
      throw new Error("`value` is required for op='set'");
    }
    return this.vault.setFrontmatterField(relPath, key, value);
  }

  // ── Write: patching ────────────────────────────────────────────────────────

  async patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    return this.vault.patchNote(relPath, anchor, op, content);
  }

  // ── Write: full note ops ───────────────────────────────────────────────────

  async writeNote(
    relPath: string,
    content: string,
    overwrite: boolean,
  ): Promise<{ path: string; created: boolean }> {
    return this.vault.writeNote(relPath, content, overwrite);
  }

  async appendNote(
    relPath: string,
    content: string,
  ): Promise<{ path: string; created: boolean }> {
    return this.vault.appendNote(relPath, content);
  }

  async moveNote(
    fromRel: string,
    toRel: string,
    options: { update_backlinks: boolean; overwrite: boolean },
  ): Promise<{
    from: string;
    to: string;
    backlinks_updated: number;
    backlinks_files_touched: number;
  }> {
    return this.vault.moveNote(fromRel, toRel, {
      update_backlinks: options.update_backlinks,
      overwrite: options.overwrite,
      backlinks_provider: (p) => this.index.getBacklinks(p),
      resolve_ref: (ref) => this.index.resolveRefs([ref])[0]?.path,
    });
  }

  async deleteNote(relPath: string, confirm: true): Promise<{ path: string; deleted: true }> {
    return this.vault.deleteNote(relPath, confirm);
  }
}
