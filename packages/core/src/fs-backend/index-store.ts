import { promises as fs } from "node:fs";
import path from "node:path";
import { vaultRoot } from "./vault.js";
import type { FrontmatterValue, ResolveResult, OutlinkEntry } from "../vault-backend.js";

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
 *
 * The module-level exports use a default singleton over VAULT_ROOT (from
 * vault.ts). The `IndexStore` class provides per-instance state for use by
 * FilesystemBackend.
 */

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export type IndexStatus = "indexing" | "ready" | "error";

// Re-export shared types for callers that imported from index-store.ts before.
export type { FrontmatterValue, ResolveResult, OutlinkEntry };

export interface IndexedNote {
  path: string;                                  // vault-relative, e.g. "Folder/Note.md"
  basename: string;                              // filename without .md, e.g. "Note"
  jdId?: string;                                 // canonical JD id, derived from filename + note-kind (see deriveJdIdFromPath)
  aliases: string[];                             // shortcut accessor; same as frontmatter.aliases when array-typed
  outlinks: string[];                            // raw [[wikilink targets]] extracted from body
  frontmatter: Record<string, FrontmatterValue>; // best-effort parsed top-level YAML scalars/arrays
}

interface IndexState {
  status: IndexStatus;
  error?: string;
  notes: IndexedNote[];
  byPath: Map<string, IndexedNote>;
  byBasename: Map<string, IndexedNote[]>;
  byAlias: Map<string, IndexedNote[]>;
  byJdId: Map<string, IndexedNote>;
  backlinks: Map<string, string[]>;
  byFrontmatter: Map<string, Map<string, IndexedNote[]>>;
  lastBuiltAt?: string;
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

// ── Module-level singleton state ──────────────────────────────────────────────

let state: IndexState = makeEmpty();
let inFlightBuild: Promise<void> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(work: () => Promise<T> | T): Promise<T> {
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

// ── Pure helpers (shared by module-level and IndexStore class) ─────────────────

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
  // Preserve leading-zero forms as strings (e.g. "03.05", "007") — coercing
  // them to numbers would strip the leading zero and break JD-ID lookups like
  // "03.05" → 3.05, which then misses the "03.05" key in byJdId.
  const hasLeadingZero = /^-?0\d/.test(trimmed);
  if (!hasLeadingZero && /^-?\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (!hasLeadingZero && /^-?\d+\.\d+$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

/**
 * Parse top-level YAML scalars and arrays from frontmatter.
 */
export function parseAllFrontmatter(text: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return result;
  const lines = match[1].split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_\-]*?):\s*(.*?)\s*$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rawValue = m[2];

    if (rawValue === "") {
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
function parseFrontmatter(text: string): { aliases: string[]; full: Record<string, FrontmatterValue> } {
  const full = parseAllFrontmatter(text);
  const aliasesRaw = full["aliases"];
  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : typeof aliasesRaw === "string" && aliasesRaw ? [aliasesRaw] : [];
  return { aliases, full };
}

// Areas/categories that use 5-digit ("expanded") ids, mirroring the
// jd-numbering plugin's DEFAULT_CONFIG (obsidian-jd-numbering src/jd.ts). A
// 5-digit filename prefix is only a JD id inside one of these; elsewhere it is
// just a title that happens to start with digits — "10000 Hours.md" is NOT id
// 10000. Keep in sync with jd-numbering; the two are the vault's canonical model.
const EXPANDED_AREAS = new Set(["90-99"]);
const EXPANDED_CATEGORIES = new Set(["27"]);

function isExpandedFiveDigit(prefix: string): boolean {
  const cat = prefix.slice(0, 2);
  const area = `${cat[0]}0-${cat[0]}9`;
  return EXPANDED_AREAS.has(area) || EXPANDED_CATEGORIES.has(cat);
}

/**
 * Derive a note's canonical JD id from its filename + folder, replicating the
 * vault's JD model (jd-numbering `parseJdId` / `canonicalFolderNoteId` and the
 * `jd-id vs filename.base` classifier). The filename is canonical; the id is a
 * pure function of (path, note-kind):
 *   - area folder note      ("00-09 System/00-09 System.md")          → "00-09"
 *   - category folder note  ("…/00 System management/00 System …")    → "00.00"
 *   - id note               ("04.18 obsidian-execute-code.md")        → "04.18"
 *   - project note          ("92208 Concept note.md")                 → "92208"
 * A 5-digit prefix only counts inside an expanded area/category (see above);
 * "NN.NN"-prefixed names always count (matching the vault model). Returns
 * undefined for notes with no JD prefix. This replaced the former frontmatter
 * `jd-id` lookup when that property was retired in favour of filename-canonical.
 */
export function deriveJdIdFromPath(relPath: string, basename: string): string | undefined {
  const slash = relPath.lastIndexOf("/");
  const folder = slash >= 0 ? relPath.slice(0, slash) : "";
  // Area folder note: the note is its own folder note and the folder is an area.
  if (folder === basename) {
    const m = basename.match(/^(\d0-\d9) /);
    if (m) return m[1];
  }
  // Category folder note: folder ends with "/<basename>" and the folder path is
  // "<area>/<NN …>" (area then category, exactly two levels). An id-level folder
  // note (three-segment folder, "NN.NN …" basename) fails this and falls to the
  // id branch below, correctly yielding "NN.NN" rather than "NN.00".
  if (folder.endsWith("/" + basename) && /^\d0-\d9 [^/]+\/\d{2} [^/]+$/.test(folder)) {
    return basename.slice(0, 2) + ".00";
  }
  // Id note: "NN.NN <title>".
  const idMatch = basename.match(/^(\d{2}\.\d{2}) /);
  if (idMatch) return idMatch[1];
  // Project / expanded-item note: "NNNNN <title>" (optionally NNNNN.NN), but
  // only inside an expanded area/category.
  const projMatch = basename.match(/^(\d{5}(?:\.\d{2})?) /);
  if (projMatch && isExpandedFiveDigit(projMatch[1])) return projMatch[1];
  return undefined;
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
  return undefined;
}

// ── State-mutation helpers that work on an explicit IndexState ─────────────────

function _removeFromForwardMaps(s: IndexState, note: IndexedNote): void {
  s.byPath.delete(note.path);

  const noteIdx = s.notes.findIndex((n) => n.path === note.path);
  if (noteIdx >= 0) s.notes.splice(noteIdx, 1);

  const bn = note.basename.toLowerCase();
  const bnArr = s.byBasename.get(bn);
  if (bnArr) {
    const i = bnArr.findIndex((n) => n.path === note.path);
    if (i >= 0) bnArr.splice(i, 1);
    if (bnArr.length === 0) s.byBasename.delete(bn);
  }

  for (const alias of note.aliases) {
    const al = alias.toLowerCase();
    const arr = s.byAlias.get(al);
    if (!arr) continue;
    const i = arr.findIndex((n) => n.path === note.path);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) s.byAlias.delete(al);
  }

  if (note.jdId && s.byJdId.get(note.jdId)?.path === note.path) {
    s.byJdId.delete(note.jdId);
  }

  for (const [rawProp, value] of Object.entries(note.frontmatter)) {
    const prop = rawProp.toLowerCase();
    const propMap = s.byFrontmatter.get(prop);
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
    if (propMap.size === 0) s.byFrontmatter.delete(prop);
  }
}

function _addToForwardMaps(s: IndexState, note: IndexedNote): void {
  s.byPath.set(note.path, note);
  s.notes.push(note);

  const bn = note.basename.toLowerCase();
  if (!s.byBasename.has(bn)) s.byBasename.set(bn, []);
  s.byBasename.get(bn)!.push(note);

  for (const alias of note.aliases) {
    const al = alias.toLowerCase();
    if (!s.byAlias.has(al)) s.byAlias.set(al, []);
    s.byAlias.get(al)!.push(note);
  }

  if (note.jdId) {
    const existing = s.byJdId.get(note.jdId);
    if (existing && existing.path !== note.path) {
      console.error(
        `[index] duplicate jd-id '${note.jdId}' — '${existing.path}' vs '${note.path}'. ` +
          `Second occurrence wins; JD invariant violation worth investigating.`
      );
      // Use the same tiebreak as buildIndex: notes are processed in lexical
      // path order, so the lexically-later path is the winner. Only overwrite
      // when the new note's path sorts after the existing winner's path.
      if (note.path > existing.path) {
        s.byJdId.set(note.jdId, note);
      }
    } else {
      s.byJdId.set(note.jdId, note);
    }
  }

  for (const [rawProp, value] of Object.entries(note.frontmatter)) {
    const prop = rawProp.toLowerCase();
    let propMap = s.byFrontmatter.get(prop);
    if (!propMap) {
      propMap = new Map();
      s.byFrontmatter.set(prop, propMap);
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
 * Re-derive `s.backlinks` from scratch using current forward maps.
 */
function _recomputeAllBacklinks(s: IndexState): void {
  s.backlinks.clear();
  const ordered = [...s.notes].sort((a, b) => a.path.localeCompare(b.path));
  for (const note of ordered) {
    for (const target of note.outlinks) {
      const resolved = resolveTargetSimple(
        target,
        s.byPath,
        s.byBasename,
        s.byAlias,
        s.byJdId
      );
      if (!resolved) continue;
      let arr = s.backlinks.get(resolved.path);
      if (!arr) {
        arr = [];
        s.backlinks.set(resolved.path, arr);
      }
      if (!arr.includes(note.path)) arr.push(note.path);
    }
  }
}

async function _parseNoteFromDisk(root: string, absPath: string): Promise<IndexedNote> {
  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  const basename = path.basename(relPath, ".md");
  const text = await fs.readFile(absPath, "utf8");
  const { aliases, full } = parseFrontmatter(text);
  const jdId = deriveJdIdFromPath(relPath, basename);
  const outlinks = parseOutlinks(text);
  return { path: relPath, basename, jdId, aliases, outlinks, frontmatter: full };
}

async function _doBuildIndex(root: string, setState: (s: IndexState) => void): Promise<void> {
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
        continue;
      }
      const { aliases, full } = parseFrontmatter(text);
      const jdId = deriveJdIdFromPath(relPath, basename);
      const outlinks = parseOutlinks(text);
      notes.push({ path: relPath, basename, jdId, aliases, outlinks, frontmatter: full });
    }

    const byPath = new Map<string, IndexedNote>();
    const byBasename = new Map<string, IndexedNote[]>();
    const byAlias = new Map<string, IndexedNote[]>();
    const byJdId = new Map<string, IndexedNote>();
    const backlinks = new Map<string, string[]>();

    const tmpState: IndexState = { status: "indexing", notes, byPath, byBasename, byAlias, byJdId, backlinks, byFrontmatter: new Map() };

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

    // Build the frontmatter lookup index.
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

    tmpState.byFrontmatter = byFrontmatter;
    tmpState.status = "ready";
    tmpState.lastBuiltAt = new Date().toISOString();
    setState(tmpState);
  } catch (e) {
    setState({
      ...makeEmpty(),
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function _resolveRefs(s: IndexState, refs: string[]): ResolveResult[] {
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

    if (s.byPath.has(working)) {
      return { ref, path: s.byPath.get(working)!.path, matched_by: "path", fragment, alias };
    }
    const withMd = working.endsWith(".md") ? working : working + ".md";
    if (s.byPath.has(withMd)) {
      return { ref, path: s.byPath.get(withMd)!.path, matched_by: "path", fragment, alias };
    }

    if (s.byJdId.has(working)) {
      return { ref, path: s.byJdId.get(working)!.path, matched_by: "jd-id", fragment, alias };
    }

    const bn = working.toLowerCase();
    const bnMatches = s.byBasename.get(bn);
    if (bnMatches?.length === 1) {
      return { ref, path: bnMatches[0].path, matched_by: "basename", fragment, alias };
    }
    if (bnMatches && bnMatches.length > 1) {
      return { ref, ambiguous: bnMatches.map((n) => n.path), fragment, alias };
    }

    const aliasMatches = s.byAlias.get(bn);
    if (aliasMatches?.length === 1) {
      return { ref, path: aliasMatches[0].path, matched_by: "alias", fragment, alias };
    }
    if (aliasMatches && aliasMatches.length > 1) {
      return { ref, ambiguous: aliasMatches.map((n) => n.path), fragment, alias };
    }

    return { ref, fragment, alias };
  });
}

function _getOutlinks(s: IndexState, notePath: string): OutlinkEntry[] {
  const note = s.byPath.get(notePath);
  if (!note) return [];
  return note.outlinks.map((ref) => {
    const r = _resolveRefs(s, [ref])[0];
    const entry: OutlinkEntry = { ref };
    if (r.path) entry.resolved_path = r.path;
    else if (r.ambiguous) entry.ambiguous_paths = r.ambiguous;
    return entry;
  });
}

// ── Module-level index operations (use module-level state) ────────────────────

/**
 * Build (or rebuild) the in-memory index from disk.
 */
export async function buildIndex(): Promise<void> {
  if (inFlightBuild) return inFlightBuild;
  inFlightBuild = enqueueMutation(() =>
    _doBuildIndex(vaultRoot(), (s) => { state = s; })
  );
  try {
    await inFlightBuild;
  } finally {
    inFlightBuild = null;
  }
}

export function indexStatus(): { status: IndexStatus; error?: string; count: number; last_built_at?: string } {
  return {
    status: state.status,
    error: state.error,
    count: state.notes.length,
    last_built_at: state.lastBuiltAt,
  };
}

/**
 * Obsidian-faithful resolution algorithm.
 */
export function resolveRefs(refs: string[]): ResolveResult[] {
  return _resolveRefs(state, refs);
}

export function getBacklinks(notePath: string): string[] {
  return state.backlinks.get(notePath) ?? [];
}

export function getOutlinks(notePath: string): OutlinkEntry[] {
  return _getOutlinks(state, notePath);
}

/**
 * Look up notes whose frontmatter has `property == value`.
 */
export function searchByFrontmatter(property: string, value: string): IndexedNote[] {
  const propMap = state.byFrontmatter.get(property.toLowerCase());
  if (!propMap) return [];
  return [...(propMap.get(value) ?? [])];
}

/**
 * Return the parsed frontmatter for a note from the in-memory index.
 */
export function getIndexedFrontmatter(notePath: string): Record<string, FrontmatterValue> | undefined {
  return state.byPath.get(notePath)?.frontmatter;
}

/**
 * Apply a single-file add/change event incrementally.
 */
export function applyAddOrChange(absPath: string): Promise<void> {
  return enqueueMutation(async () => {
    if (state.status !== "ready") return;
    let newNote: IndexedNote;
    try {
      newNote = await _parseNoteFromDisk(vaultRoot(), absPath);
    } catch {
      return;
    }
    const existing = state.byPath.get(newNote.path);
    if (existing) _removeFromForwardMaps(state, existing);
    _addToForwardMaps(state, newNote);
    _recomputeAllBacklinks(state);
    state.lastBuiltAt = new Date().toISOString();
  });
}

/**
 * Apply a single-file unlink event incrementally.
 */
export function applyUnlink(absPath: string): Promise<void> {
  return enqueueMutation(() => {
    if (state.status !== "ready") return;
    const root = vaultRoot();
    const relPath = path.relative(root, absPath).split(path.sep).join("/");
    const existing = state.byPath.get(relPath);
    if (!existing) return;
    _removeFromForwardMaps(state, existing);
    _recomputeAllBacklinks(state);
    state.lastBuiltAt = new Date().toISOString();
  });
}

// ── IndexStore class (per-instance, for FilesystemBackend) ────────────────────

/**
 * A self-contained in-memory index bound to a specific vault root.
 *
 * Each instance has its own state, mutation queue, and in-flight build promise.
 * The module-level singleton for the server uses the module-level functions above.
 * FilesystemBackend creates its own IndexStore instance.
 */
export class IndexStore {
  private readonly _vaultRoot: string;
  private _state: IndexState = makeEmpty();
  private _inFlightBuild: Promise<void> | null = null;
  private _mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(vaultRoot: string) {
    this._vaultRoot = vaultRoot;
  }

  private _enqueueMutation<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this._mutationQueue.then(
      () => work(),
      () => work()
    );
    this._mutationQueue = next.then(
      () => {},
      () => {}
    );
    return next as Promise<T>;
  }

  async buildIndex(): Promise<void> {
    if (this._inFlightBuild) return this._inFlightBuild;
    this._inFlightBuild = this._enqueueMutation(() =>
      _doBuildIndex(this._vaultRoot, (s) => { this._state = s; })
    );
    try {
      await this._inFlightBuild;
    } finally {
      this._inFlightBuild = null;
    }
  }

  indexStatus(): { status: IndexStatus; error?: string; count: number; last_built_at?: string } {
    return {
      status: this._state.status,
      error: this._state.error,
      count: this._state.notes.length,
      last_built_at: this._state.lastBuiltAt,
    };
  }

  resolveRefs(refs: string[]): ResolveResult[] {
    return _resolveRefs(this._state, refs);
  }

  getBacklinks(notePath: string): string[] {
    return this._state.backlinks.get(notePath) ?? [];
  }

  getOutlinks(notePath: string): OutlinkEntry[] {
    return _getOutlinks(this._state, notePath);
  }

  searchByFrontmatter(property: string, value: string): IndexedNote[] {
    const propMap = this._state.byFrontmatter.get(property.toLowerCase());
    if (!propMap) return [];
    return [...(propMap.get(value) ?? [])];
  }

  parseAllFrontmatter(text: string): Record<string, FrontmatterValue> {
    return parseAllFrontmatter(text);
  }

  parseOutlinks(text: string): string[] {
    return parseOutlinks(text);
  }

  applyAddOrChange(absPath: string): Promise<void> {
    return this._enqueueMutation(async () => {
      if (this._state.status !== "ready") return;
      let newNote: IndexedNote;
      try {
        newNote = await _parseNoteFromDisk(this._vaultRoot, absPath);
      } catch {
        return;
      }
      const existing = this._state.byPath.get(newNote.path);
      if (existing) _removeFromForwardMaps(this._state, existing);
      _addToForwardMaps(this._state, newNote);
      _recomputeAllBacklinks(this._state);
      this._state.lastBuiltAt = new Date().toISOString();
    });
  }

  applyUnlink(absPath: string): Promise<void> {
    return this._enqueueMutation(() => {
      if (this._state.status !== "ready") return;
      const relPath = path.relative(this._vaultRoot, absPath).split(path.sep).join("/");
      const existing = this._state.byPath.get(relPath);
      if (!existing) return;
      _removeFromForwardMaps(this._state, existing);
      _recomputeAllBacklinks(this._state);
      this._state.lastBuiltAt = new Date().toISOString();
    });
  }
}
