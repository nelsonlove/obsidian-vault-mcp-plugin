// Pure wikilink-repointing logic — no `obsidian` import, so it is unit-testable
// headlessly (tests/repoint.test.mjs). The `app.*`-bound handler that scans the
// vault and writes files lives in tools-vault-write.ts.

/**
 * Splits a wikilink into:
 *   1 = target   (text before # or | or ]] )
 *   2 = subpath  (#heading / #^block, optional, includes the '#')
 *   3 = alias    (|display, optional, includes the '|')
 */
export const WIKILINK_RE = /\[\[([^\[\]|#]+)(#[^\[\]|]*)?(\|[^\[\]]*)?\]\]/g;

export function normalizeLinkName(name: string): string {
  return name.trim().toLowerCase();
}

export interface RepointOptions {
  /** Drop an alias that merely echoes the old link name: [[Foo|Foo]] → [[New]].
   *  Genuine display aliases ([[Foo|see this]]) are always preserved. */
  dropEchoAlias?: boolean;
  /** Per-link gate: return false to leave a matching link untouched. Receives the
   *  raw target text as written (used by unresolved_only to skip links that
   *  still resolve from their source file). */
  allowTarget?: (rawTarget: string) => boolean;
}

/**
 * Rewrite every wikilink whose target text matches `linkName` (case-insensitive,
 * trimmed) to point at `newTarget`, preserving any alias and subpath. Returns the
 * rewritten text and the number of links changed.
 */
export function repointLinksInText(
  content: string,
  linkName: string,
  newTarget: string,
  opts: RepointOptions = {},
): { text: string; count: number } {
  const wanted = normalizeLinkName(linkName);
  let count = 0;
  const text = content.replace(
    WIKILINK_RE,
    (match: string, tgt: string, sub = "", alias = "") => {
      if (normalizeLinkName(tgt) !== wanted) return match;
      if (opts.allowTarget && !opts.allowTarget(tgt)) return match;
      // alias includes its leading '|'; an "echo" alias repeats the old name.
      let outAlias = alias;
      if (opts.dropEchoAlias && alias && normalizeLinkName(alias.slice(1)) === wanted) {
        outAlias = "";
      }
      count++;
      return `[[${newTarget}${sub}${outAlias}]]`;
    },
  );
  return { text, count };
}
