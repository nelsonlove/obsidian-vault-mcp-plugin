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

const { RO, RW, DESTRUCTIVE } = SHARED_ANNOTATIONS;

export const FS_TOOLS: ToolDef[] = [
  // ── vault-read: listing & navigation ──────────────────────────────────────

  {
    name: "obsidian_list_notes",
    title: "List notes",
    description:
      "List markdown notes, optionally under a subfolder, with pagination. Read-only.",
    inputSchema: {
      subdir: z
        .string()
        .optional()
        .describe("Vault-relative subfolder, e.g. 'Daily'. Omit for the whole vault."),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_list_folders",
    title: "List folders",
    description:
      "List immediate subfolders of a folder (or the vault root), each with a recursive markdown-note count. Read-only.",
    inputSchema: {
      subdir: z
        .string()
        .optional()
        .describe("Vault-relative subfolder. Omit for the vault root."),
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
      "Read several notes at once. One missing/unreadable path is reported in `errors` and does not fail the call. Read-only.",
    inputSchema: {
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe(
          "Vault-relative paths, e.g. ['Projects/A.md','Daily/2026-06-05.md']."
        ),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: search ────────────────────────────────────────────────────

  {
    name: "obsidian_search_notes",
    title: "Search notes",
    description:
      "Case-insensitive substring search across note contents, line by line. Read-only.",
    inputSchema: {
      query: z.string().min(1).describe("Text to search for."),
      limit: z.number().int().min(1).max(500).default(25),
      mode: z.enum(["one_per_note", "all"]).default("one_per_note"),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_find_by_tag",
    title: "Find notes by tag",
    description:
      "List notes carrying a tag (inline or in frontmatter), matched from the live metadata cache. Read-only.",
    inputSchema: {
      tag: z
        .string()
        .min(1)
        .describe(
          "Tag to match, e.g. 'project' or '#project' (with or without #)."
        ),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_search_by_frontmatter",
    title: "Search by frontmatter",
    description:
      "Find notes whose frontmatter property equals a value (array properties match any element). Read-only.",
    inputSchema: {
      property: z
        .string()
        .min(1)
        .max(64)
        .regex(PROP_RE)
        .describe("Frontmatter field name."),
      value: z.string().min(1).describe("Exact value to match."),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: links ─────────────────────────────────────────────────────

  {
    name: "obsidian_resolve",
    title: "Resolve link reference",
    description:
      "Resolve a wikilink/path/basename to a canonical vault path using Obsidian's own resolver. Read-only.",
    inputSchema: {
      ref: z
        .string()
        .min(1)
        .describe(
          "Link text, basename, or path, e.g. '[[Roadmap]]' or 'Roadmap'."
        ),
      from: z
        .string()
        .optional()
        .describe("Source note path for context-sensitive resolution."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_get_backlinks",
    title: "Get backlinks",
    description:
      "List notes that link TO the given note, from Obsidian's live metadata cache (canonical — resolves aliases, embeds, block refs). Read-only.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path of the target note."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_get_outlinks",
    title: "Get outlinks",
    description:
      "List links and embeds OUT of a note, each resolved to a canonical vault path via the live cache. Read-only.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path of the source note."),
    },
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-read: utility ───────────────────────────────────────────────────

  {
    name: "obsidian_force_reindex",
    title: "Force reindex (no-op)",
    description:
      "No-op: Obsidian's metadata cache is always live, so there is nothing to rebuild. Returns immediately. Read-only.",
    inputSchema: {},
    annotations: RO,
    capability: "fs-expressible",
  },

  // ── vault-write: frontmatter ──────────────────────────────────────────────

  {
    name: "obsidian_manage_frontmatter",
    title: "Manage frontmatter",
    description:
      "Get, set, or delete a single frontmatter key. Set/delete use Obsidian's atomic processFrontMatter, preserving other keys' formatting.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path ending in .md."),
      key: z
        .string()
        .min(1)
        .max(64)
        .regex(PROP_RE)
        .describe("Frontmatter field name."),
      op: z.enum(["get", "set", "delete"]),
      value: FmValue.optional().describe("Required for op='set'."),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  // ── vault-write: patching ─────────────────────────────────────────────────

  {
    name: "obsidian_patch_note",
    title: "Patch a note section",
    description:
      "Append/prepend/replace content at a heading or block-id anchor. Returns found=false (no write) if the anchor is not present.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path ending in .md."),
      anchor_type: z.enum(["heading", "block"]),
      anchor: z
        .string()
        .min(1)
        .max(500)
        .describe("Heading text (no #) or block id (no ^)."),
      op: z.enum(["append", "prepend", "replace"]),
      content: z.string().describe("Markdown to insert; newlines preserved."),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  // ── vault-write: full note ops ────────────────────────────────────────────

  {
    name: "obsidian_write_note",
    title: "Write a note",
    description:
      "Create a note, or overwrite an existing one when `overwrite` is true. Parent folders are created as needed.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path ending in .md."),
      content: z.string(),
      overwrite: z.boolean().default(false),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_append_note",
    title: "Append to a note",
    description:
      "Append content to a note, creating it (and parent folders) if absent.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path ending in .md."),
      content: z.string().min(1),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_move_note",
    title: "Move/rename a note",
    description:
      "Move or rename a note. Backlinks are rewritten canonically by Obsidian's fileManager.renameFile.",
    inputSchema: {
      from: z
        .string()
        .min(1)
        .describe("Existing vault-relative path ending in .md."),
      to: z
        .string()
        .min(1)
        .describe("New vault-relative path ending in .md."),
      overwrite: z.boolean().default(false),
    },
    annotations: RW,
    capability: "fs-expressible",
  },

  {
    name: "obsidian_delete_note",
    title: "Delete a note",
    description: "Permanently delete a note. Requires confirm=true.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Vault-relative path of the note."),
      confirm: z.literal(true).describe("Must be true to proceed."),
    },
    annotations: DESTRUCTIVE,
    capability: "fs-expressible",
  },
];
