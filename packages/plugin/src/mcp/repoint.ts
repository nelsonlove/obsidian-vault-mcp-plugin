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

/**
 * Rewrite every wikilink whose target text matches `linkName` (case-insensitive,
 * trimmed) to point at `newTarget`, preserving any alias and subpath. Returns the
 * rewritten text and the number of links changed.
 */
export function repointLinksInText(
  content: string,
  linkName: string,
  newTarget: string,
): { text: string; count: number } {
  const wanted = normalizeLinkName(linkName);
  let count = 0;
  const text = content.replace(
    WIKILINK_RE,
    (_match: string, tgt: string, sub = "", alias = "") => {
      if (normalizeLinkName(tgt) !== wanted) return _match;
      count++;
      return `[[${newTarget}${sub}${alias}]]`;
    },
  );
  return { text, count };
}
