import { promises as fs } from "node:fs";
import path from "node:path";
import { vaultRoot } from "./vault.js";

/**
 * In-memory index of the vault.
 *
 * Drives `obsidian_resolve` (wikilink/alias/JD-ID → path), backlinks, outlinks,
 * and the `index_status` field on existing read tools. The index is the
 * keystone for the Architecture A roadmap — see GitHub issue #15.
 *
 * Cost: ~7,300 notes × small-file frontmatter+link parse. ~5–10s cold on
 * Vultr's spinning disk; sub-second on hot pagecache. Fits in <5 MB RSS.
 *
 * Refresh model: built at startup, then auto-refreshed by the vault watcher
 * (#23, `vault-watcher.ts`) which debounces add/change/unlink events into
 * per-file `applyAddOrChange` / `applyUnlink` calls within ~250ms of the
 * last event. `obsidian_force_reindex` (#22) is the synchronous escape hatch
 * (full rebuild). `buildIndex` and all incremental ops are serialized on a
 * single mutation queue, so there is never a concurrent modification of state.
 * Reads during `buildIndex` see the previous ready index via atomic swap;
 * reads during an incremental op see consistent state because Node single-
 * threads the synchronous map mutations between awaits.
 */

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export type IndexStatus = "indexing" | "ready" | "error";

export type FrontmatterValue = string | number | boolean | string[];

export interface IndexedNote {
  path: string;                                  // vault-relative, e.g. "Folder/Note.md"
  basename: string;                              // filename without .md, e.g. "Note"
  jdId?: string;                                 // shortcut accessor; same as frontmatter["jd-id"]
  aliases: string[];                             // shortcut accessor; same as frontmatter.aliases when array-typed
  outlinks: string[];                            // raw [[wikilink targets]] extracted from body
  frontmatter: Record<string, FrontmatterValue>; // best-effort parsed top-level YAML scalars/arrays
}

interface IndexState {
  status: IndexStatus;
  error?: string;
  notes: IndexedNote[];
  byPath: Map<string, IndexedNote>;
  byBasename: Map<string, IndexedNote[]>;                    // lowercase key; multi-value
  byAlias: Map<string, IndexedNote[]>;                       // lowercase key; multi-value
  byJdId: Map<string, IndexedNote>;
  backlinks: Map<string, string[]>;                          // resolved-path → list of paths linking TO it
  byFrontmatter: Map<string, Map<string, IndexedNote[]>>;    // property → string-coerced value → notes
  lastBuiltAt?: string;                                      // ISO-8601 timestamp of the last successful build
}

let state: IndexState = makeEmpty();

/**
 * Dedupes concurrent `buildIndex` calls to a single in-flight rebuild. While
 * a rebuild is running, additional callers await the same promise rather than
 * kicking off a second disk walk. Cleared in a `finally` so a failed rebuild
 * doesn't block the next attempt.
 */
let inFlightBuild: Promise<void> | null = null;

/**
 * Serial mutation queue: `buildIndex` and the incremental `apply*` ops all
 * chain off this promise so they execute one at a time. Without it,
 * `applyAddOrChange` could run between a `buildIndex`'s `await fs.readFile`
 * yields and clobber its partial state. Each enqueued op's errors are
 * isolated — the queue continues even if one mutation throws.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(work: () => Promise<T> | T): Promise<T> {
  // Explicit thunks (rather than `.then(work, work)`) drop the prior
  // settle value — Promise rejection handlers receive the rejection as
  // their first arg, and we don't want a future zero-arg `work` quietly
  // gaining a parameter and seeing the prior error.
  const next = mutationQueue.then(
    () => work(),
    () => work()
  );
  mutationQueue = next.then(
    () => {},
    () => {}
  );
  return next as Promise<T>;
}

function makeEmpty(): IndexState {
  return {
    status: "indexing",
    notes: [],
    byPath: new Map(),
    byBasename: new Map(),
    byAlias: new Map(),
    byJdId: new Map(),
    backlinks: new Map(),
    byFrontmatter: new Map(),
  };
}

async function walkVault(root: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walkVault(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      acc.push(full);
    }
  }
}

/**
 * Walk a YAML inline-flow array's contents (the part inside `[...]`) and
 * return its string items. Handles `"…"` and `'…'` quoted strings with
 * embedded commas — so `["Foo, bar", baz]` produces `["Foo, bar", "baz"]`.
 * Does NOT handle nested arrays or other YAML niceties — flow strings only.
 * Reviewer-driven: jd-tools-emitted aliases can contain commas inside quotes.
 */
