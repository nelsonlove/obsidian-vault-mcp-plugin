import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import type {
  FrontmatterScalar,
  FrontmatterEditValue,
  NoteRef,
  SearchHit,
  SearchMode,
  PatchAnchor,
  PatchOp,
} from "../vault-backend.js";

/**
 * All filesystem access for the vault goes through this module so that
 * path-traversal safety and the "ignore these folders" policy live in ONE place.
 *
 * The module-level exports use a singleton VaultImpl over VAULT_ROOT (set from
 * VAULT_PATH env at module load). The `createVaultAt(root)` factory returns a
 * fresh VaultImpl bound to a custom root — used by FilesystemBackend for
 * per-instance vault roots without touching the module-level singleton.
 */

// Folders we never traverse or expose.
const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

// Cap on bytes we'll return for a single note / total search payload, to protect
// the agent's context window. Tune as needed.
export const CHARACTER_LIMIT = 100_000;

// Re-export shared types for callers that imported from vault.ts before
// these types moved to vault-backend.ts.
export type { FrontmatterScalar, FrontmatterEditValue, NoteRef, SearchHit, SearchMode, PatchAnchor, PatchOp };

// ── Frontmatter editing helpers ──────────────────────────────────────────────
//
// Line-based, surgical edits — only the lines we touch get rewritten, so
// other keys' indentation, quoting style, and inter-line spacing are
// preserved. Handles two key shapes:
//
//   - inline scalar/flow:  `key: value`  or  `key: [a, b]`
//   - block array:         `key:\n  - a\n  - b`
//
// More exotic shapes (block scalars `|`/`>`, nested objects, multi-line
// quoted strings) are surfaced as errors rather than silently corrupted.

// Fixed pattern that matches "<ident>: <rest>" lines.
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_\-]*):\s*(.*?)\s*$/;

function needsQuoting(s: string): boolean {
  return /[,:#&*!|>'"%@`{}[\]]|^\s|\s$/.test(s);
}

function serializeScalar(v: FrontmatterScalar): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (needsQuoting(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

function serializeBlockArray(key: string, items: FrontmatterScalar[]): string {
  if (items.length === 0) return `${key}: []`;
  return `${key}:\n` + items.map((v) => `  - ${serializeScalar(v)}`).join("\n");
}

function serializeKey(key: string, value: FrontmatterEditValue): string {
  if (Array.isArray(value)) return serializeBlockArray(key, value);
  return `${key}: ${serializeScalar(value)}`;
}

interface FrontmatterRegion {
  match: RegExpMatchArray | null;
  body: string;
  before: string;
  after: string;
}

function locateFrontmatter(text: string): FrontmatterRegion {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { match: null, body: "", before: "", after: text };
  }
  return {
    match,
    body: match[1],
    before: "",
    after: text.slice(match[0].length),
  };
}

function reassemble(region: FrontmatterRegion, newBody: string): string {
  const afterNorm = region.after.startsWith("\n") ? region.after.slice(1) : region.after;
  return `${region.before}---\n${newBody}\n---\n${afterNorm}`;
}

function findKeyRange(lines: string[], key: string): { start: number; end: number } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE_RE);
    if (!m || m[1] !== key) continue;
    const rawValue = m[2];
    if (rawValue === "") {
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        j++;
      }
      if (j > i + 1) return { start: i, end: j };
      if (j < lines.length && /^\s+\S/.test(lines[j])) {
        throw new Error(
          `Refusing to edit '${key}': value appears to be a nested mapping (indented continuation lines). ` +
          `Only inline scalar, inline-array, and block-array shapes are supported.`
        );
      }
      return { start: i, end: i + 1 };
    }
    if (rawValue === "|" || rawValue === ">" || rawValue.startsWith("|") || rawValue.startsWith(">")) {
      throw new Error(`Refusing to edit '${key}': block scalar (|/>) shape not supported.`);
    }
    if (rawValue.startsWith("{")) {
      throw new Error(`Refusing to edit '${key}': inline-flow object shape not supported.`);
    }
    return { start: i, end: i + 1 };
  }
  return undefined;
}

