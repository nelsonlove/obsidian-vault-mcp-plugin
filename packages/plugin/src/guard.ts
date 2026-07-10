import { posix } from "node:path";

export interface GuardSettings { readOnly: boolean; allowlist: string[]; }

// Path-bearing argument keys across the tool surface.
const PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path"];

// Recursively walk the args, collecting any non-empty string under a
// PATH_KEYS-named key (and string members of a `paths` array) at ANY depth.
// This replaces per-shape clauses (flat keys, paths[], moves[{from,to}]): a
// future batch tool with a new nesting can't silently bypass the allowlist
// just because nobody added its shape here (#18). Over-collection is safe —
// worst case the guard over-blocks; silent under-collection is the failure
// mode this eliminates. Depth-capped + cycle-guarded defensively.
export function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  // Defensive only: MCP args arrive as parsed JSON, which can't be circular.
  const seen = new Set<object>();
  const MAX_DEPTH = 8;
  // Keys whose ARRAY values carry paths (refs = obsidian_resolve's batch input).
  const ARRAY_PATH_KEYS = ["paths", "refs"];

  function walk(value: unknown, depth: number): void {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isPathKey = PATH_KEYS.includes(k) || ARRAY_PATH_KEYS.includes(k);
      if (isPathKey && typeof v === "string" && v) {
        out.push(v);
      } else if (isPathKey && Array.isArray(v)) {
        // Arrays under path keys: collect string members, recurse the rest —
        // {path: [...]}, paths: [...], refs: [...], and paths: [{path}] all land.
        for (const p of v) {
          if (typeof p === "string" && p) out.push(p);
          else walk(p, depth + 1);
        }
      } else {
        walk(v, depth + 1);
      }
    }
  }

  walk(args, 0);
  return out;
}

// Returns a blocking reason, or null if the call is allowed.
export function guardCall(opts: {
  isMutating: boolean;
  args: Record<string, unknown>;
  settings: GuardSettings;
}): { code: string; message: string } | null {
  const { isMutating, args, settings } = opts;
  if (settings.readOnly && isMutating) {
    return { code: "read_only", message: "vault-mcp is in read-only mode; mutating tools are blocked. Turn it off in the plugin settings." };
  }
  if (settings.allowlist.length) {
    const norm = settings.allowlist.map((p) => p.replace(/\/+$/, "")).filter(Boolean);
    for (const raw of collectPaths(args)) {
      // Normalize first: collapse "." / ".." so a path like
      // "20-29 People/../00-09 System/x.md" can't pass the prefix check and
      // then resolve elsewhere inside Obsidian (allowlist traversal bypass).
      const p = posix.normalize(raw);
      const allowed =
        !p.startsWith("..") && norm.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
      if (!allowed) return { code: "out_of_allowlist", message: `path '${raw}' is outside the vault-mcp allowlist` };
    }
  }
  return null;
}
