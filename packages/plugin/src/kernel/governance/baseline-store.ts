// Per-note baseline blob store: note path → the last-ACCEPTED full content.
// This is the "base branch" of the PR analogy (see Assent ch.5). Accept advances it;
// human-attributed edits advance it silently; nothing else touches it.
//
// Layout: <baseDir>/<hash(path)>.json, one file per note, each holding the full blob.
// Hashing the path keeps filenames filesystem-safe (note paths contain "/", spaces, etc.)
// while the record carries the real path back. A tiny index.json lists path↔file so we
// never have to trust filename decoding.
//
// The store is storage-agnostic: it talks to an injected BlobFs so it unit-tests against
// node fs in a temp dir and runs against Obsidian's vault adapter in production.
//
// Ported verbatim from obsidian-stewardship/src/baseline-store.ts (#83, cycle 1). This is
// relocated PERSISTENCE substrate: `setBaseline` is the baseline-advance primitive, but it
// is a pure method over an injected BlobFs and is wired to NO MCP tool, NO plugin instance,
// and NO `app` this cycle — the accept/adopt gestures that reach it are cycle-2 work behind
// the accept-reachability review. ZERO baseline SURFACE is added by moving it.

import { contentHash } from "./hash.js";
import { LegacyWriterDisabledError } from "./migration/cutover.js";

export interface BlobFs {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(dir: string): Promise<string[]>; // full paths of files directly under dir
  /** Delete a blob. Only ever called on a baseline file this store itself wrote, and
   *  only after its replacement has been written — see `rekey`. */
  remove(path: string): Promise<void>;
}

export interface Baseline {
  path: string;
  content: string;
  hash: string;
  acceptedAt: string; // ISO 8601
  acceptedBy: string;
}

function fileFor(baseDir: string, notePath: string): string {
  return `${baseDir}/${contentHash(notePath)}.json`;
}

export class BaselineStore {
  private cache = new Map<string, Baseline>();
  private loaded = false;

  /**
   * @param writeAllowed WP8's cutover guard, read LIVE on every write: when it
   * returns false, `setBaseline` and `rekey` REFUSE with
   * LegacyWriterDisabledError — the disabled legacy standing writer actually
   * refuses rather than merely being unreferenced ("never run two standing
   * writers concurrently" as a runtime property). Every legacy write path
   * (Accept, adopt-baseline, silent human advance, auto-accept) funnels
   * through these two methods, so this is the single choke point. Absent ⇒
   * allowed (pre-cutover construction, bare embeds, tests).
   */
  constructor(
    private readonly fs: BlobFs,
    private readonly baseDir: string,
    private readonly writeAllowed?: () => boolean
  ) {}

  private requireWritable(op: string): void {
    if (this.writeAllowed && !this.writeAllowed()) throw new LegacyWriterDisabledError(op);
  }

  async load(): Promise<void> {
    await this.ensureDir();
    this.cache.clear();
    let files: string[] = [];
    try { files = await this.fs.list(this.baseDir); } catch { files = []; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (f.endsWith("/index.json")) continue;
      try {
        const b = JSON.parse(await this.fs.read(f)) as Baseline;
        // D3 — a partial/malformed blob missing `content` would yield {content: undefined}
        // and mis-restore (wipe the note) on revert. Require both fields; else treat as
        // no-baseline (skip) so a corrupt file can never drive a destructive restore.
        if (b && typeof b.path === "string" && typeof b.content === "string") {
          this.cache.set(b.path, b);
        }
      } catch { /* skip corrupt baseline file */ }
    }
    this.loaded = true;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.fs.exists(this.baseDir))) {
      await this.fs.mkdir(this.baseDir);
    }
  }

  has(path: string): boolean { return this.cache.has(path); }
  get(path: string): Baseline | null { return this.cache.get(path) ?? null; }
  all(): Baseline[] { return [...this.cache.values()]; }
  get size(): number { return this.cache.size; }

  // Advance (or create) the baseline for a note to `content`, attributed to `acceptedBy`.
  // This is the only thing that ADVANCES a baseline — the only place `acceptedAt`/`acceptedBy`
  // are ever stamped; both Accept and the silent human-edit path funnel through here. (`rekey`
  // also writes baseline files, but it only RE-ADDRESSES an existing one and stamps nothing,
  // which is exactly why it does not route through this method.)
  async setBaseline(
    path: string,
    content: string,
    acceptedBy: string,
    acceptedAt: string = new Date().toISOString(),
  ): Promise<Baseline> {
    this.requireWritable("setBaseline (the baseline-advance primitive)");
    await this.ensureDir();
    const baseline: Baseline = {
      path,
      content,
      hash: contentHash(content),
      acceptedAt,
      acceptedBy,
    };
    await this.fs.write(fileFor(this.baseDir, path), JSON.stringify(baseline, null, 2));
    this.cache.set(path, baseline);
    return baseline;
  }

  /**
   * Move a baseline to a new note path, preserving the acceptance verbatim.
   *
   * This is a RE-ADDRESSING, not an acceptance: `content`, `hash`, `acceptedAt` and
   * `acceptedBy` are carried across untouched, so the human decision the baseline
   * records is the same decision afterwards — only the note's location changed.
   * It is deliberately NOT routed through `setBaseline`, which would stamp a fresh
   * `acceptedAt`/`acceptedBy` and thereby forge an acceptance nobody gave.
   *
   * Refuses rather than overwrites when the destination already has a baseline: that
   * baseline is a live acceptance of the note now at that path, and it must outrank a
   * stale record of some other path. Write-then-delete order means a crash mid-way
   * leaves a duplicate (harmless: `load` keys by the record's own `path`), never a gap.
   */
  async rekey(oldPath: string, newPath: string): Promise<"moved" | "no-baseline" | "target-exists"> {
    this.requireWritable("rekey (baseline re-addressing)");
    if (oldPath === newPath) return "no-baseline";
    const existing = this.cache.get(oldPath);
    if (!existing) return "no-baseline";
    if (this.cache.has(newPath)) return "target-exists";
    // Claim the destination SYNCHRONOUSLY, before any await: the guard above and the
    // write below straddle two awaits, so two concurrent rekeys onto one destination
    // would otherwise both pass it and the loser's acceptance would be destroyed.
    const moved: Baseline = { ...existing, path: newPath };
    this.cache.set(newPath, moved);
    this.cache.delete(oldPath);
    try {
      await this.ensureDir();
      await this.fs.write(fileFor(this.baseDir, newPath), JSON.stringify(moved, null, 2));
    } catch (e) {
      this.cache.delete(newPath);          // roll the claim back; nothing was written
      this.cache.set(oldPath, existing);
      throw e;
    }
    try {
      await this.fs.remove(fileFor(this.baseDir, oldPath));
    } catch (e) {
      // The move landed, so never fail the rekey over cleanup — but do NOT pretend this
      // is harmless: the stale blob still carries `path: oldPath`, so the next load()
      // re-inserts the OLD baseline at the old path. That means a permanent
      // "target-has-baseline" refusal on later reconciles, and a stale acceptance
      // waiting for any note later created at that path. Say so.
      console.warn(
        "governor: baseline rekey left a stale blob at",
        fileFor(this.baseDir, oldPath),
        "— it will re-appear as a baseline for",
        oldPath,
        "on next load; remove it by hand.",
        e
      );
    }
    return "moved";
  }

  isLoaded(): boolean { return this.loaded; }
}
