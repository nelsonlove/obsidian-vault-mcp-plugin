/**
 * ObsidianBackend — implements VaultBackend using Obsidian's live app.* APIs.
 *
 * Each of the 17 fs-expressible methods calls the same Obsidian API that the
 * previous inline tool handlers called. Behavior is unchanged; this is a
 * pure structural move so the shared registerFsTools registrar can drive them.
 */

import { TFile, TFolder, getAllTags, type App } from "obsidian";
import type {
  VaultBackend,
  NoteRef,
  SearchHit,
  SearchMode,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  FrontmatterEditValue,
  ManageFrontmatterResult,
  PatchAnchor,
  PatchOp,
} from "@vault-mcp/core";

// ── Shared constants / helpers ────────────────────────────────────────────────

/** Matches the per-note character limit used by the shared registry handler. */
const CHARACTER_LIMIT = 100_000;

function countMarkdownRecursive(folder: TFolder): number {
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += countMarkdownRecursive(child);
    else if (child instanceof TFile && child.extension === "md") n += 1;
  }
  return n;
}

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* exists / race */ }
    }
  }
}

// ── ObsidianBackend ───────────────────────────────────────────────────────────

export class ObsidianBackend implements VaultBackend {
  constructor(private readonly app: App) {}

  // ── listing & navigation ────────────────────────────────────────────────────

