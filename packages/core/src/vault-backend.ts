/**
 * Abstract contract for vault access.
 *
 * This interface is the seam between the MCP server layer and the concrete
 * storage implementations. `FilesystemBackend` (packages/server) and the
 * Obsidian plugin's live backend both implement it.
 *
 * All methods are async throughout so that the plugin backend can use
 * Obsidian's async vault APIs without any synchronous-to-async conversion at
 * the adapter layer.
 *
 * No runtime dependency on `obsidian`, `express`, or `jose` — zero imports
 * from those packages here.
 */

// ── Scalar and frontmatter value types ────────────────────────────────────────

/** A single non-null frontmatter value: string, number, or boolean. */
export type FrontmatterScalar = string | number | boolean;

/**
 * A frontmatter value accepted/returned by the manage-frontmatter operations:
 * a scalar or an array of scalars.
 */
export type FrontmatterEditValue = FrontmatterScalar | FrontmatterScalar[];

/**
 * A frontmatter value as stored in the in-memory index.
 * Uses string[] for array values (vs. mixed-scalar arrays in FrontmatterEditValue).
 */
export type FrontmatterValue = string | number | boolean | string[];

// ── Read result types ─────────────────────────────────────────────────────────

/** Minimal note reference returned by listing and tag-search operations. */
export interface NoteRef {
  path: string;
}

/** A single line-level search hit from a text search. */
export interface SearchHit {
  path: string;
  /** 1-based line number. */
  line: number;
  /** Up to 300 chars of the matching line. */
  snippet: string;
}

/** Controls how many hits are returned per file in a text search. */
export type SearchMode = "one_per_note" | "all";

/** Successful single-note read inside a batch. */
export interface ReadNoteResult {
  path: string;
  content: string;
}

/** Failed single-note read (non-fatal inside a batch). */
export interface ReadNoteError {
  path: string;
  error: string;
}

/**
 * Batch read result. Partial failures are represented as ReadNoteError entries;
 * the call itself never throws for missing/unreadable paths.
 */
export interface ReadNotesResult {
  results: Array<ReadNoteResult | ReadNoteError>;
}

// ── Patch types ───────────────────────────────────────────────────────────────

/** Anchor for a surgical note patch: a heading text or a block-reference id. */
export type PatchAnchor =
  | { type: "heading"; value: string }
  | { type: "block"; value: string };

/** Positional operation for a patch at an anchor. */
export type PatchOp = "append" | "prepend" | "replace";

// ── Link resolution types ─────────────────────────────────────────────────────

/** Result of resolving a single wikilink, basename, or path reference. */
export interface ResolveResult {
  ref: string;
  path?: string;
  matched_by?: "path" | "basename" | "alias" | "jd-id";
  fragment?: string;
  alias?: string;
  /** Populated when the ref matches multiple candidates ambiguously. */
  ambiguous?: string[];
}

/** An outbound link from a note, with optional resolved target path. */
export interface OutlinkEntry {
  ref: string;
  resolved_path?: string;
  ambiguous_paths?: string[];
}

// ── Frontmatter search result ─────────────────────────────────────────────────

/**
 * A note matched by a frontmatter property search.
 * Subset of the in-memory IndexedNote (path + parsed frontmatter).
 */
export interface FrontmatterSearchResult {
  path: string;
  frontmatter: Record<string, FrontmatterValue>;
}

// ── Frontmatter operation result ──────────────────────────────────────────────

/**
 * Return shape for manageFrontmatter. Only the op-relevant fields are set:
 *
 *   "get"    → `value` holds the current field value (undefined if absent).
 *   "set"    → `previous` holds the old value; `created_frontmatter` is true
 *              if no frontmatter block existed and one was created.
 *   "delete" → `previous` holds the old value; `existed` is true if the key
 *              was present before the deletion.
 */
export interface ManageFrontmatterResult {
  /** "get": current value. "set"/"delete": value before the mutation. */
  value?: FrontmatterEditValue;
  /** "set"/"delete": the value that was replaced or removed. */
  previous?: FrontmatterEditValue;
  /** "set": true when a new frontmatter block was created from scratch. */
  created_frontmatter?: boolean;
  /** "delete": true when the key was present before deletion. */
  existed?: boolean;
}

// ── The backend interface ─────────────────────────────────────────────────────

/**
 * One method per filesystem-expressible vault operation (17 total).
 *
 * Implementors:
 *   - `FilesystemBackend` in `packages/server` — wraps vault.ts + index-store.ts.
 *   - Plugin live backend — wraps Obsidian's vault and metadata-cache APIs.
 *
 * All paths are vault-relative (e.g. `"Folder/Note.md"`).
 * Path-traversal attempts (`../`) MUST throw rather than be served.
 */
