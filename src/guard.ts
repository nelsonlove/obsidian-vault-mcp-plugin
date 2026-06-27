export interface GuardSettings { readOnly: boolean; allowlist: string[]; }

// Path-bearing argument keys across the tool surface.
const PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path"];

export function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) out.push(v);
  }
  if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string" && p) out.push(p);
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
    for (const p of collectPaths(args)) {
      const allowed = norm.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
      if (!allowed) return { code: "out_of_allowlist", message: `path '${p}' is outside the vault-mcp allowlist` };
    }
  }
  return null;
}