function parseInlineFlowArray(inner: string): string[] {
  const items: string[] = [];
  let buf = "";
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQuote) {
      if (c === "\\" && i + 1 < inner.length) {
        buf += inner[i + 1];
        i++;
      } else if (c === inQuote) {
        inQuote = null;
      } else {
        buf += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'";
      continue;
    }
    if (c === ",") {
      const t = buf.trim();
      if (t) items.push(t);
      buf = "";
      continue;
    }
    buf += c;
  }
  const t = buf.trim();
  if (t) items.push(t);
  return items;
}

function coerceScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

/**
 * Parse top-level YAML scalars and arrays from frontmatter.
 *
 * Lightweight, regex+state-machine. Handles:
 *   - inline scalar: `key: value`
 *   - inline flow array: `key: [a, "Foo, bar"]`
 *   - block array: `key:\n  - a\n  - b`
 *   - bool/int/float coercion
 *
 * Does NOT handle:
 *   - nested objects
 *   - block scalars (`|` or `>`)
 *   - multiline quoted strings
 *
 * Such fields are skipped (best-effort), which is fine for the read-side
 * search/get use case and matches Obsidian Sync's typical output.
 */
export function parseAllFrontmatter(text: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return result;
  const lines = match[1].split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Top-level key (no leading whitespace), simple ident chars + dashes/underscores
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_\-]*?):\s*(.*?)\s*$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rawValue = m[2];

    if (rawValue === "") {
      // Could be a block array — peek ahead.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bm = lines[j].match(/^\s+-\s*(.*?)\s*$/);
        if (!bm) break;
        const v = bm[1].replace(/^['"]|['"]$/g, "");
        items.push(v);
        j++;
      }
      if (items.length > 0) {
        result[key] = items;
        i = j;
      } else {
        result[key] = "";
        i++;
      }
      continue;
    }

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = parseInlineFlowArray(rawValue.slice(1, -1));
      i++;
      continue;
    }

    result[key] = coerceScalar(rawValue);
    i++;
  }
  return result;
}

/** Backward-compatible shortcut for buildIndex's needs. */
function parseFrontmatter(text: string): { jdId?: string; aliases: string[]; full: Record<string, FrontmatterValue> } {
  const full = parseAllFrontmatter(text);
  const jdRaw = full["jd-id"];
  const jdId = typeof jdRaw === "string" ? jdRaw : typeof jdRaw === "number" ? String(jdRaw) : undefined;
  const aliasesRaw = full["aliases"];
  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : typeof aliasesRaw === "string" && aliasesRaw ? [aliasesRaw] : [];
  return { jdId, aliases, full };
}

/**
 * Extract outbound [[wikilink]] targets from a note's body. Strips fenced
 * and inline code so we don't index links from code samples. Returns the
 * raw target strings (without alias/fragment); resolution happens later.
 */
