// compile.ts — SPIKE. Design-validation code only; do not ship.
//
// Compiles a SchemeDefinition into matcher/formatter/allocator primitives:
// token regexes (from primitives, never raw user regex), parent-token
// derivation, and a resolved-parameters "Grammar" that generic-provider.ts
// interprets into the five vault-aware ScopeProvider methods.
//
// Everything here is written against DEFINITION DATA (level names, overlay
// names, captured field names) — never against JD-specific string literals
// like "area" or "expandedAreas". Where that discipline broke down, it is
// called out in a comment (and in the design-validation report) rather than
// silently smoothed over.

import type {
  AllocationRule,
  FormatPart,
  LevelDef,
  NameHeuristic,
  OrderingKey,
  OverlayDef,
  ParamDecl,
  Primitive,
  SchemeDefinition,
  TokenFormat,
  TokenPattern,
} from "./definition.js";

// ── token pattern -> regex ──────────────────────────────────────────────

export interface CompiledPattern {
  re: RegExp;
  sameDigit: Array<[string, string]>;
}

function primitiveFragment(p: Primitive): string {
  switch (p.kind) {
    case "digits":
      return `(?<${p.name}>[0-9]{${p.width}})`;
    case "digitsVariant":
      // Longest-alternative-first avoids a shorter width "winning" and
      // leaving residual characters for the (fixed) end anchor to reject —
      // belt-and-suspenders, since anchoring alone already makes it safe.
      return `(?<${p.name}>${[...p.widths].sort((a, b) => b - a).map((w) => `[0-9]{${w}}`).join("|")})`;
    case "literal":
      return p.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

export function compileTokenPattern(tp: TokenPattern): CompiledPattern {
  const body = tp.parts.map(primitiveFragment).join("");
  return { re: new RegExp(`^${body}$`), sameDigit: tp.sameDigit ?? [] };
}

const CHAR_CLASS: Record<"digit" | "." | "-", string> = { digit: "0-9", ".": "\\.", "-": "\\-" };

/** Compiles NameHeuristic to a regex — still primitive-composed (a fixed
 * small vocabulary of character classes), not raw user regex. */
export function compileNameHeuristic(nh: NameHeuristic): RegExp {
  const first = nh.firstDigit ? "[0-9]" : ".";
  const rest = nh.restChars.map((c) => CHAR_CLASS[c]).join("");
  return new RegExp(`^${first}[${rest}]*$`);
}

/** Match `raw` (already trimmed) against a compiled pattern. Returns the
 * named-group field map, or null on no match / a failed sameDigit
 * cross-reference constraint. */
export function matchToken(cp: CompiledPattern, raw: string): Record<string, string> | null {
  const m = cp.re.exec(raw);
  if (!m) return null;
  // A pure-literal tokenPattern (no digit captures — see PARA/GTD's
  // enumerated container tokens in others.test.mjs) has NO named groups at
  // all, so `m.groups` is `undefined` even on a successful match — a real
  // bug caught by the PARA/GTD sketch, not something the JD parity suite
  // alone would ever exercise (JD's tokenPattern always captures at least
  // one digit run). Treat a groups-free match as an empty field map.
  const groups = m.groups ?? {};
  for (const [a, b] of cp.sameDigit) {
    if (groups[a] !== groups[b]) return null;
  }
  return { ...groups };
}

// ── TokenFormat: build a token string from another level's own fields ──

export function applyFormat(fmt: TokenFormat, fields: Record<string, string>): string {
  return fmt.parts
    .map((part: FormatPart) => {
      if (part.kind === "literal") return part.text;
      const v = fields[part.field];
      if (v === undefined) throw new Error(`applyFormat: missing field "${part.field}"`);
      return part.charAt !== undefined ? v[part.charAt] : v;
    })
    .join("");
}

// ── parameters ───────────────────────────────────────────────────────────

export type ParamValues = Record<string, string[] | number>;

export function resolveParams(decls: ParamDecl[], overrides: Record<string, unknown> | undefined): ParamValues {
  const out: ParamValues = {};
  for (const d of decls) {
    const raw = overrides?.[d.name];
    out[d.name] = (raw === undefined ? d.default : raw) as string[] | number;
  }
  return out;
}

// ── the compiled grammar ────────────────────────────────────────────────

export interface CompiledLevel {
  def: LevelDef;
  pattern: CompiledPattern;
}

export interface CompiledOverlayItem {
  overlay: OverlayDef;
  pattern: CompiledPattern;
}

export interface CompiledOverlayChild {
  overlay: OverlayDef;
  pattern: CompiledPattern;
}

/** A parsed token: which level (or overlay item/child level) it matched,
 * the raw text, its captured fields, and — for overlay-introduced levels —
 * which overlay activated it (containment/allocation dispatch needs to
 * know, since e.g. "expanded-item" has TWO structurally-identical shapes
 * whose containment differs by which overlay is active). */
export interface ParsedToken {
  level: string;
  raw: string;
  fields: Record<string, string>;
  overlay?: string;
}

export class Grammar {
  constructor(
    public readonly def: SchemeDefinition,
    public readonly levels: Map<string, CompiledLevel>,
    public readonly overlayItems: Map<string, CompiledOverlayItem>,
    public readonly overlayChildren: Map<string, CompiledOverlayChild>,
    public readonly params: ParamValues,
    public readonly nameHeuristicRe: RegExp | null,
  ) {}

  looksLikeAddress(token: string): boolean {
    return this.nameHeuristicRe !== null && this.nameHeuristicRe.test(token);
  }

  paramSet(name: string): Set<string> {
    const v = this.params[name];
    if (!Array.isArray(v)) throw new Error(`parameter "${name}" is not a stringArray`);
    return new Set(v);
  }

  paramNumber(ref: { param: string; default: number } | number | undefined, fallback: number): number {
    if (ref === undefined) return fallback;
    if (typeof ref === "number") return ref;
    const v = this.params[ref.param];
    return typeof v === "number" ? v : ref.default;
  }

  /** Whether `overlay` is active for a candidate whose testKey field(s) are
   * already captured in `fields` (using the field name(s) the overlay's
   * activation formula expects — itemLevel and childLevel both capture a
   * "category" field for exactly this reason, see OverlayDef doc). */
  overlayActive(overlay: OverlayDef, fields: Record<string, string>): boolean {
    const key = overlay.testKeyFormula ? applyFormat(overlay.testKeyFormula, fields) : fields[overlay.testLevel];
    return this.paramSet(overlay.parameter).has(key);
  }

  /** Parse a raw (trimmed) token against every level/overlay shape, in
   * definition order: base levels first (their order in `def.levels`,
   * mirroring jd.ts's if/else-if chain — precedence is real, not just
   * documentation), then each overlay's child level, then its item level.
   * NOTE (see report): base levels are NOT gated by overlay activation —
   * this reproduces jd.ts's actual (slightly surprising) behavior where an
   * "id"-shaped token still parses even inside an expanded category. */
  parseToken(raw: string): ParsedToken | null {
    for (const lvl of this.levels.values()) {
      const fields = matchToken(lvl.pattern, raw);
      if (fields) return { level: lvl.def.name, raw, fields };
    }
    for (const overlay of this.def.overlays) {
      if (overlay.childLevel) {
        const cp = this.overlayChildren.get(overlay.name)!;
        const fields = matchToken(cp.pattern, raw);
        if (fields && this.overlayActive(overlay, fields)) {
          return { level: overlay.childLevel.name, raw, fields, overlay: overlay.name };
        }
      }
    }
    for (const overlay of this.def.overlays) {
      const ip = this.overlayItems.get(overlay.name)!;
      const fields = matchToken(ip.pattern, raw);
      if (fields && this.overlayActive(overlay, fields)) {
        return { level: overlay.itemLevel.name, raw, fields, overlay: overlay.name };
      }
    }
    return null;
  }

  /** One step up the containment chain from an already-captured field map
   * at `level` (which may be a base level OR an overlay item/child level),
   * or null when it's a root level. Re-derives fields by re-matching
   * `token` against `level`'s own pattern when the caller only has a bare
   * ancestor token (not a freshly-parsed ParsedToken) — legitimate, not a
   * hack: every ancestor token is, by construction, formatted exactly per
   * its own level's grammar (it came from THIS SAME compiler). */
  //
  // FINDING (see report): when only a bare {level, token} Scope is given —
  // no ParsedToken.overlay provenance, e.g. a Scope constructed directly by
  // a caller rather than derived from parseToken — and TWO overlays share
  // an item level NAME (JD's "expanded-item": one shape, two activation
  // conditions), the level name alone cannot say which overlay produced it.
  // The only correct resolution is to re-run each overlay's OWN activation
  // test (parameter membership) against the token's re-matched fields, not
  // just try overlays in declaration order — the naive "first structural
  // match wins" approach silently picks the wrong overlay (and therefore
  // the wrong container level and the wrong numeric base) whenever an
  // expanded-CATEGORY's flat id is walked without its provenance tag.
  parentOfLevelToken(level: string, token: string, fields?: Record<string, string>): { level: string; token: string } | null {
    const base = this.levels.get(level);
    if (base) {
      if (base.def.containedBy === null) return null;
      const f = fields ?? matchToken(base.pattern, token)!;
      const parentToken = base.def.parentTokenField
        ? f[base.def.parentTokenField]
        : base.def.parentTokenFormula
          ? applyFormat(base.def.parentTokenFormula, f)
          : (() => {
              throw new Error(`level "${level}" has containedBy but no parentTokenField/parentTokenFormula`);
            })();
      return { level: base.def.containedBy, token: parentToken };
    }
    for (const overlay of this.def.overlays) {
      if (overlay.itemLevel.name === level) {
        const f = fields ?? matchToken(this.overlayItems.get(overlay.name)!.pattern, token)!;
        if (!f || !this.overlayActive(overlay, f)) continue;
        return { level: overlay.parentLevel, token: this.overlayParentToken(overlay, f) };
      }
      if (overlay.childLevel?.name === level) {
        const f = fields ?? matchToken(this.overlayChildren.get(overlay.name)!.pattern, token)!;
        if (!f || !this.overlayActive(overlay, f)) continue;
        return { level: overlay.itemLevel.name, token: applyFormat(overlay.childLevel.parentTokenFormula, f) };
      }
    }
    return null;
  }

  /** One step up the containment chain: the parent's level name and token,
   * or null when `pt` is already a root level. When `pt` carries its own
   * overlay provenance (set by parseToken), use it directly rather than
   * re-running the activation scan — faster, and avoids any theoretical
   * ambiguity if a token happened to structurally satisfy two overlays at
   * once (not a case JD's default config can produce, but not ruled out by
   * the schema either — see report). */
  parentOf(pt: ParsedToken): { level: string; token: string } | null {
    if (pt.overlay) {
      const overlay = this.def.overlays.find((o) => o.name === pt.overlay)!;
      if (pt.level === overlay.itemLevel.name) {
        return { level: overlay.parentLevel, token: this.overlayParentToken(overlay, pt.fields) };
      }
      if (overlay.childLevel && pt.level === overlay.childLevel.name) {
        return { level: overlay.itemLevel.name, token: applyFormat(overlay.childLevel.parentTokenFormula, pt.fields) };
      }
    }
    return this.parentOfLevelToken(pt.level, pt.raw, pt.fields);
  }

  /** The test key an overlay's item token resolves to (its OWN token
   * tested against the parameter set) — used both at parse time and to
   * compute the surviving container's token (the area or category the item
   * nests under is exactly what the activation test already identified). */
  private overlayParentToken(overlay: OverlayDef, fields: Record<string, string>): string {
    return overlay.testKeyFormula ? applyFormat(overlay.testKeyFormula, fields) : fields[overlay.testLevel];
  }

  /** Full ancestor chain, immediate parent first, root last (does NOT
   * include `pt` itself — see `chainOf`/`levelsOf` in generic-provider.ts
   * for callers that prepend it). */
  ancestors(pt: ParsedToken): Array<{ level: string; token: string }> {
    const out: Array<{ level: string; token: string }> = [];
    let step = this.parentOf(pt);
    while (step) {
      out.push(step);
      step = this.parentOfLevelToken(step.level, step.token);
    }
    return out;
  }

  /** Total digit width of an overlay's item token, read from its own
   * tokenPattern (never a hardcoded constant — a definition with a 4-digit
   * or 6-digit expanded band works unchanged). */
  itemWidth(overlay: OverlayDef): number {
    return overlay.itemLevel.tokenPattern.parts.reduce((n, p) => {
      if (p.kind === "digits") return n + p.width;
      if (p.kind === "digitsVariant") return n + Math.max(...p.widths);
      return n;
    }, 0);
  }

  /** The numeric base an overlay's item allocation is offset from, per
   * OverlayDef.itemLevel.base. `scopeToken` is the container scope's OWN
   * token (an area band like "90-99", or a plain category like "27"). */
  overlayBase(overlay: OverlayDef, scopeToken: string): number {
    const width = this.itemWidth(overlay);
    if (overlay.itemLevel.base === "bandDigit") {
      return parseInt(scopeToken[0], 10) * 10 ** (width - 1);
    }
    return parseInt(scopeToken, 10) * 10 ** (width - scopeToken.length);
  }
}

export function compile(def: SchemeDefinition) {
  const levels = new Map<string, CompiledLevel>();
  for (const lvl of def.levels) levels.set(lvl.name, { def: lvl, pattern: compileTokenPattern(lvl.tokenPattern) });

  const overlayItems = new Map<string, CompiledOverlayItem>();
  const overlayChildren = new Map<string, CompiledOverlayChild>();
  for (const overlay of def.overlays) {
    overlayItems.set(overlay.name, { overlay, pattern: compileTokenPattern(overlay.itemLevel.tokenPattern) });
    if (overlay.childLevel) {
      overlayChildren.set(overlay.name, { overlay, pattern: compileTokenPattern(overlay.childLevel.tokenPattern) });
    }
  }

  return {
    def,
    instantiate(overrides?: Record<string, unknown>): Grammar {
      const params = resolveParams(def.parameters, overrides);
      const nameHeuristicRe = def.nameHeuristic ? compileNameHeuristic(def.nameHeuristic) : null;
      return new Grammar(def, levels, overlayItems, overlayChildren, params, nameHeuristicRe);
    },
  };
}

export function allocationFloor(g: Grammar, rule: AllocationRule): number {
  return g.paramNumber(rule.floor, 0);
}

export type { AllocationRule, OrderingKey };
