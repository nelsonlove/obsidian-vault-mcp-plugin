import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

/**
 * All filesystem access for the vault goes through this module so that
 * path-traversal safety and the "ignore these folders" policy live in ONE place.
 */

const VAULT_ROOT = path.resolve(process.env.VAULT_PATH ?? "./vault");

// Folders we never traverse or expose.
const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

// Cap on bytes we'll return for a single note / total search payload, to protect
// the agent's context window. Tune as needed.
export const CHARACTER_LIMIT = 100_000;

export function vaultRoot(): string {
  return VAULT_ROOT;
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

export type FrontmatterScalar = string | number | boolean;
export type FrontmatterEditValue = FrontmatterScalar | FrontmatterScalar[];

// Fixed pattern that matches "<ident>: <rest>" lines. The key is captured as a
// plain string and compared with `===` to the caller's key — we never inject
// user input into a RegExp pattern, so there's no ReDoS surface here.
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_\-]*):\s*(.*?)\s*$/;

function needsQuoting(s: string): boolean {
  // Quote on commas, leading/trailing whitespace, or any YAML-significant char.
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
  /** Whole `---\n…\n---\n?` block matched in the source, or null if absent. */
  match: RegExpMatchArray | null;
  /** The frontmatter body (between the delimiters), or "" if absent. */
  body: string;
  /** The text up to but not including the opening `---`, or full text if absent. */
  before: string;
  /** The text after the closing `---` (and trailing newline if present). */
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
  // `region.after` is the text following the matched closing `---\n?`. We
  // always emit our own `---\n` after the body, so strip ONE leading newline
  // from `after` if present to avoid inserting a stray blank line on every
  // write — reviewer-flagged: prior dead-branch ternary intended this but
  // never applied it, so files with `---\n\n<body>` grew an extra blank line
  // on each set/delete.
  const afterNorm = region.after.startsWith("\n") ? region.after.slice(1) : region.after;
  return `${region.before}---\n${newBody}\n---\n${afterNorm}`;
}

/**
 * Find the line range (inclusive start, exclusive end) occupied by `key`
 * in the frontmatter body's lines. Throws if the key uses a shape we
 * don't know how to edit safely (block scalar, nested object).
 */
function findKeyRange(lines: string[], key: string): { start: number; end: number } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE_RE);
    if (!m || m[1] !== key) continue;
    const rawValue = m[2];
    if (rawValue === "") {
      // Block — consume indented `- …` continuation lines.
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        j++;
      }
      if (j > i + 1) return { start: i, end: j };
      // No block-array items. Before claiming an empty range, look at the
      // very next line: if it's indented and NOT a block-array item, the
      // value is a nested mapping (`key:\n  nested: val`) which our line-
      // based editor can't safely rewrite. Refuse rather than orphan the
      // continuation on splice. Reviewer-flagged.
      if (j < lines.length && /^\s+\S/.test(lines[j])) {
        throw new Error(
          `Refusing to edit '${key}': value appears to be a nested mapping (indented continuation lines). ` +
          `Only inline scalar, inline-array, and block-array shapes are supported.`
        );
      }
      // Empty value, no block, no nested mapping → single empty key line.
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

