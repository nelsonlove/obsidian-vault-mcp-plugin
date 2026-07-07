import { z } from "zod";

// ── Public types ──────────────────────────────────────────────────────────────

export type Capability = "fs-expressible" | "live-only";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: ToolAnnotations;
  capability: Capability;
}

// ── Annotation presets — match plugin's existing annotation values ─────────────

export const SHARED_ANNOTATIONS = {
  /** Read-only, idempotent, closed-world. */
  RO: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  /** Read-write, non-destructive. */
  RW: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  /** Permanently destructive (e.g. vault.delete). */
  DESTRUCTIVE: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  /** Destructive but recoverable (e.g. vault.trash — system trash can be restored). */
  DESTRUCTIVE_RECOVERABLE: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} satisfies Record<string, ToolAnnotations>;

// ── Shared helpers (mirrored from plugin for schema parity) ───────────────────

/** Valid frontmatter property name: starts with letter/underscore, alphanumeric/underscore/hyphen. */
export const PROP_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Scalar-or-array frontmatter value accepted by obsidian_manage_frontmatter. */
export const FmValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

// ── The 17 filesystem-expressible tools ──────────────────────────────────────
//
// Schemas here are authoritative — they define what the MCP server advertises
// in tools/list. Keep them byte-identical to the server's previous inline defs.

const { RO, RW, DESTRUCTIVE } = SHARED_ANNOTATIONS;

