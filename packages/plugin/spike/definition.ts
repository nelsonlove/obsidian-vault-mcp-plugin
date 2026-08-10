// definition.ts — SPIKE. Design-validation code only; do not ship.
//
// SchemeDefinition types per the design brief (Assent/Build/Scheme definition
// schema — design brief, 2026-08-10) and issue #97: levels, tokenPattern
// built from PRIMITIVES (not raw user regex), addressKinds, overlays keyed
// by parameter token-sets, allocation policies, ordering-as-data, parameters,
// derived capabilities.
//
// Spike-quality: clarity over polish. Comments explain WHY a shape was
// chosen where it matters for the design-validation report.

// ── tokenPattern primitives ────────────────────────────────────────────────
//
// Brief: "composed primitives, NOT raw user regex ... fixed-width digit
// runs, numeric ranges, literal separators, cross-references between
// captured parts (sameDigit(a,b)), width variants (2-3 digit decimals)".
//
// Finding: JD's area token "X0-X9" (digits must match) does NOT need a
// distinct "digitRange" primitive — it decomposes into two digit-run(1)
// captures either side of literal separators, plus a sameDigit
// cross-reference constraint. That composition alone covers JD's grammar.

export interface DigitsPrimitive {
  kind: "digits";
  name: string;
  width: number;
}

/** A digit-run whose width may be any ONE of `widths` (JD's 2-3 digit
 * decimal). Anchored matching means this is unambiguous. */
export interface DigitsVariantPrimitive {
  kind: "digitsVariant";
  name: string;
  widths: number[];
}

export interface LiteralPrimitive {
  kind: "literal";
  text: string;
}

export type Primitive = DigitsPrimitive | DigitsVariantPrimitive | LiteralPrimitive;

export interface TokenPattern {
  parts: Primitive[];
  /** Pairs of capture names whose matched text must be IDENTICAL (JD's
   * digits-must-match area rule: "10-29" is not a valid area). */
  sameDigit?: Array<[string, string]>;
}

// ── deriving a token from another level's captured fields ─────────────────
//
// JD needs a category's enclosing area token FROM the category's own
// 2-digit code (areaOfCategory) in half a dozen places. TokenFormat
// expresses "build a token string from named fields of an already-matched
// level" with the same literal/digit-slice vocabulary as tokenPattern.

export interface FormatFieldRef {
  kind: "field";
  field: string;
  /** Take only this single character index (0-based) of the field's
   * matched text, rather than the whole capture. */
  charAt?: number;
}
export interface FormatLiteral {
  kind: "literal";
  text: string;
}
export type FormatPart = FormatFieldRef | FormatLiteral;

export interface TokenFormat {
  parts: FormatPart[];
}

// ── levels ──────────────────────────────────────────────────────────────

export interface LevelDef {
  /** Unique name — JD: "area" | "category" | "id". Doubles as the
   * address/scope "kind" string. (Overlay-introduced levels — JD's
   * "expanded-item" / "fractal-id" — are declared on OverlayDef instead;
   * see the note there on why.) */
  name: string;
  tokenPattern: TokenPattern;
  /** Name of the level this one nests under, or null for a root level. */
  containedBy: string | null;
  /** Whether a BARE token of this level is also tolerated directly at the
   * vault root, with no containing parent folder present (JD: a bare
   * category folder with no area wrapper). An extra allowance layered on
   * top of `containedBy`, not derived from it — flagged in the report as a
   * JD-specific tolerance the schema has to name explicitly. */
  rootAllowed?: boolean;
  /** Item-level = names an addressable thing a note can carry as its own
   * address (JD: id). Container-level = a scope only (area, category).
   * Feeds the itemAddresses capability. */
  itemLevel: boolean;
  /** Name of the field on THIS level's own match that equals its parent's
   * token directly (JD id's "category" field IS category's own token). */
  parentTokenField?: string;
  /** Formula computing the parent token when it is DERIVED, not directly
   * captured (JD category -> area, via first-digit-of-category). */
  parentTokenFormula?: TokenFormat;
  /** Which captured field becomes the LAST entry of Address.levels (the
   * folder-path convention — see provider.ts). Absent = use the level's own
   * full raw token. JD id: "decimal" (levels end in "11", not "06.11" —
   * a wrinkle ported verbatim from jd.ts's levelsOf, not this schema's
   * invention; see report). */
  leafField?: string;
}

// ── addressKinds ────────────────────────────────────────────────────────

export interface AddressKindDef {
  /** Matches a LevelDef.name, or an overlay's itemLevel/childLevel name. */
  level: string;
  itemLevel: boolean;
}

// ── overlays ────────────────────────────────────────────────────────────
//
// Brief: "conditional grammar modes ... activated by configured token
// sets". JD needs exactly two, both driven by a parameter that is a set of
// tokens:
//   - expandedAreas:      band tokens (e.g. "90-99") whose WHOLE category
//                          level collapses; items sit directly under the
//                          area as 5-digit sequential ids, with a further
//                          fractal-id level nested under each item.
//   - expandedCategories: single category tokens (e.g. "27") whose id
//                          level (XX.YY) gets an ADDITIONAL 5-digit flat
//                          item shape, while the category folder survives.
//
// NOT a level swap: ported jd.ts still accepts the PLAIN "id" shape
// (XX.YY) for an expanded category's own 2-digit prefix (e.g. "27.11"
// parses as an ordinary id even though 27 is expanded) — parseJdId has no
// guard rejecting it. The overlay is additive at the grammar layer; it
// only changes CONTAINMENT and ALLOCATION dispatch for the new shape it
// introduces. See report: "overlay = level replacement" is the wrong
// mental model.