function parseSingleKeyFromLines(
  lines: string[],
  key: string,
  range: { start: number; end: number }
): FrontmatterEditValue | undefined {
  const m = lines[range.start].match(KEY_LINE_RE);
  if (!m || m[1] !== key) return undefined;
  const rawValue = m[2];
  if (rawValue === "") {
    const items: string[] = [];
    for (let i = range.start + 1; i < range.end; i++) {
      const bm = lines[i].match(/^\s+-\s*(.*?)\s*$/);
      if (bm) items.push(bm[1].replace(/^['"]|['"]$/g, ""));
    }
    return items.length > 0 ? items : "";
  }
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    return parseInlineArray(rawValue.slice(1, -1));
  }
  return coerceScalarValue(rawValue);
}

function parseInlineArray(inner: string): string[] {
  const out: string[] = [];
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
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += c;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

function coerceScalarValue(raw: string): FrontmatterScalar {
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

// ── Anchor-based patching ────────────────────────────────────────────────────

const HEADING_LINE_RE = /^(#{1,6})\s+(.+?)\s*$/;

function findHeadingSection(lines: string[], headingText: string): { start: number; end: number } | undefined {
  let headingIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_LINE_RE);
    if (m && m[2] === headingText) {
      headingIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (headingIdx === -1) return undefined;
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(HEADING_LINE_RE);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start: headingIdx + 1, end };
}

function findBlock(lines: string[], blockId: string): { start: number; end: number } | undefined {
  const token = "^" + blockId;
  let anchorLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(token);
    if (idx === -1) continue;
    const next = lines[i].charAt(idx + token.length);
    if (next !== "" && !/\s/.test(next)) continue;
    anchorLine = i;
    break;
  }
  if (anchorLine === -1) return undefined;
  let start = anchorLine;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = anchorLine;
  while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
  return { start, end: end + 1 };
}

// Match an outbound wikilink token in markdown.
const WIKILINK_TOKEN_RE = /\[\[([^\]|#^]+?)((?:[|#^][^\]]*)?)\]\]/g;

async function walkDir(dir: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walkDir(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      acc.push(path.join(dir, entry.name));
    }
  }
}

/**
 * Decode HTML entities in path-like arguments before they hit `resolveInVault`.
 *
 * Why this exists: some MCP clients (observed in Claude's web/mobile UI) HTML-
 * escape special characters in tool-call arguments before sending — so a
 * subdir like `03 LLMs & agents` arrives at the server as `03 LLMs &amp; agents`,
 * which never matches a real folder. Defensively decode the common entities so
 * agents can pass the natural form. Covers `&amp; &lt; &gt; &quot; &apos;` and
 * numeric `&#NN;` / `&#xNN;` escapes — the set actually seen in practice; not a
 * full HTML entity table.
 */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // last: don't unescape "&amp;amp;" twice
}

/**
 * All vault filesystem operations, bound to a specific vault root.
 *
 * The module exports a default instance (`_impl`) over VAULT_ROOT. Use
 * `createVaultAt(root)` to get a fresh instance bound to a different root —
 * that is what FilesystemBackend uses for per-instance vault roots.
 *
 * Per-process singleton note: the module-level `realRootCache` from the
 * original design is now per-instance (a private field), so multiple
 * VaultImpl instances in the same process each cache their own realpath.
 */
class VaultImpl {
  private realRootCache: string | null = null;

  constructor(readonly root: string) {}

  private realVaultRoot(): string {
    if (this.realRootCache) return this.realRootCache;
    try {
      this.realRootCache = realpathSync(this.root);
      return this.realRootCache;
    } catch {
      return this.root;
    }
  }

  /**
   * Refuse paths whose on-disk resolution (following symlinks) lands outside
   * the vault root. For not-yet-existing paths, walk up to the deepest
   * existing ancestor and check THAT — catching writes routed through a
   * symlinked directory.
   */
  private assertNoSymlinkEscape(abs: string, relPath: string): void {
    let probe = abs;
    for (;;) {
      let real: string;
      try {
        real = realpathSync(probe);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          if (probe === this.root) return;
          probe = path.dirname(probe);
          continue;
        }
        throw e;
      }
      const root = this.realVaultRoot();
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (real !== root && !real.startsWith(rootWithSep)) {
        throw new Error(`Path escapes the vault root via symlink: '${relPath}'`);
      }
      return;
    }
  }

  /**
   * Resolve a vault-relative path to an absolute path, refusing anything that
   * escapes the vault root (e.g. "../../etc/passwd"), follows a symlink out of
   * it, or hits an ignored folder.
   */
  resolveInVault(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const abs = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new Error(`Path escapes the vault root: '${relPath}'`);
    }
    const segments = path.relative(this.root, abs).split(path.sep);
    if (segments.some((s) => IGNORED_DIRS.has(s))) {
      throw new Error(`Path touches an ignored folder: '${relPath}'`);
    }
    this.assertNoSymlinkEscape(abs, relPath);
    return abs;
  }

  private toRelative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  async listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number
  ): Promise<{ total: number; notes: NoteRef[] }> {
    const base = subdir ? this.resolveInVault(subdir) : this.root;
    const found: string[] = [];
    await walkDir(base, found);
    found.sort();
    const page = found.slice(offset, offset + limit).map((abs) => ({ path: this.toRelative(abs) }));
    return { total: found.length, notes: page };
  }

  async readNote(relPath: string): Promise<string> {
    const abs = this.resolveInVault(relPath);
    const content = await fs.readFile(abs, "utf8");
    if (content.length > CHARACTER_LIMIT) {
      return (
        content.slice(0, CHARACTER_LIMIT) +
        `\n\n[truncated: note is ${content.length} chars, showing first ${CHARACTER_LIMIT}]`
      );
    }
    return content;
  }

  async writeNote(
    relPath: string,
    content: string,
    overwrite: boolean
  ): Promise<{ path: string; created: boolean }> {
    const abs = this.resolveInVault(relPath);
    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("Note path must end in .md");
    }
    let existed = true;
    try {
      await fs.access(abs);
    } catch {
      existed = false;
    }
    if (existed && !overwrite) {
      throw new Error(`Note already exists: '${relPath}'. Set overwrite=true to replace it.`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { path: this.toRelative(abs), created: !existed };
  }

  async appendNote(
    relPath: string,
    content: string
  ): Promise<{ path: string; created: boolean }> {
    const abs = this.resolveInVault(relPath);
    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("Note path must end in .md");
    }
    let existed = true;
    try {
      await fs.access(abs);
    } catch {
      existed = false;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const prefix = existed ? "\n" : "";
    await fs.appendFile(abs, prefix + content, "utf8");
    return { path: this.toRelative(abs), created: !existed };
  }

  async searchNotes(
    query: string,
    limit: number,
    mode: SearchMode = "one_per_note"
  ): Promise<SearchHit[]> {
    const found: string[] = [];
    await walkDir(this.root, found);
    found.sort();
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    outer: for (const abs of found) {
      if (hits.length >= limit) break;
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: this.toRelative(abs), line: i + 1, snippet: lines[i].trim().slice(0, 300) });
          if (hits.length >= limit) break outer;
          if (mode === "one_per_note") break;
        }
      }
    }
    return hits;
  }

  async listFolders(
    subdir: string | undefined
  ): Promise<Array<{ path: string; note_count: number }>> {
    const baseAbs = subdir ? this.resolveInVault(subdir) : this.root;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(baseAbs, { withFileTypes: true });
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOTDIR") {
        throw new Error(`Not a directory: '${subdir ?? "."}'`);
      }
      if (code === "ENOENT") {
        throw new Error(`Folder does not exist: '${subdir ?? "."}'`);
      }
      throw e;
    }
    const folders: Array<{ path: string; note_count: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (["node_modules"].includes(entry.name)) continue;
      const childAbs = path.join(baseAbs, entry.name);
      const counter: string[] = [];
      await walkDir(childAbs, counter);
      folders.push({
        path: this.toRelative(childAbs),
        note_count: counter.length,
      });
    }
    folders.sort((a, b) => a.path.localeCompare(b.path));
    return folders;
  }

  async findByTag(tag: string, limit: number): Promise<NoteRef[]> {
    const wanted = tag.replace(/^#/, "").toLowerCase();
    const found: string[] = [];
    await walkDir(this.root, found);
    found.sort();
    const out: NoteRef[] = [];
    for (const abs of found) {
      if (out.length >= limit) break;
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const tags = extractTags(text);
      if ([...tags].some((t) => t.toLowerCase() === wanted)) {
        out.push({ path: this.toRelative(abs) });
      }
    }
    return out;
  }

  async setFrontmatterField(
    relPath: string,
    key: string,
    value: FrontmatterEditValue
  ): Promise<{ previous: FrontmatterEditValue | undefined; created_frontmatter: boolean }> {
    const abs = this.resolveInVault(relPath);
    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("Note path must end in .md");
    }
    const text = await fs.readFile(abs, "utf8");
    const region = locateFrontmatter(text);
    const serialized = serializeKey(key, value);

    if (!region.match) {
      const newText = `---\n${serialized}\n---\n\n${text}`;
      await fs.writeFile(abs, newText, "utf8");
      return { previous: undefined, created_frontmatter: true };
    }

    const lines = region.body.split("\n");
    const range = findKeyRange(lines, key);

    let previous: FrontmatterEditValue | undefined;
    if (range) {
      previous = parseSingleKeyFromLines(lines, key, range);
      lines.splice(range.start, range.end - range.start, ...serialized.split("\n"));
    } else {
      if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(...serialized.split("\n"));
    }
    await fs.writeFile(abs, reassemble(region, lines.join("\n")), "utf8");
    return { previous, created_frontmatter: false };
  }

  async deleteFrontmatterField(
    relPath: string,
    key: string
  ): Promise<{ previous: FrontmatterEditValue | undefined; existed: boolean }> {
    const abs = this.resolveInVault(relPath);
    const text = await fs.readFile(abs, "utf8");
    const region = locateFrontmatter(text);
    if (!region.match) return { previous: undefined, existed: false };
    const lines = region.body.split("\n");
    const range = findKeyRange(lines, key);
    if (!range) return { previous: undefined, existed: false };
    const previous = parseSingleKeyFromLines(lines, key, range);
    lines.splice(range.start, range.end - range.start);
    await fs.writeFile(abs, reassemble(region, lines.join("\n")), "utf8");
    return { previous, existed: true };
  }

  async getFrontmatterField(
    relPath: string,
    key: string
  ): Promise<FrontmatterEditValue | undefined> {
    const abs = this.resolveInVault(relPath);
    const text = await fs.readFile(abs, "utf8");
    const region = locateFrontmatter(text);
    if (!region.match) return undefined;
    const lines = region.body.split("\n");
    const range = findKeyRange(lines, key);
    if (!range) return undefined;
    return parseSingleKeyFromLines(lines, key, range);
  }

  async patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    const abs = this.resolveInVault(relPath);
    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("Note path must end in .md");
    }
    const text = await fs.readFile(abs, "utf8");

    const fmMatch = text.match(/^---\n[\s\S]*?\n---\n?/);
    const fmText = fmMatch ? fmMatch[0] : "";
    const body = fmMatch ? text.slice(fmMatch[0].length) : text;
    const bodyLines = body.split("\n");

    const range =
      anchor.type === "heading"
        ? findHeadingSection(bodyLines, anchor.value)
        : findBlock(bodyLines, anchor.value);

    if (!range) {
      return { found: false, anchor, op };
    }

    const previous = bodyLines.slice(range.start, range.end).join("\n");
    const insert = content.split("\n");

    let newBodyLines: string[];
    if (op === "replace") {
      newBodyLines = [
        ...bodyLines.slice(0, range.start),
        ...insert,
        ...bodyLines.slice(range.end),
      ];
    } else if (op === "prepend") {
      newBodyLines = [
        ...bodyLines.slice(0, range.start),
        ...insert,
        ...bodyLines.slice(range.start),
      ];
    } else {
      newBodyLines = [
        ...bodyLines.slice(0, range.end),
        ...insert,
        ...bodyLines.slice(range.end),
      ];
    }

    await fs.writeFile(abs, fmText + newBodyLines.join("\n"), "utf8");
    return { found: true, anchor, op, previous };
  }

  async deleteNote(
    relPath: string,
    confirm: true
  ): Promise<{ path: string; deleted: true }> {
    if (confirm !== true) {
      throw new Error("delete_note requires confirm: true");
    }
    const abs = this.resolveInVault(relPath);
    if (!relPath.toLowerCase().endsWith(".md")) {
      throw new Error("Note path must end in .md");
    }
    await fs.unlink(abs);
    return { path: relPath, deleted: true };
  }

  async moveNote(
    fromRel: string,
    toRel: string,
    options: {
      update_backlinks: boolean;
      overwrite: boolean;
      /** Callback to walk the backlinks index; injected so vault.ts doesn't
       * depend on index-store.ts. */
      backlinks_provider: (path: string) => string[];
      /** Callback that resolves a ref to a path via the index. */
      resolve_ref: (ref: string) => string | undefined;
    }
  ): Promise<{ from: string; to: string; backlinks_updated: number; backlinks_files_touched: number }> {
    const absFrom = this.resolveInVault(fromRel);
    const absTo = this.resolveInVault(toRel);
    if (!toRel.toLowerCase().endsWith(".md")) {
      throw new Error("Destination path must end in .md");
    }
    // Compare resolved absolute paths so `./Folder/note.md` vs `Folder/note.md`
    // is caught as the same-path case rather than silently no-op'ing in rename.
    if (absFrom === absTo) {
      throw new Error("'from' and 'to' resolve to the same path");
    }

    let toExists = true;
    try {
      await fs.access(absTo);
    } catch {
      toExists = false;
    }
    if (toExists && !options.overwrite) {
      throw new Error(`Destination '${toRel}' already exists. Pass overwrite: true to replace.`);
    }

    // Rename FIRST, then rewrite backlinks.
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);

    let backlinksUpdated = 0;
    let backlinksFilesTouched = 0;
    if (options.update_backlinks) {
      const result = await rewriteBacklinks(
        this,
        fromRel,
        toRel,
        options.backlinks_provider,
        options.resolve_ref
      );
      backlinksUpdated = result.refs_rewritten;
      backlinksFilesTouched = result.files_touched;
    }

    return {
      from: fromRel,
      to: toRel,
      backlinks_updated: backlinksUpdated,
      backlinks_files_touched: backlinksFilesTouched,
    };
  }
}