export const FS_TOOLS: ToolDef[] = [
  // ── vault-read: listing & navigation ──────────────────────────────────────

  {
    name: "obsidian_list_notes",
    title: "List vault notes",
    description:
      "List markdown notes in the vault as vault-relative paths. Optionally scope to a subfolder. Paginated. Read-only.",
    inputSchema: {
      subdir: z
        .string()
        .optional()
        .describe("Optional vault-relative subfolder to scope the listing, e.g. 'Daily'."),
      limit: z.number().int().min(1).max(500).default(100).describe("Max notes to return."),
      offset: z.number().int().min(0).default(0).describe("Notes to skip (pagination)."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_list_folders",
    title: "List immediate child folders",
    description:
      "Return the immediate child folders of `subdir` (or the vault root) with a recursive markdown-note count for each. Useful for discovering vault structure before narrowing scope with `obsidian_list_notes`. Hidden directories (`.obsidian/`, `.trash/`, etc.) are excluded. Read-only.",
    inputSchema: {
      subdir: z
        .string()
        .optional()
        .describe("Optional vault-relative subfolder. Defaults to vault root."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: note reading ───────────────────────────────────────────────

  {
    name: "obsidian_read_note",
    title: "Read a note",
    description:
      "Read the full markdown content of a note by its vault-relative path. Read-only.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path, e.g. 'Projects/Roadmap.md'."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_read_notes",
    title: "Read multiple notes",
    description:
      "Read several notes in one call. Returns `notes` for successful reads and `errors` for paths that failed (missing, ignored folders, etc.) — one bad path doesn't fail the whole call. Each note is truncated independently at the per-note character limit. Read-only.",
    inputSchema: {
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Vault-relative paths, e.g. ['Projects/A.md', 'Daily/2026-06-05.md']. Max 50 per call."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: search ────────────────────────────────────────────────────

  {
    name: "obsidian_search_notes",
    title: "Search notes",
    description:
      "Case-insensitive full-text search across all notes. Returns matching lines (path, line number, snippet). By default returns one match per note for broad coverage; pass `mode: \"all\"` to get every matching line up to `limit`. Read-only.",
    inputSchema: {
      query: z.string().min(1).describe("Text to search for."),
      limit: z.number().int().min(1).max(500).default(25).describe("Max hits to return."),
      mode: z
        .enum(["one_per_note", "all"])
        .default("one_per_note")
        .describe(
          "`one_per_note` (default) returns the first match per file; `all` returns every matching line until `limit`. Use `all` when you need multiple hits inside the same note."
        ),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_find_by_tag",
    title: "Find notes by tag",
    description:
      "Find notes carrying a given tag, from YAML frontmatter `tags:` or inline `#tag`. Pass the tag with or without '#'. Read-only.",
    inputSchema: {
      tag: z.string().min(1).describe("Tag to match, e.g. 'project' or '#project'."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max notes to return."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_search_by_frontmatter",
    title: "Search notes by a frontmatter field/value",
    description:
      "Find notes whose frontmatter has `property == value`. Property match is case-insensitive (Obsidian convention); value match is case-sensitive (exact). " +
      "For array-typed fields (`tags`, `aliases`, etc.) the note matches if any array element equals the value. " +
      "Backed by the vault index; call `obsidian_force_reindex` if you need a synchronous index refresh before querying. Read-only.",
    inputSchema: {
      property: z
        .string()
        .min(1)
        .max(64)
        .regex(PROP_RE, "Property must be a YAML identifier (letters/digits/underscore/hyphen, starting with letter or underscore)")
        .describe("Frontmatter field name, e.g. 'status', 'tags', 'jd-id'."),
      value: z
        .string()
        .min(1)
        .describe("Exact value to match. For array fields, matches if any element equals this."),
      limit: z.number().int().min(1).max(500).default(100).describe("Max notes to return."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: links ─────────────────────────────────────────────────────

  {
    name: "obsidian_resolve",
    title: "Resolve references to vault paths",
    description:
      "Resolve one or more references (wikilinks, basenames, aliases, JD-IDs, or vault-relative paths) to canonical vault paths. " +
      "Algorithm matches Obsidian's: exact path → JD-ID → basename → frontmatter alias. " +
      "Accepts `[[...]]` wrapping, `|alias` display text, and `#heading` / `#^block` fragments — those are stripped for matching and preserved in the response. " +
      "Multiple basename or alias matches return as `ambiguous` with all candidates so the caller can disambiguate. " +
      "The optional `from` field provides context for relative-link disambiguation; it is backend-dependent (honored by the live Obsidian backend, ignored by the filesystem backend). Read-only.",
    inputSchema: {
      refs: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .describe(
          "References to resolve, e.g. ['Daily Standup', '[[92.05]]', 'Projects/A.md#Goals']."
        ),
      from: z
        .string()
        .optional()
        .describe(
          "Optional vault-relative path of the note containing the references (context for relative-link disambiguation). Best-effort: honored by the live Obsidian backend, ignored by the filesystem backend for now."
        ),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_get_backlinks",
    title: "Get backlinks to a note",
    description:
      "List notes that contain a `[[wikilink]]` pointing at the given note. Backlinks are resolved from the vault index; call `obsidian_force_reindex` if you need a synchronous index refresh before querying. Read-only.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path of the target note, e.g. 'Projects/Plan.md'."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_get_outlinks",
    title: "Get outbound links from a note",
    description:
      "List `[[wikilinks]]` in the body of a note, with each ref's resolved path when resolution is unambiguous. Useful for traversal without re-reading the note. Read-only.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path of the source note, e.g. 'Projects/Plan.md'."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: index utility ─────────────────────────────────────────────

  {
    name: "obsidian_force_reindex",
    title: "Force-rebuild the vault index",
    description:
      "Rebuilds the vault index on backends that maintain one; a no-op on backends whose cache is always live. " +
      "Call this when you need to wait synchronously before a follow-up index query (tight read-after-write loop). " +
      "Concurrent callers share a single in-flight rebuild where supported. Idempotent.",
    inputSchema: {},
    // Not read-only (mutates the index), but idempotent.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capability: "fs-expressible",
  },

  // ── vault-write: frontmatter ──────────────────────────────────────────────

  {
    name: "obsidian_manage_frontmatter",
    title: "Get / set / delete a single frontmatter field",
    description:
      "Read or modify one top-level frontmatter field of a note. Supports inline-scalar (`key: value`), inline-array (`key: [a, b]`), and block-array (`key:\\n  - a`) shapes. " +
      "Refuses to edit fields using block-scalar (|/>) or inline-object shapes to avoid silent corruption. " +
      "`set` creates the frontmatter block if absent. Other keys' formatting (indentation, quoting) is preserved — only the target key's lines get rewritten. " +
      "Note: changes are applied live. Call `obsidian_force_reindex` before follow-up index queries if you need a synchronous index refresh.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path of the note, ending in .md."),
      key: z
        .string()
        .min(1)
        .max(64)
        .regex(PROP_RE, "Key must be a YAML identifier (letters/digits/underscore/hyphen, starting with letter or underscore)")
        .describe("Frontmatter field name."),
      op: z.enum(["get", "set", "delete"]).describe("Operation."),
      value: FmValue.optional().describe("Required for `set`. Ignored otherwise. Arrays serialize as block lists."),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  // ── vault-write: patching ─────────────────────────────────────────────────

  {
    name: "obsidian_patch_note",
    title: "Patch a note relative to a heading or block anchor",
    description:
      "Insert / replace content at a named anchor inside a note. Three operations × two anchor types:\n" +
      "  - `heading` anchor: matches the first `## My Heading` line whose text exactly equals the anchor value (case-sensitive). " +
      "If multiple headings have the same text, only the first is patched. The anchor's 'content' is the section body — lines from after the heading up to the next heading of equal or higher level, or EOF. The heading line itself is preserved across all three ops.\n" +
      "  - `block` anchor: matches the first paragraph whose final token is `^<value>` (whitespace-bounded). The anchor's 'content' is the entire paragraph (lines from prior blank line up to next blank line). `prepend`/`append` operate on the WHOLE paragraph, not just the line containing `^<value>`. `replace` swaps the entire paragraph (and the `^<value>` token with it — include it in `content` if you want the block ref preserved).\n" +
      "`content` is inserted verbatim into the line stream — newlines preserved. Callers wanting paragraph-level separation (a blank line between the inserted content and the anchor's content) should include the blank line(s) in `content` themselves. " +
      "Returns `found: false` if the anchor doesn't match; no write happens. Returns the prior content as `previous` so the caller can undo or audit. " +
      "For frontmatter-field edits use `obsidian_manage_frontmatter` instead — patch_note doesn't shadow it.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path of the note, ending in .md."),
      anchor_type: z.enum(["heading", "block"]).describe("Anchor matcher: 'heading' or 'block'."),
      anchor: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "Anchor value: the exact heading text (without leading `#`s and whitespace) OR the block ID (without leading `^`)."
        ),
      op: z.enum(["append", "prepend", "replace"]).describe("Where to put the content relative to the anchor."),
      content: z.string().describe("Markdown to insert or use as replacement. Newlines preserved."),
    },
    annotations: DESTRUCTIVE,
    capability: "fs-expressible",
  },

  // ── vault-write: full note ops ────────────────────────────────────────────

  {
    name: "obsidian_write_note",
    title: "Write a note",
    description:
      "Create a note, or overwrite an existing one when overwrite=true. Path must end in .md. Parent folders are created as needed.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path ending in .md."),
      content: z.string().describe("Full markdown content to write."),
      overwrite: z.boolean().default(false).describe("Replace an existing note. Default false (refuses if it exists)."),
    },
    annotations: DESTRUCTIVE,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_append_note",
    title: "Append to a note",
    description:
      "Append markdown to a note (creating it if absent). A newline is inserted before appended content for existing notes. Good for daily logs and running lists.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path ending in .md."),
      content: z.string().min(1).describe("Markdown to append."),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_move_note",
    title: "Rename / move a note and rewrite backlinks",
    description:
      "Move (or rename) a note from one vault path to another. With `update_backlinks: true` (default), every note that wikilinks to `from` is rewritten to point at `to`. " +
      "Resolution uses the vault index: only refs that currently resolve to `from` are touched; ambiguous basename matches are left alone. " +
      "Ref *shape* is preserved across the rewrite — bare basename refs (`[[from-basename]]`) get the new basename, full-path refs get the new full path. `|alias` and `#fragment` suffixes are kept verbatim. " +
      "Refuses if `to` already exists unless `overwrite: true`. Parent folders of `to` are created as needed. " +
      "Call `obsidian_force_reindex` after the move if downstream queries need a synchronous index refresh.",
    inputSchema: {
      from: z.string().min(1).describe("Existing vault-relative path of the note, ending in .md."),
      to: z.string().min(1).describe("New vault-relative path, ending in .md."),
      update_backlinks: z
        .boolean()
        .default(true)
        .describe("Rewrite [[wikilinks]] in other notes that currently resolve to `from`."),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Replace `to` if it already exists. Default false (refuses)."),
    },
    annotations: DESTRUCTIVE,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_delete_note",
    title: "Delete a note from the vault",
    description:
      "Permanently delete a note from disk. This is a one-way operation with no undo. " +
      "To make accidents harder: `confirm: true` is required at the schema layer. Calls without it are rejected before reaching the filesystem. " +
      "Backlinks to the deleted note are NOT updated — those refs become 'broken' and can be detected with the existing tooling. Use `obsidian_move_note` if you want to relocate while preserving wikilinks.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path of the note to delete."),
      confirm: z
        .literal(true)
        .describe("Must be literally `true`. Required guard against accidental deletes."),
    },
    annotations: DESTRUCTIVE,
    capability: "fs-expressible",
  },
];