export interface VaultBackend {
  // ── Read: listing & navigation ─────────────────────────────────────────────

  /**
   * List markdown notes, optionally scoped to a subfolder, with pagination.
   */
  listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ total: number; notes: NoteRef[] }>;

  /**
   * List immediate child folders of `subdir` (or the vault root).
   * Each entry includes a recursive markdown-note count.
   */
  listFolders(
    subdir: string | undefined,
  ): Promise<Array<{ path: string; note_count: number }>>;

  // ── Read: note reading ─────────────────────────────────────────────────────

  /**
   * Read the full markdown content of a single note.
   * Large notes may be truncated with a `[truncated: …]` trailer.
   */
  readNote(relPath: string): Promise<string>;

  // ── Read: search ───────────────────────────────────────────────────────────

  /**
   * Case-insensitive substring search across note contents, line by line.
   */
  searchNotes(query: string, limit: number, mode: SearchMode): Promise<SearchHit[]>;

  /**
   * List notes carrying a tag (inline or in frontmatter).
   */
  findByTag(tag: string, limit: number): Promise<NoteRef[]>;

  /**
   * Find notes whose frontmatter property equals a given value.
   * For array-typed properties, matches if any element equals the value.
   *
   * Note: this method is intentionally uncapped — it returns all matches from
   * the index store. Callers at the MCP layer are responsible for applying any
   * result-set limit before returning results to the client.
   */
  searchByFrontmatter(property: string, value: string): Promise<FrontmatterSearchResult[]>;

  // ── Read: link resolution ──────────────────────────────────────────────────

  /**
   * Resolve wikilinks, basenames, or vault-relative paths to canonical paths.
   * Uses Obsidian's resolution rules (path → jd-id → basename → alias).
   *
   * The optional `from` parameter provides the vault-relative path of the note
   * that contains the references, enabling context-sensitive resolution. It is
   * honored by the live Obsidian backend and ignored (best-effort) by the
   * filesystem backend.
   */
  resolve(refs: string[], from?: string): Promise<ResolveResult[]>;

  /**
   * List notes that link to the given note (backlinks).
   * Returns vault-relative paths of source notes.
   */
  getBacklinks(notePath: string): Promise<string[]>;

  /**
   * List links out of a note, each optionally resolved to a canonical path.
   */
  getOutlinks(notePath: string): Promise<OutlinkEntry[]>;

  // ── Read: index management ─────────────────────────────────────────────────

  /**
   * Force a full rebuild of the in-memory index.
   * For the plugin backend this may be a no-op (Obsidian's cache is always live).
   */
  forceReindex(): Promise<void>;

  // ── Write: frontmatter ─────────────────────────────────────────────────────

  /**
   * Get, set, or delete a single frontmatter key.
   *
   *   op="get"    → returns `{ value }` (undefined if key absent).
   *   op="set"    → writes the key; returns `{ previous, created_frontmatter }`.
   *   op="delete" → removes the key; returns `{ previous, existed }`.
   */
  manageFrontmatter(
    relPath: string,
    key: string,
    op: "get" | "set" | "delete",
    value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult>;

  // ── Write: patching ────────────────────────────────────────────────────────

  /**
   * Append, prepend, or replace content at a heading or block-id anchor.
   * Returns `{ found: false }` (no write) when the anchor is absent.
   */
  patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }>;

  // ── Write: full note ops ───────────────────────────────────────────────────

  /**
   * Create a note, or overwrite an existing one when `overwrite` is true.
   * Parent folders are created as needed.
   */
  writeNote(
    relPath: string,
    content: string,
    overwrite: boolean,
  ): Promise<{ path: string; created: boolean }>;

  /**
   * Append content to a note, creating it (and parent folders) if absent.
   */
  appendNote(
    relPath: string,
    content: string,
  ): Promise<{ path: string; created: boolean }>;

  /**
   * Move or rename a note. Backlinks may optionally be rewritten.
   * Returns counts of rewritten references and touched files, or null for each
   * field when the backend performed the operation but cannot determine the
   * count (e.g. the live Obsidian backend delegates to `renameFile` which
   * rewrites backlinks internally without exposing a count). Callers must treat
   * null as "unknown, not zero" — the operation still succeeded.
   */
  moveNote(
    fromRel: string,
    toRel: string,
    options: { update_backlinks: boolean; overwrite: boolean },
  ): Promise<{
    from: string;
    to: string;
    backlinks_updated: number | null;
    backlinks_files_touched: number | null;
  }>;

  /**
   * Permanently delete a note. Requires `confirm: true` to guard against
   * accidental fat-finger deletions.
   */
  deleteNote(relPath: string, confirm: true): Promise<{ path: string; deleted: true }>;
}