export interface OverlayDef {
  name: string;
  /** SchemeDefinition parameter (stringArray) supplying the activating
   * token set. */
  parameter: string;
  /** Which level's token is tested for membership in the parameter set. */
  testLevel: "area" | "category";
  /** Derive the test key from testLevel's own capture before the
   * membership check (expandedAreas is keyed by AREA but is tested via a
   * CATEGORY's enclosing area, not the category token itself). Absent =
   * test the level's own token directly (expandedCategories). */
  testKeyFormula?: TokenFormat;
  /** The container level that survives as the overlaid item's direct
   * parent ("area" for expandedAreas — category folder collapses;
   * "category" for expandedCategories — category folder survives). */
  parentLevel: "area" | "category";
  itemLevel: {
    name: string; // "expanded-item"
    tokenPattern: TokenPattern;
    /** "bandDigit" -> base = firstDigit(area) * 10^(width-1) (expandedAreas)
     *  "category"  -> base = int(category) * 10^(width-2)   (expandedCategories) */
    base: "bandDigit" | "category";
  };
  /** A further level nested under the overlaid item (expandedAreas only:
   * fractal-id). Absent for expandedCategories. Its tokenPattern captures
   * the SAME field names as itemLevel's own pattern (e.g. "category") so
   * that OverlayDef.testKeyFormula can validate ITS activation too, using
   * the identical formula against a different level's match. */
  childLevel?: {
    name: string; // "fractal-id"
    tokenPattern: TokenPattern;
    /** Formula reconstructing the parent item's raw token from fields
     * captured on the child's own match (JD: category+seq concatenated,
     * matching itemLevel's raw exactly). */
    parentTokenFormula: TokenFormat;
    leafField: string; // "decimal"
  };
}

// ── allocation ──────────────────────────────────────────────────────────

export interface AllocationRule {
  /** Level (or overlay itemLevel) name this rule allocates within. */
  level: string;
  /** Only applies to scopes where this overlay is active (absent = the
   * rule applies to the level's plain, non-overlaid container). */
  overlay?: string;
  strategy: "lowest-free" | "max-plus-one";
  /** Lowest allocatable value (lowest-free). May reference a parameter
   * (contentDecimalFloor) instead of a literal default. */
  floor?: number | { param: string; default: number };
  /** Captured field on the item's match that carries the numeric slot
   * being allocated (JD: "decimal" for lowest-free id allocation, "token"
   * for max-plus-one expanded-item allocation). */
  field: string;
  /** For max-plus-one strategies whose used-set must ALSO count a nested
   * child level's occurrences (expanded area: a fractal-id also "uses" its
   * parent item number, via that child level's OWN parentTokenFormula —
   * see generic-provider.ts's allocateOverlay). Name of that child level. */
  alsoCountFrom?: { level: string };
  width: number;
  boundsMax: number;
}

// ── ordering (collation keys as data) ──────────────────────────────────

export interface KeyTerm {
  field?: string;
  const?: number;
  scale?: number;
}

export interface OrderingKey {
  /** Level (or overlay itemLevel/childLevel) name this key applies to. */
  level: string;
  primary: KeyTerm[];
  secondary: KeyTerm[];
}

// ── parameters ──────────────────────────────────────────────────────────

export interface ParamDecl {
  name: string;
  type: "stringArray" | "number";
  default: string[] | number;
}

// ── name heuristic (validateName's "looks like an address but doesn't
// parse" judgment) ─────────────────────────────────────────────────────
//
// jd.ts's LOOKS_NUMERIC (/^[0-9][0-9.\-]*$/) distinguishes "malformed
// address" from "simply not addressed" for validateName's malformed_name
// finding. It is NOT derivable from the grammar's own token patterns (a
// malformed token like "10-29" or "6.11" is, definitionally, something NO
// level's tokenPattern matches) — it needs its own small primitive-composed
// character-class heuristic. FINDING (see report): this is real grammar
// knowledge ("addresses in this scheme start with a digit") that only
// applies to digit-based schemes — a classification-token scheme (PARA,
// GTD) has no numeric-address concept at all and should omit this entirely
// (validateName becomes a no-op, which the derived capabilities already
// signal via itemAddresses:false).

export interface NameHeuristic {
  /** First character of the candidate leading token must be a digit. */
  firstDigit: boolean;
  /** Character classes allowed for the remaining characters. */
  restChars: Array<"digit" | "." | "-">;
}

// ── the definition itself ──────────────────────────────────────────────

export interface SchemeDefinition {
  name: string;
  levels: LevelDef[];
  addressKinds: AddressKindDef[];
  overlays: OverlayDef[];
  allocation: AllocationRule[];
  ordering: OrderingKey[];
  parameters: ParamDecl[];
  /** Absent = validateName never reports malformed_name (no numeric-address
   * heuristic applies — appropriate for a classification-token scheme). */
  nameHeuristic?: NameHeuristic;
}