export function parseOutlinks(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const cleaned = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  const targets = new Set<string>();
  for (const m of cleaned.matchAll(/\[\[([^\]|#^]+?)(?:[|#^][^\]]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t) targets.add(t);
  }
  return [...targets];
}

/**
 * Build (or rebuild) the in-memory index from disk.
 *
 * - Concurrent callers share a single in-flight rebuild via `inFlightBuild`,
 *   so two simultaneous `force_reindex` calls cost one disk walk.
 * - The new state is assembled into local vars and assigned to `state` in a
 *   single statement at the end — reads during a rebuild keep seeing the
 *   previous ready index. The only window where reads see an empty index is
 *   the very first call at process start (before any rebuild has completed).
 * - On error, swaps in an empty error-state. The previous index is dropped;
 *   that matches the prior behavior and is fine since a rebuild error after a
 *   successful one is unexpected enough that the agent should be told plainly.
 */
export async function buildIndex(): Promise<void> {
  if (inFlightBuild) return inFlightBuild;
  // Route through the shared mutation queue so a `buildIndex` and any pending
  // incremental ops execute in order.
  inFlightBuild = enqueueMutation(doBuildIndex);
  try {
    await inFlightBuild;
  } finally {
    inFlightBuild = null;
  }
}

async function doBuildIndex(): Promise<void> {
  const root = vaultRoot();
  try {
    const abs: string[] = [];
    await walkVault(root, abs);
    abs.sort();

    const notes: IndexedNote[] = [];
    for (const absPath of abs) {
      const relPath = path.relative(root, absPath).split(path.sep).join("/");
      const basename = path.basename(relPath, ".md");
      let text: string;
      try {
        text = await fs.readFile(absPath, "utf8");
      } catch {
        continue; // unreadable file → skip rather than fail the whole index
      }
      const { jdId, aliases, full } = parseFrontmatter(text);
      const outlinks = parseOutlinks(text);
      notes.push({ path: relPath, basename, jdId, aliases, outlinks, frontmatter: full });
    }

    const byPath = new Map<string, IndexedNote>();
    const byBasename = new Map<string, IndexedNote[]>();
    const byAlias = new Map<string, IndexedNote[]>();
    const byJdId = new Map<string, IndexedNote>();
    const backlinks = new Map<string, string[]>();

    for (const note of notes) {
      byPath.set(note.path, note);

      const bn = note.basename.toLowerCase();
      if (!byBasename.has(bn)) byBasename.set(bn, []);
      byBasename.get(bn)!.push(note);

      for (const alias of note.aliases) {
        const al = alias.toLowerCase();
        if (!byAlias.has(al)) byAlias.set(al, []);
        byAlias.get(al)!.push(note);
      }

      if (note.jdId) {
        if (byJdId.has(note.jdId)) {
          console.error(
            `[index] duplicate jd-id '${note.jdId}' — '${byJdId.get(note.jdId)!.path}' vs '${note.path}'. ` +
              `Second occurrence wins; JD invariant violation worth investigating.`
          );
        }
        byJdId.set(note.jdId, note);
      }
    }

    // Second pass: resolve outlinks and populate backlinks map.
    // Reuses the lookup tables we just built; no need for the full
    // resolveRefs surface here since outlinks have no fragment/alias parsing.
    for (const note of notes) {
      for (const target of note.outlinks) {
        const resolved = resolveTargetSimple(target, byPath, byBasename, byAlias, byJdId);
        if (resolved) {
          if (!backlinks.has(resolved.path)) backlinks.set(resolved.path, []);
          const arr = backlinks.get(resolved.path)!;
          if (!arr.includes(note.path)) arr.push(note.path);
        }
      }
    }

    // Build the frontmatter lookup index. Explode array values so each element
    // produces an edge. Key on lowercase property name (Obsidian frontmatter is
    // case-insensitive at the property level); preserve case in the value.
    const byFrontmatter = new Map<string, Map<string, IndexedNote[]>>();
    for (const note of notes) {
      for (const [rawProp, value] of Object.entries(note.frontmatter)) {
        const prop = rawProp.toLowerCase();
        let propMap = byFrontmatter.get(prop);
        if (!propMap) {
          propMap = new Map();
          byFrontmatter.set(prop, propMap);
        }
        const values = Array.isArray(value) ? value : [String(value)];
        for (const v of values) {
          if (v === "" || v === undefined) continue;
          let arr = propMap.get(v);
          if (!arr) {
            arr = [];
            propMap.set(v, arr);
          }
          if (!arr.includes(note)) arr.push(note);
        }
      }
    }

    // Atomic swap: in-flight reads see the previous `state` until this line.
    state = {
      status: "ready",
      notes,
      byPath,
      byBasename,
      byAlias,
      byJdId,
      backlinks,
      byFrontmatter,
      lastBuiltAt: new Date().toISOString(),
    };
  } catch (e) {
    state = {
      ...makeEmpty(),
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function resolveTargetSimple(
  target: string,
  byPath: Map<string, IndexedNote>,
  byBasename: Map<string, IndexedNote[]>,
  byAlias: Map<string, IndexedNote[]>,
  byJdId: Map<string, IndexedNote>
): IndexedNote | undefined {
  if (byPath.has(target)) return byPath.get(target);
  const withMd = target.endsWith(".md") ? target : target + ".md";
  if (byPath.has(withMd)) return byPath.get(withMd);
  if (byJdId.has(target)) return byJdId.get(target);
  const bn = target.toLowerCase();
  const bnMatches = byBasename.get(bn);
  if (bnMatches?.length === 1) return bnMatches[0];
  const aliasMatches = byAlias.get(bn);
  if (aliasMatches?.length === 1) return aliasMatches[0];
  return undefined; // unresolvable OR ambiguous → no backlink edge
}

export function indexStatus(): { status: IndexStatus; error?: string; count: number; last_built_at?: string } {
  return {
    status: state.status,
    error: state.error,
    count: state.notes.length,
    last_built_at: state.lastBuiltAt,
  };
}

export interface ResolveResult {
  ref: string;
  path?: string;
  matched_by?: "path" | "basename" | "alias" | "jd-id";
  fragment?: string;
  alias?: string;
  ambiguous?: string[];
}

/**
 * Obsidian-faithful resolution algorithm:
 *   1. Strip [[…]] wrapping and split off `|alias` + `#fragment`.
 *   2. Try exact vault-relative path (with or without .md).
 *   3. Try `jd-id` frontmatter match. (Extension over vanilla Obsidian.)
 *   4. Try basename. Unique → return; multiple → `ambiguous` with all candidates.
 *   5. Try frontmatter alias. Same uniqueness rule.
 *
 * Invariant: each ResolveResult has at most one of `path` / `ambiguous` set
 * — never both. Unresolved results have neither. Callers can filter on
 * `r.path === undefined && r.ambiguous === undefined` for unresolved.
 */
export function resolveRefs(refs: string[]): ResolveResult[] {
  return refs.map((ref) => {
    let working = ref.trim().replace(/^\[\[|\]\]$/g, "").trim();
    let alias: string | undefined;
    let fragment: string | undefined;

    const pipeIdx = working.indexOf("|");
    if (pipeIdx >= 0) {
      alias = working.slice(pipeIdx + 1).trim() || undefined;
      working = working.slice(0, pipeIdx);
    }
    const hashIdx = working.indexOf("#");
    if (hashIdx >= 0) {
      fragment = working.slice(hashIdx + 1).trim() || undefined;
      working = working.slice(0, hashIdx);
    }
    working = working.trim();
    if (!working) return { ref, fragment, alias };

    // 1. exact path
    if (state.byPath.has(working)) {
      return { ref, path: state.byPath.get(working)!.path, matched_by: "path", fragment, alias };
    }
    const withMd = working.endsWith(".md") ? working : working + ".md";
    if (state.byPath.has(withMd)) {
      return { ref, path: state.byPath.get(withMd)!.path, matched_by: "path", fragment, alias };
    }

    // 2. JD-ID
    if (state.byJdId.has(working)) {
      return { ref, path: state.byJdId.get(working)!.path, matched_by: "jd-id", fragment, alias };
    }

    // 3. basename
    const bn = working.toLowerCase();
    const bnMatches = state.byBasename.get(bn);
    if (bnMatches?.length === 1) {
      return { ref, path: bnMatches[0].path, matched_by: "basename", fragment, alias };
    }
    if (bnMatches && bnMatches.length > 1) {
      return { ref, ambiguous: bnMatches.map((n) => n.path), fragment, alias };
    }

    // 4. alias
    const aliasMatches = state.byAlias.get(bn);
    if (aliasMatches?.length === 1) {
      return { ref, path: aliasMatches[0].path, matched_by: "alias", fragment, alias };
    }
    if (aliasMatches && aliasMatches.length > 1) {
      return { ref, ambiguous: aliasMatches.map((n) => n.path), fragment, alias };
    }

    return { ref, fragment, alias };
  });
}

export function getBacklinks(notePath: string): string[] {
  return state.backlinks.get(notePath) ?? [];
}

export interface OutlinkEntry {
  ref: string;
  resolved_path?: string;
  /** Populated when the ref matches multiple basenames/aliases; the agent can
   * disambiguate or treat the link as deliberately polymorphic. */
  ambiguous_paths?: string[];
}

export function getOutlinks(notePath: string): OutlinkEntry[] {
  const note = state.byPath.get(notePath);
  if (!note) return [];
  return note.outlinks.map((ref) => {
    const r = resolveRefs([ref])[0];
    const entry: OutlinkEntry = { ref };
    if (r.path) entry.resolved_path = r.path;
    else if (r.ambiguous) entry.ambiguous_paths = r.ambiguous;
    return entry;
  });
}

/**
 * Look up notes whose frontmatter has `property == value`. For array-typed
 * properties (e.g. `tags`), matches if any array element equals `value`.
 * Property name match is case-insensitive (Obsidian convention); value match
 * is exact (case-sensitive) for predictability.
 */
export function searchByFrontmatter(property: string, value: string): IndexedNote[] {
  const propMap = state.byFrontmatter.get(property.toLowerCase());
  if (!propMap) return [];
  return [...(propMap.get(value) ?? [])];
}

/**
 * Return the parsed frontmatter for a note from the in-memory index. Returns
 * undefined if the note isn't in the index — call `applyAddOrChange` first
 * (or `buildIndex`) if you've just written to disk and need a fresh view.
 */
export function getIndexedFrontmatter(notePath: string): Record<string, FrontmatterValue> | undefined {
  return state.byPath.get(notePath)?.frontmatter;
}

// ============================================================================
// Incremental updates (#23 — single-file mutations instead of full rewalk).
//
// Invariants the apply* functions must preserve, so per-event updates produce
// the same state a fresh `buildIndex` would:
//   - `byPath` is the source of truth; every other map indexes a subset of it.
//   - All multi-value maps (basename / alias / byFrontmatter) hold no empty
//     buckets — when the last note leaves a bucket, the bucket key is deleted.
//   - `byJdId` holds the *most recent* note for that jd-id; duplicates log a
//     warning that mirrors the startup-time collision message.
//   - `backlinks[T]` lists files that currently outlink to T. Deleting T
//     clears `backlinks[T]` so `get_backlinks(T)` returns []
//     (matches what a fresh rebuild would produce — unresolved targets get
//     no backlink edges).
//
// All three apply* entry points serialize through `enqueueMutation` so they
// can't interleave with `buildIndex` or with each other. Within a single
// op's synchronous tail (the map mutations), Node's single-threadedness
// guarantees readers see consistent state.
// ============================================================================

async function parseNoteFromDisk(absPath: string): Promise<IndexedNote> {
  const root = vaultRoot();
  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  const basename = path.basename(relPath, ".md");
  const text = await fs.readFile(absPath, "utf8");
  const { jdId, aliases, full } = parseFrontmatter(text);
  const outlinks = parseOutlinks(text);
  return { path: relPath, basename, jdId, aliases, outlinks, frontmatter: full };
}

function removeFromForwardMaps(note: IndexedNote): void {
  state.byPath.delete(note.path);

  const noteIdx = state.notes.findIndex((n) => n.path === note.path);
  if (noteIdx >= 0) state.notes.splice(noteIdx, 1);

  const bn = note.basename.toLowerCase();
  const bnArr = state.byBasename.get(bn);
  if (bnArr) {
    const i = bnArr.findIndex((n) => n.path === note.path);
    if (i >= 0) bnArr.splice(i, 1);
    if (bnArr.length === 0) state.byBasename.delete(bn);
  }

  for (const alias of note.aliases) {
    const al = alias.toLowerCase();
    const arr = state.byAlias.get(al);
    if (!arr) continue;
    const i = arr.findIndex((n) => n.path === note.path);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) state.byAlias.delete(al);
  }

  // byJdId is single-valued. Only delete if THIS note is the current owner —
  // a duplicate-jd-id collision may have written another note over the entry,
  // and we don't want to evict the survivor.
  if (note.jdId && state.byJdId.get(note.jdId)?.path === note.path) {
    state.byJdId.delete(note.jdId);
  }

  for (const [rawProp, value] of Object.entries(note.frontmatter)) {
    const prop = rawProp.toLowerCase();
    const propMap = state.byFrontmatter.get(prop);
    if (!propMap) continue;
    const values = Array.isArray(value) ? value : [String(value)];
    for (const v of values) {
      if (v === "" || v === undefined) continue;
      const arr = propMap.get(v);
      if (!arr) continue;
      const i = arr.findIndex((n) => n.path === note.path);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) propMap.delete(v);
    }
    if (propMap.size === 0) state.byFrontmatter.delete(prop);
  }
}

function addToForwardMaps(note: IndexedNote): void {
  state.byPath.set(note.path, note);
  state.notes.push(note);

  const bn = note.basename.toLowerCase();
  if (!state.byBasename.has(bn)) state.byBasename.set(bn, []);
  state.byBasename.get(bn)!.push(note);

  for (const alias of note.aliases) {
    const al = alias.toLowerCase();
    if (!state.byAlias.has(al)) state.byAlias.set(al, []);
    state.byAlias.get(al)!.push(note);
  }

  if (note.jdId) {
    const existing = state.byJdId.get(note.jdId);
    if (existing && existing.path !== note.path) {
      console.error(
        `[index] duplicate jd-id '${note.jdId}' — '${existing.path}' vs '${note.path}'. ` +
          `Second occurrence wins; JD invariant violation worth investigating.`
      );
    }
    state.byJdId.set(note.jdId, note);
  }

  for (const [rawProp, value] of Object.entries(note.frontmatter)) {
    const prop = rawProp.toLowerCase();
    let propMap = state.byFrontmatter.get(prop);
    if (!propMap) {
      propMap = new Map();
      state.byFrontmatter.set(prop, propMap);
    }
    const values = Array.isArray(value) ? value : [String(value)];
    for (const v of values) {
      if (v === "" || v === undefined) continue;
      let arr = propMap.get(v);
      if (!arr) {
        arr = [];
        propMap.set(v, arr);
      }
      if (!arr.includes(note)) arr.push(note);
    }
  }
}

/**
 * Re-derive `state.backlinks` from scratch using current forward maps.
 *
 * Why not per-edge updates: a per-edge `removeBacklinkEdges` /
 * `addBacklinkEdges` pair handles the changing note's own outlinks but
 * misses three classes of cross-note resolution changes that a fresh
 * rebuild would catch — (1) adding a new note that another note's
 * previously-unresolved outlink now matches; (2) adding a note that
 * introduces basename or alias ambiguity, invalidating an existing
 * unique match; (3) removing a note that other outlinks resolved to,
 * which may now match a different candidate by basename/alias.
 *
 * Re-deriving is O(N × avg_outlinks). `resolveTargetSimple` is ~20ns
 * (a few Map.has/get calls); 36k calls (7k notes × 5 outlinks) is
 * comfortably under 5ms in practice — well below the 250ms watcher
 * debounce — so we trade clever-but-fragile diffing for correctness.
 */
function recomputeAllBacklinks(): void {
  state.backlinks.clear();
  // Sort by path so backlink list ordering matches what `buildIndex` produces
  // (it walks abs-sorted paths). `state.notes` is insertion order, which is
  // path-sorted at first build but drifts as incremental ops `push` new notes
  // and `splice` old ones — without this sort, the same disk state can produce
  // different `getBacklinks` orderings depending on update path.
  const ordered = [...state.notes].sort((a, b) => a.path.localeCompare(b.path));
  for (const note of ordered) {
    for (const target of note.outlinks) {
      const resolved = resolveTargetSimple(
        target,
        state.byPath,
        state.byBasename,
        state.byAlias,
        state.byJdId
      );
      if (!resolved) continue;
      let arr = state.backlinks.get(resolved.path);
      if (!arr) {
        arr = [];
        state.backlinks.set(resolved.path, arr);
      }
      if (!arr.includes(note.path)) arr.push(note.path);
    }
  }
}

async function doApplyAddOrChange(absPath: string): Promise<void> {
  if (state.status !== "ready") return;
  let newNote: IndexedNote;
  try {
    newNote = await parseNoteFromDisk(absPath);
  } catch {
    return; // unreadable file → leave the index untouched
  }
  const existing = state.byPath.get(newNote.path);
  if (existing) removeFromForwardMaps(existing);
  addToForwardMaps(newNote);
  recomputeAllBacklinks();
  state.lastBuiltAt = new Date().toISOString();
}

function doApplyUnlink(absPath: string): void {
  if (state.status !== "ready") return;
  const root = vaultRoot();
  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  const existing = state.byPath.get(relPath);
  if (!existing) return;
  removeFromForwardMaps(existing);
  recomputeAllBacklinks();
  state.lastBuiltAt = new Date().toISOString();
}

/**
 * Apply a single-file add/change event incrementally. The watcher debounces
 * chokidar events per-path and dispatches here. Safe to call for a path
 * that's already in the index (treated as a change) or that isn't (treated
 * as an add) — the resolution happens inside via `byPath` lookup.
 *
 * Errors during file read or parse are swallowed (the file may have been
 * unlinked in the debounce window); the index stays at its prior shape.
 */
export function applyAddOrChange(absPath: string): Promise<void> {
  return enqueueMutation(() => doApplyAddOrChange(absPath));
}

/**
 * Apply a single-file unlink event incrementally. Removes the note from
 * every forward map, walks its prior outlinks to drop backlink edges, and
 * clears its inverse backlink list (matching what a fresh rebuild produces
 * for an absent target).
 *
 * No-op if the path isn't in the index (event for a never-tracked file or
 * a double-fired unlink).
 */
export function applyUnlink(absPath: string): Promise<void> {
  return enqueueMutation(() => doApplyUnlink(absPath));
}