export async function setFrontmatterField(
  relPath: string,
  key: string,
  value: FrontmatterEditValue
): Promise<{ previous: FrontmatterEditValue | undefined; created_frontmatter: boolean }> {
  const abs = resolveInVault(relPath);
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new Error("Note path must end in .md");
  }
  const text = await fs.readFile(abs, "utf8");
  const region = locateFrontmatter(text);

  const serialized = serializeKey(key, value);

  if (!region.match) {
    // No frontmatter at all — create one.
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

export async function deleteFrontmatterField(
  relPath: string,
  key: string
): Promise<{ previous: FrontmatterEditValue | undefined; existed: boolean }> {
  const abs = resolveInVault(relPath);
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

export async function getFrontmatterField(
  relPath: string,
  key: string
): Promise<FrontmatterEditValue | undefined> {
  const abs = resolveInVault(relPath);
  const text = await fs.readFile(abs, "utf8");
  const region = locateFrontmatter(text);
  if (!region.match) return undefined;
  const lines = region.body.split("\n");
  const range = findKeyRange(lines, key);
  if (!range) return undefined;
  return parseSingleKeyFromLines(lines, key, range);
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
    // Block array
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
//
// Surgical edits relative to a heading or block-reference anchor — modeled
// after MarkusPfundstein/mcp-obsidian's `patch_content`. Three operations:
//
//   - `replace`:  swap the anchor's content for `content`
//   - `prepend`:  insert before the anchor's content
//   - `append`:   insert after the anchor's content
//
// Anchor types:
//
//   - `heading`: matches the first `# … # heading text` line whose trailing
//      text equals `anchor` exactly. The "content" is the section body —
//      every line from after the heading line up to the next heading at
//      equal or higher level (or EOF). The heading line ITSELF is preserved.
//
//   - `block`:   matches the first paragraph whose final token is `^<id>`.
//      The "content" is the entire paragraph (lines from the prior blank
//      line up to the next blank line).
//
// No RegExp is constructed from user input — search uses string equality
// for headings and `String.prototype.indexOf` for block tokens.

export type PatchAnchor =
  | { type: "heading"; value: string }
  | { type: "block"; value: string };

export type PatchOp = "append" | "prepend" | "replace";

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
    // Token is complete only when followed by whitespace or end of line.
    // Avoids matching `^abc` inside a longer token like `^abcde`.
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

export async function patchNote(
  relPath: string,
  anchor: PatchAnchor,
  op: PatchOp,
  content: string
): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
  const abs = resolveInVault(relPath);
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

// ── Delete and move ──────────────────────────────────────────────────────────
//
// Mutating ops with sync-side implications. The Obsidian Sync deletion
// disaster (2026-06-04) shaped two design choices here:
//
//   1. `delete_note` requires an explicit `confirm: true` flag. Schema
//      validation rejects calls without it — no "fat finger from the agent"
//      gets through.
//   2. `move_note` keeps backlink rewriting optional but defaulted ON. The
//      backlinks index is built at startup; rewriting walks only the source
//      notes the index already knows link to `from`. No vault-wide scan.

export async function deleteNote(
  relPath: string,
  confirm: true
): Promise<{ path: string; deleted: true }> {
  if (confirm !== true) {
    throw new Error("delete_note requires confirm: true");
  }
  const abs = resolveInVault(relPath);
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new Error("Note path must end in .md");
  }
  await fs.unlink(abs);
  return { path: relPath, deleted: true };
}

export async function moveNote(
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
  const absFrom = resolveInVault(fromRel);
  const absTo = resolveInVault(toRel);
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

  // Rename FIRST, then rewrite backlinks. Reviewer-flagged: if the rewrite
  // ran first and the rename failed, source notes would end up with refs
  // pointing at a path that doesn't exist, with no rollback. The reversed
  // order means a post-rename rewrite failure leaves refs pointing at the
  // OLD basename — which now doesn't resolve, but is visible-to-the-user
  // and re-runnable. Better failure direction.
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);

  let backlinksUpdated = 0;
  let backlinksFilesTouched = 0;
  if (options.update_backlinks) {
    const result = await rewriteBacklinks(fromRel, toRel, options.backlinks_provider, options.resolve_ref);
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

// Match an outbound wikilink token in markdown: `[[target]]`, `[[target|alias]]`,
// `[[target#heading]]`, `[[target#^block]]`. The capture for `target` excludes
// the alias/fragment delimiters; the second capture preserves whatever follows.
const WIKILINK_TOKEN_RE = /\[\[([^\]|#^]+?)((?:[|#^][^\]]*)?)\]\]/g;

async function rewriteBacklinks(
  fromRel: string,
  toRel: string,
  backlinksProvider: (path: string) => string[],
  resolveRef: (ref: string) => string | undefined
): Promise<{ refs_rewritten: number; files_touched: number }> {
  const sources = backlinksProvider(fromRel);
  if (sources.length === 0) return { refs_rewritten: 0, files_touched: 0 };

  // Pre-compute ref shapes so we can preserve the visual style of each rewrite
  // — bare basename refs stay bare, path-ish refs stay path-ish.
  const fromPathNoExt = fromRel.replace(/\.md$/i, "");
  const toBasename = path.basename(toRel, ".md");
  const toPathNoExt = toRel.replace(/\.md$/i, "");

  let totalRewrites = 0;
  let filesTouched = 0;

  for (const src of sources) {
    let absSrc: string;
    try {
      absSrc = resolveInVault(src);
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
      // resolveRefs returns undefined for ambiguous matches — those stay put
      // because we don't know which note the author meant.
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

// The vault root's own real path, for symlink-containment comparison. The
// root may legitimately sit behind a symlink (macOS tmpdirs live under
// /var → /private/var), so the lexical VAULT_ROOT can't be compared against
// realpath() output directly. Cached on first success only — on a cold boot
// where the root doesn't exist yet we fall back without caching so a later
// call re-resolves. Per-process singleton: never invalidated, so tests that
// want a DIFFERENT vault root need a fresh process (node --test gives each
// test file its own), not a re-set of process.env.VAULT_PATH.
let realRootCache: string | null = null;
function realVaultRoot(): string {
  if (realRootCache) return realRootCache;
  try {
    realRootCache = realpathSync(VAULT_ROOT);
    return realRootCache;
  } catch {
    return VAULT_ROOT;
  }
}

/**
 * Refuse paths whose on-disk resolution (following symlinks) lands outside
 * the vault root. The lexical prefix check in `resolveInVault` can't see
 * symlinks — a `link.md → /etc/passwd` planted inside the vault would pass
 * it. For not-yet-existing paths (writeNote creates files and parent dirs),
 * walk up to the deepest existing ancestor and check THAT — catching writes
 * routed through a symlinked directory.
 */
function assertNoSymlinkEscape(abs: string, relPath: string): void {
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT: component doesn't exist yet. ENOTDIR: a component resolves
      // to a file (e.g. a path THROUGH a symlinked file) — keep walking up
      // so the offending component itself gets realpath'd and checked.
      if (code === "ENOENT" || code === "ENOTDIR") {
        if (probe === VAULT_ROOT) return; // root itself absent — nothing on disk to escape through
        probe = path.dirname(probe);
        continue;
      }
      throw e;
    }
    const root = realVaultRoot();
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
export function resolveInVault(relPath: string): string {
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = path.resolve(VAULT_ROOT, normalized);
  const rootWithSep = VAULT_ROOT.endsWith(path.sep) ? VAULT_ROOT : VAULT_ROOT + path.sep;
  if (abs !== VAULT_ROOT && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path escapes the vault root: '${relPath}'`);
  }
  const segments = path.relative(VAULT_ROOT, abs).split(path.sep);
  if (segments.some((s) => IGNORED_DIRS.has(s))) {
    throw new Error(`Path touches an ignored folder: '${relPath}'`);
  }
  assertNoSymlinkEscape(abs, relPath);
  return abs;
}

function toRelative(abs: string): string {
  return path.relative(VAULT_ROOT, abs).split(path.sep).join("/");
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      acc.push(path.join(dir, entry.name));
    }
  }
}

export interface NoteRef {
  path: string;
}

export async function listNotes(
  subdir: string | undefined,
  limit: number,
  offset: number
): Promise<{ total: number; notes: NoteRef[] }> {
  const base = subdir ? resolveInVault(subdir) : VAULT_ROOT;
  const found: string[] = [];
  await walk(base, found);
  found.sort();
  const page = found.slice(offset, offset + limit).map((abs) => ({ path: toRelative(abs) }));
  return { total: found.length, notes: page };
}

export async function readNote(relPath: string): Promise<string> {
  const abs = resolveInVault(relPath);
  const content = await fs.readFile(abs, "utf8");
  if (content.length > CHARACTER_LIMIT) {
    return (
      content.slice(0, CHARACTER_LIMIT) +
      `\n\n[truncated: note is ${content.length} chars, showing first ${CHARACTER_LIMIT}]`
    );
  }
  return content;
}

export async function writeNote(
  relPath: string,
  content: string,
  overwrite: boolean
): Promise<{ path: string; created: boolean }> {
  const abs = resolveInVault(relPath);
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
  return { path: toRelative(abs), created: !existed };
}

export async function appendNote(
  relPath: string,
  content: string
): Promise<{ path: string; created: boolean }> {
  const abs = resolveInVault(relPath);
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
  return { path: toRelative(abs), created: !existed };
}

export interface SearchHit {
  path: string;
  line: number;
  snippet: string;
}

export type SearchMode = "one_per_note" | "all";

export async function searchNotes(
  query: string,
  limit: number,
  mode: SearchMode = "one_per_note"
): Promise<SearchHit[]> {
  const found: string[] = [];
  await walk(VAULT_ROOT, found);
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
        hits.push({ path: toRelative(abs), line: i + 1, snippet: lines[i].trim().slice(0, 300) });
        if (hits.length >= limit) break outer;
        if (mode === "one_per_note") break; // first hit per file → next file
      }
    }
  }
  return hits;
}

/**
 * List immediate child folders of `subdir` (or the vault root). For each folder
 * returns its vault-relative path and a note count (markdown files inside it,
 * recursive). Useful when an agent wants to discover structure before
 * narrowing scope on list_notes or search.
 */
export async function listFolders(
  subdir: string | undefined
): Promise<Array<{ path: string; note_count: number }>> {
  const baseAbs = subdir ? resolveInVault(subdir) : VAULT_ROOT;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseAbs, { withFileTypes: true });
  } catch (e: unknown) {
    // Surface "not a directory" / "no such file" as an explicit error so an
    // agent passing a note path or a typo doesn't get a silent empty result.
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOTDIR") {
      throw new Error(`Not a directory: '${subdir ?? "."}'`);
    }
    if (code === "ENOENT") {
      throw new Error(`Folder does not exist: '${subdir ?? "."}'`);
    }
    // Other errors (permission, I/O) → bubble up the underlying message.
    throw e;
  }
  const folders: Array<{ path: string; note_count: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (["node_modules"].includes(entry.name)) continue;
    const childAbs = path.join(baseAbs, entry.name);
    const counter: string[] = [];
    await walk(childAbs, counter);
    folders.push({
      path: toRelative(childAbs),
      note_count: counter.length,
    });
  }
  folders.sort((a, b) => a.path.localeCompare(b.path));
  return folders;
}

/**
 * Extract tags from a note: both YAML frontmatter `tags:` and inline `#tags`.
 * Intentionally lightweight (no YAML dep). Good enough for a personal vault;
 * swap in `gray-matter` if you need robust frontmatter parsing.
 */
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

export async function findByTag(tag: string, limit: number): Promise<NoteRef[]> {
  const wanted = tag.replace(/^#/, "").toLowerCase();
  const found: string[] = [];
  await walk(VAULT_ROOT, found);
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
      out.push({ path: toRelative(abs) });
    }
  }
  return out;
}