  async listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ total: number; notes: NoteRef[] }> {
    const prefix = subdir ? subdir.replace(/\/$/, "") + "/" : "";
    const all = this.app.vault
      .getMarkdownFiles()
      .filter((f) => (prefix ? f.path.startsWith(prefix) : true))
      .map((f) => f.path)
      .sort();
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    return { total, notes: page.map((path) => ({ path })) };
  }

  async listFolders(
    subdir: string | undefined,
  ): Promise<Array<{ path: string; note_count: number }>> {
    const base = subdir
      ? this.app.vault.getAbstractFileByPath(subdir.replace(/\/$/, ""))
      : this.app.vault.getRoot();
    if (!(base instanceof TFolder)) throw new Error(`not a folder: ${subdir}`);
    return base.children
      .filter((c): c is TFolder => c instanceof TFolder)
      .map((f) => ({ path: f.path, note_count: countMarkdownRecursive(f) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  // ── note reading ────────────────────────────────────────────────────────────

  async readNote(relPath: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(relPath);
    if (!(f instanceof TFile)) throw new Error(`not found: ${relPath}`);
    // No truncation: the live cache is authoritative and callers of readNote
    // may need the full content. The `truncated` flag in obsidian_read_notes
    // fires when content.length > CHARACTER_LIMIT even without truncation
    // (matching the original plugin's behavior).
    return this.app.vault.read(f);
  }

  async readNotes(paths: string[]): Promise<{ results: Array<{ path: string; content: string } | { path: string; error: string }> }> {
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const content = await this.readNote(p);
          return { path: p, content };
        } catch (e) {
          return { path: p, error: e instanceof Error ? e.message : String(e) };
        }
      })
    );
    return { results };
  }

  // ── search ──────────────────────────────────────────────────────────────────

  async searchNotes(query: string, limit: number, mode: SearchMode): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    outer: for (const f of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(f);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: f.path, line: i + 1, snippet: lines[i].trim().slice(0, 300) });
          if (hits.length >= limit) break outer;
          if (mode === "one_per_note") continue outer;
        }
      }
    }
    return hits;
  }

  async findByTag(tag: string, limit: number): Promise<NoteRef[]> {
    const want = tag.replace(/^#/, "").toLowerCase();
    const notes: NoteRef[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache) continue;
      const tags = (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
      if (tags.includes(want)) {
        notes.push({ path: f.path });
        if (notes.length >= limit) break;
      }
    }
    return notes;
  }

  async searchByFrontmatter(property: string, value: string): Promise<FrontmatterSearchResult[]> {
    const wantKey = property.toLowerCase();
    const results: FrontmatterSearchResult[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      const key = Object.keys(fm).find((k) => k.toLowerCase() === wantKey);
      if (!key) continue;
      const fv = fm[key];
      const hit = Array.isArray(fv)
        ? fv.some((v) => String(v) === value)
        : String(fv) === value;
      if (hit) results.push({ path: f.path, frontmatter: fm });
    }
    // Intentionally uncapped: registerFsTools applies the limit.
    return results;
  }

  // ── link resolution ─────────────────────────────────────────────────────────

  async resolve(refs: string[]): Promise<ResolveResult[]> {
    // Single-ref Obsidian resolver iterated over each ref. The `from` parameter
    // is accepted by the FS_TOOLS schema but not forwarded to this method by
    // registerFsTools (graceful degradation documented in register-fs-tools.ts).
    return refs.map((ref): ResolveResult => {
      const stripped = ref.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
      const fragmentIdx = stripped.indexOf("#");
      const clean = fragmentIdx >= 0 ? stripped.slice(0, fragmentIdx) : stripped;
      const fragment = fragmentIdx >= 0 ? stripped.slice(fragmentIdx + 1) : undefined;
      const dest = this.app.metadataCache.getFirstLinkpathDest(clean, "");
      return dest
        ? { ref, path: dest.path, ...(fragment ? { fragment } : {}) }
        : { ref, ...(fragment ? { fragment } : {}) };
    });
  }

  async getBacklinks(notePath: string): Promise<string[]> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file) throw new Error(`not found: ${notePath}`);
    // getBacklinksForFile is not in the public obsidian types — cast required.
    const bl = (this.app.metadataCache as any).getBacklinksForFile(file);
    return bl?.data ? Array.from<string>(bl.data.keys()) : [];
  }

  async getOutlinks(notePath: string): Promise<OutlinkEntry[]> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${notePath}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    return refs.map((r): OutlinkEntry => {
      const linkpath = r.link.split("#")[0];
      const dest = linkpath
        ? this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath)
        : null;
      return { ref: r.link, resolved_path: dest ? dest.path : undefined };
    });
  }

  // ── index management ────────────────────────────────────────────────────────

  async forceReindex(): Promise<void> {
    // No-op: Obsidian's metadata cache is always live; there is no index to rebuild.
  }

  // ── frontmatter ─────────────────────────────────────────────────────────────

  async manageFrontmatter(
    relPath: string,
    key: string,
    op: "get" | "set" | "delete",
    value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);

    if (op === "get") {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return { value: fm ? fm[key] : undefined };
    }

    if (op === "set") {
      if (value === undefined) throw new Error("`value` is required for op='set'");
      const hadFm = !!this.app.metadataCache.getFileCache(file)?.frontmatter;
      let previous: FrontmatterEditValue | undefined;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        previous = fm[key];
        fm[key] = value;
      });
      return { previous, created_frontmatter: !hadFm };
    }

    // op === "delete"
    let existed = false;
    let previous: FrontmatterEditValue | undefined;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      existed = Object.prototype.hasOwnProperty.call(fm, key);
      previous = fm[key];
      delete fm[key];
    });
    return { previous, existed };
  }

  // ── patching ─────────────────────────────────────────────────────────────────

  async patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const text = await this.app.vault.read(file);

    let start: number;
    let end: number;

    if (anchor.type === "heading") {
      const headings = cache?.headings ?? [];
      const idx = headings.findIndex((h) => h.heading === anchor.value);
      if (idx < 0) return { found: false, anchor, op };
      const h = headings[idx];
      start = h.position.end.offset; // just after the heading line
      end = text.length;
      for (let j = idx + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) { end = headings[j].position.start.offset; break; }
      }
    } else {
      const block = cache?.blocks?.[anchor.value];
      if (!block) return { found: false, anchor, op };
      start = block.position.start.offset;
      end = block.position.end.offset;
    }

    const previous = text.slice(start, end);
    let next: string;
    if (op === "replace") {
      const body = anchor.type === "heading" ? `\n\n${content}\n` : content;
      next = text.slice(0, start) + body + text.slice(end);
    } else if (op === "prepend") {
      const ins = anchor.type === "heading" ? `\n\n${content}` : `${content}\n`;
      next = text.slice(0, start) + ins + text.slice(start);
    } else {
      // append: preserve any blank line before a following heading
      const head = text.slice(0, end).replace(/\n*$/, "\n");
      const tail = text.slice(end);
      const sep = tail.length === 0 || tail.startsWith("\n") ? "\n" : "\n\n";
      next = head + content + sep + tail;
    }

    await this.app.vault.modify(file, next);
    return { found: true, anchor, op, previous };
  }

  // ── full note ops ────────────────────────────────────────────────────────────

  async writeNote(
    relPath: string,
    content: string,
    overwrite: boolean,
  ): Promise<{ path: string; created: boolean }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const existing = this.app.vault.getAbstractFileByPath(relPath);
    if (existing instanceof TFile) {
      if (!overwrite) throw new Error(`exists (set overwrite=true to replace): ${relPath}`);
      await this.app.vault.modify(existing, content);
      return { path: relPath, created: false };
    }
    await ensureParentFolders(this.app, relPath);
    await this.app.vault.create(relPath, content);
    return { path: relPath, created: true };
  }

  async appendNote(
    relPath: string,
    content: string,
  ): Promise<{ path: string; created: boolean }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const existing = this.app.vault.getAbstractFileByPath(relPath);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, content);
      return { path: relPath, created: false };
    }
    await ensureParentFolders(this.app, relPath);
    await this.app.vault.create(relPath, content);
    return { path: relPath, created: true };
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
    if (!fromRel.endsWith(".md")) throw new Error("source must end in .md");
    if (!toRel.endsWith(".md")) throw new Error("destination must end in .md");
    if (fromRel === toRel) throw new Error("from and to are the same path");

    const file = this.app.vault.getAbstractFileByPath(fromRel);
    if (!(file instanceof TFile)) throw new Error(`not found: ${fromRel}`);

    const dest = this.app.vault.getAbstractFileByPath(toRel);
    let trashedDest = false;
    if (dest) {
      if (!options.overwrite) throw new Error(`destination exists (set overwrite=true): ${toRel}`);
      // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
      if (dest instanceof TFile) {
        await this.app.vault.trash(dest, true);
        trashedDest = true;
      }
    }

    await ensureParentFolders(this.app, toRel);
    try {
      // renameFile always rewrites backlinks regardless of update_backlinks.
      // When update_backlinks=false we still call renameFile (Obsidian has no
      // rename-without-backlink-rewrite API), so the param is best-effort.
      await this.app.fileManager.renameFile(file, toRel);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (trashedDest) {
        throw new Error(
          `${msg} (the note previously at '${toRel}' was already moved to the system trash and is recoverable there)`,
        );
      }
      throw e;
    }

    // We cannot cheaply count the backlinks that Obsidian rewrote, so we
    // return 0 as a best-effort value. Callers that need the exact count
    // should query obsidian_get_backlinks before and after the move.
    return { from: fromRel, to: toRel, backlinks_updated: 0, backlinks_files_touched: 0 };
  }

  async deleteNote(relPath: string, confirm: true): Promise<{ path: string; deleted: true }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);
    await this.app.vault.delete(file);
    return { path: relPath, deleted: true };
  }
}

// Re-export CHARACTER_LIMIT for registerFsTools' truncation check.
export { CHARACTER_LIMIT };