// ── Pure helper: extract tags from note content ───────────────────────────────

function extractTags(text: string): Set<string> {
  const tags = new Set<string>();
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const tagLine = fm.match(/^tags:\s*(.*)$/m);
    if (tagLine) {
      const inline = tagLine[1].trim();
      if (inline.startsWith("[")) {
        inline
          .replace(/[[\]]/g, "")
          .split(",")
          .forEach((t) => t.trim() && tags.add(t.trim().replace(/^['"]|['"]$/g, "")));
      } else if (inline) {
        tags.add(inline.replace(/^['"]|['"]$/g, ""));
      }
    }
    // YAML list form: "tags:\n  - foo\n  - bar"
    const listForm = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (listForm) {
      listForm[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean)
        .forEach((t) => tags.add(t.replace(/^['"]|['"]$/g, "")));
    }
  }
  for (const m of text.matchAll(/(?:^|\s)#([A-Za-z0-9_\-/]+)/g)) {
    tags.add(m[1]);
  }
  return tags;
}

// ── Pure helper: rewrite backlinks ────────────────────────────────────────────

async function rewriteBacklinks(
  vault: VaultImpl,
  fromRel: string,
  toRel: string,
  backlinksProvider: (path: string) => string[],
  resolveRef: (ref: string) => string | undefined
): Promise<{ refs_rewritten: number; files_touched: number }> {
  const sources = backlinksProvider(fromRel);
  if (sources.length === 0) return { refs_rewritten: 0, files_touched: 0 };

  const fromPathNoExt = fromRel.replace(/\.md$/i, "");
  const toBasename = path.basename(toRel, ".md");
  const toPathNoExt = toRel.replace(/\.md$/i, "");

  let totalRewrites = 0;
  let filesTouched = 0;

  for (const src of sources) {
    let absSrc: string;
    try {
      absSrc = vault.resolveInVault(src);
    } catch {
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(absSrc, "utf8");
    } catch {
      continue;
    }

    let changed = false;
    const next = text.replace(WIKILINK_TOKEN_RE, (match, target: string, suffix: string) => {
      const trimmed = target.trim();
      // Only rewrite if this ref currently resolves to the from-note.
      const resolved = resolveRef(trimmed);
      if (resolved !== fromRel) return match;
      // Preserve shape: full path with ext → use new full path with ext;
      // full path without ext → use new path without ext; otherwise basename.
      let newTarget: string;
      if (trimmed === fromRel) newTarget = toRel;
      else if (trimmed === fromPathNoExt) newTarget = toPathNoExt;
      else newTarget = toBasename;
      changed = true;
      totalRewrites++;
      return `[[${newTarget}${suffix || ""}]]`;
    });

    if (changed) {
      await fs.writeFile(absSrc, next, "utf8");
      filesTouched++;
    }
  }
  return { refs_rewritten: totalRewrites, files_touched: filesTouched };
}

// ── Module-level singleton (process.env.VAULT_PATH) ──────────────────────────

const VAULT_ROOT = path.resolve(process.env.VAULT_PATH ?? "./vault");
const _impl = new VaultImpl(VAULT_ROOT);

// ── Module-level exports (backward compat for server imports) ─────────────────

export function vaultRoot(): string {
  return _impl.root;
}

export function resolveInVault(relPath: string): string {
  return _impl.resolveInVault(relPath);
}

export async function listNotes(
  subdir: string | undefined,
  limit: number,
  offset: number
): Promise<{ total: number; notes: NoteRef[] }> {
  return _impl.listNotes(subdir, limit, offset);
}

export async function readNote(relPath: string): Promise<string> {
  return _impl.readNote(relPath);
}

export async function writeNote(
  relPath: string,
  content: string,
  overwrite: boolean
): Promise<{ path: string; created: boolean }> {
  return _impl.writeNote(relPath, content, overwrite);
}

export async function appendNote(
  relPath: string,
  content: string
): Promise<{ path: string; created: boolean }> {
  return _impl.appendNote(relPath, content);
}

export async function searchNotes(
  query: string,
  limit: number,
  mode: SearchMode = "one_per_note"
): Promise<SearchHit[]> {
  return _impl.searchNotes(query, limit, mode);
}

export async function listFolders(
  subdir: string | undefined
): Promise<Array<{ path: string; note_count: number }>> {
  return _impl.listFolders(subdir);
}

export async function findByTag(tag: string, limit: number): Promise<NoteRef[]> {
  return _impl.findByTag(tag, limit);
}

export async function setFrontmatterField(
  relPath: string,
  key: string,
  value: FrontmatterEditValue
): Promise<{ previous: FrontmatterEditValue | undefined; created_frontmatter: boolean }> {
  return _impl.setFrontmatterField(relPath, key, value);
}

export async function deleteFrontmatterField(
  relPath: string,
  key: string
): Promise<{ previous: FrontmatterEditValue | undefined; existed: boolean }> {
  return _impl.deleteFrontmatterField(relPath, key);
}

export async function getFrontmatterField(
  relPath: string,
  key: string
): Promise<FrontmatterEditValue | undefined> {
  return _impl.getFrontmatterField(relPath, key);
}

export async function patchNote(
  relPath: string,
  anchor: PatchAnchor,
  op: PatchOp,
  content: string
): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
  return _impl.patchNote(relPath, anchor, op, content);
}

export async function deleteNote(
  relPath: string,
  confirm: true
): Promise<{ path: string; deleted: true }> {
  return _impl.deleteNote(relPath, confirm);
}

export async function moveNote(
  fromRel: string,
  toRel: string,
  options: {
    update_backlinks: boolean;
    overwrite: boolean;
    backlinks_provider: (path: string) => string[];
    resolve_ref: (ref: string) => string | undefined;
  }
): Promise<{ from: string; to: string; backlinks_updated: number; backlinks_files_touched: number }> {
  return _impl.moveNote(fromRel, toRel, options);
}

// ── Per-instance factory ──────────────────────────────────────────────────────

/**
 * Create a VaultImpl bound to a custom vault root.
 * Used by FilesystemBackend for per-instance vault roots without affecting
 * the module-level singleton.
 */
export function createVaultAt(root: string): VaultImpl {
  return new VaultImpl(root);
}

export type { VaultImpl };
