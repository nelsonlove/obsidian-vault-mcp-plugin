// generic-provider.ts — SPIKE. Design-validation code only; do not ship.
//
// A ScopeProvider implementation over a compiled SchemeDefinition (reusing
// provider.ts's real types — the runtime interface is meant to stay
// untouched per the design brief). Every method here is written against
// GENERIC grammar data (Grammar from compile.ts) — level names, overlay
// names, allocation rules, ordering keys — never against JD-specific string
// literals. Where the algorithm still had to encode JD-shaped STRUCTURE
// (e.g. "an allocation rule can be shadowed by an ancestor's overlay
// activation") that structure is described in a comment and flagged in the
// design-validation report as a place the schema had to grow a concept
// beyond the brief's starting sketch, not hidden.

import type { Address, Capabilities, Member, Scope, SchemeFinding, ScopeProvider } from "../src/kernel/scheme/provider.js";
import type { AllocationRule, KeyTerm, OverlayDef } from "./definition.js";
import { Grammar, type ParsedToken } from "./compile.js";

// ── path utilities (grammar-agnostic string plumbing, ported from jd.ts —
// these know nothing about JD's grammar, only about "leading token in a
// filename" / "folder segments in a path", so they're shared as-is) ──────

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function folderSegments(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

function folderToken(segment: string): string {
  return segment.split(" ")[0];
}

function idTokenFromName(name: string): string {
  const token = name.split(" ")[0];
  const plus = token.indexOf("+");
  return plus === -1 ? token : token.slice(0, plus);
}

// ── capabilities: derived, not declared ─────────────────────────────────

function deriveCapabilities(g: Grammar): Capabilities {
  return {
    validate: true,
    itemAddresses: g.def.addressKinds.some((k) => k.itemLevel),
    allocate: g.def.allocation.length > 0,
    ordered: g.def.ordering.length > 0,
  };
}

// ── levels (Address.levels folder-path convention) ─────────────────────

function leafToken(g: Grammar, pt: ParsedToken): string {
  if (pt.overlay) {
    const overlay = g.def.overlays.find((o) => o.name === pt.overlay)!;
    if (overlay.childLevel && pt.level === overlay.childLevel.name) {
      return pt.fields[overlay.childLevel.leafField];
    }
    return pt.raw; // itemLevel always uses its own full raw token
  }
  const lvl = g.levels.get(pt.level)!.def;
  return lvl.leafField ? pt.fields[lvl.leafField] : pt.raw;
}

function levelsOf(g: Grammar, pt: ParsedToken): string[] {
  const ancestors = g.ancestors(pt); // immediate parent first, root last
  return [...ancestors.map((a) => a.token).reverse(), leafToken(g, pt)];
}

function toAddress(g: Grammar, pt: ParsedToken): Address {
  return { raw: pt.raw, kind: pt.level, levels: levelsOf(g, pt) };
}

// ── ordering key evaluation ──────────────────────────────────────────────
//
// "$raw" and "$parent" are sentinel field names (never a real capture
// name): the whole matched token as an integer, and this level's own
// parent token (one `parentOf` hop) as an integer. JD needs both — its
// expanded-item/fractal-id collation keys scale off the FULL 5-digit item
// number, not any single sub-field, which is why a plain named-field
// reference isn't enough on its own (see report).

function evalKeyTerm(g: Grammar, pt: ParsedToken, term: KeyTerm): number {
  const scale = term.scale ?? 1;
  if (term.const !== undefined) return term.const * scale;
  const field = term.field!;
  if (field === "$raw") return parseInt(pt.raw, 10) * scale;
  if (field === "$parent") {
    const parent = g.parentOf(pt);
    return parent ? parseInt(parent.token, 10) * scale : 0;
  }
  return parseInt(pt.fields[field], 10) * scale;
}

function evalKeyTerms(g: Grammar, pt: ParsedToken, terms: KeyTerm[]): number {
  return terms.reduce((sum, t) => sum + evalKeyTerm(g, pt, t), 0);
}

function sortKeyOf(g: Grammar, pt: ParsedToken): [number, number] {
  const key = g.def.ordering.find((k) => k.level === pt.level);
  if (!key) return [0, -1];
  return [evalKeyTerms(g, pt, key.primary), evalKeyTerms(g, pt, key.secondary)];
}

// ── container-capability + ancestor/chain walking over bare Scopes ─────
//
// Callers hand in a bare {kind, token} Scope with no ParsedToken/overlay
// provenance (see any `p.chainOf({kind:...})` call in the corpus) — chain
// walking here goes through Grammar.parentOfLevelToken, which re-derives
// fields and re-runs each overlay's OWN activation test rather than
// trusting level-name structure alone (see compile.ts's finding on this).

// FINDING (see report): the first version of this derived "does anything
// ever nest under this level" from `containedBy` references — which
// happens to work for JD (every non-item base level genuinely has
// something declared beneath it) but is WRONG in general: PARA's buckets
// are container-capable (a note or sub-folder can sit inside "Projects")
// even though NO level in the PARA definition declares containedBy
// pointing at them — there's nothing deeper in that sketch at all. The
// PARA/GTD sketches caught this; the JD-only parity suite never would
// have. The correct test is simply "is this level ITEM-level" — any
// container level (itemLevel: false) can hold folder contents, whether or
// not the schema also declares something formally nesting under it. The
// one JD-specific wrinkle: an overlay's itemLevel (expanded-item) is
// BOTH item-level AND container-capable, but only when it declares a
// childLevel (fractal-id) — expandedCategories items never get one.
function isContainerCapable(g: Grammar, levelName: string): boolean {
  const lvl = g.levels.get(levelName)?.def;
  if (lvl) return !lvl.itemLevel;
  for (const overlay of g.def.overlays) {
    if (overlay.itemLevel.name === levelName) return !!overlay.childLevel;
    if (overlay.childLevel?.name === levelName) return false;
  }
  return false;
}

function chainOfScope(g: Grammar, scope: Scope): Array<{ level: string; token: string }> {
  const chain: Array<{ level: string; token: string }> = [{ level: scope.kind, token: scope.token }];
  let cur = chain[0];
  for (;;) {
    const parent = g.parentOfLevelToken(cur.level, cur.token);
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

// ── scopeOf: the deepest validly-positioned scope containing a path ────
//
// Generalizes jd.ts's scopesAlongPath: walk folder segments top to bottom,
// extending the running scope chain only when a candidate token parses AND
// is container-capable AND sits in a POSITION consistent with the current
// scope — either directly under its natural parent (Grammar.parentOf),
// or, when the level declares `rootAllowed`, tolerated bare at the root
// (JD: a category folder with no area wrapper).

function scopesAlongPath(g: Grammar, path: string): Array<{ scope: Scope; index: number }> {
  const segments = folderSegments(path);
  const chain: Array<{ scope: Scope; index: number }> = [];
  let current: Scope | null = null;
  for (let i = 0; i < segments.length; i++) {
    const pt = g.parseToken(folderToken(segments[i]));
    if (!pt || !isContainerCapable(g, pt.level)) continue;
    const parent = g.parentOf(pt);
    const rootAllowed = g.levels.get(pt.level)?.def.rootAllowed ?? false;
    let consistent = false;
    if (current === null) {
      consistent = parent === null || rootAllowed;
    } else if (parent !== null && current.kind === parent.level && current.token === parent.token) {
      consistent = true;
    }
    if (!consistent) continue;
    current = { kind: pt.level, token: pt.raw };
    chain.push({ scope: current, index: i });
  }
  return chain;
}

// ── allocation: overlay-direct match, ancestor-shadow check, plain rule ─
//
// Reproduces jd.ts's nextFree/allocatable if/else-if DISPATCH ORDER
// generically:
//   1. an overlay whose surviving container (parentLevel) is scope's OWN
//      kind, and whose activation parameter contains scope's OWN token
//      directly, allocates via that overlay (expanded area / category).
//   2. otherwise, if scope's kind is genuinely container-capable for a
//      PLAIN rule but one of scope's ANCESTORS activates a DIFFERENT
//      overlay whose parentLevel is that ancestor's level, scope is
//      "shadowed" — swallowed into the ancestor's expanded band, and
//      allocation is refused (JD's item-1 bug fix: a category folded into
//      an expanded area is not independently decimal-allocatable).
//   3. otherwise, a plain (non-overlay) rule whose target level nests
//      directly under scope's kind allocates normally.
//
// FINDING (see report): step 2 — "shadowing" — is the one piece that
// isn't just interpreting brief-shaped primitives; it's a schema concept
// the brief didn't name (containment collapse reaching PAST a level that
// still structurally exists). It generalizes cleanly here because it's
// expressed over overlay/parameter data, not JD string literals, but the
// brief's allocation section should probably name it explicitly.

function overlayByName(g: Grammar, name: string): OverlayDef {
  return g.def.overlays.find((o) => o.name === name)!;
}

function shadowingOverlay(g: Grammar, scope: Scope): { level: string; token: string } | null {
  const ancestors = chainOfScope(g, scope).slice(1); // exclude scope itself
  for (const anc of ancestors) {
    for (const overlay of g.def.overlays) {
      if (overlay.parentLevel === anc.level && overlay.parentLevel !== scope.kind && g.paramSet(overlay.parameter).has(anc.token)) {
        return anc;
      }
    }
  }
  return null;
}

function allocateOverlay(g: Grammar, overlay: OverlayDef, rule: AllocationRule, scope: Scope, notes: string[]): Address | null {
  const base = g.overlayBase(overlay, scope.token);
  const used = new Set<number>();
  for (const note of notes) {
    const pt = g.parseToken(idTokenFromName(basename(note)));
    if (!pt) continue;
    if (pt.level === overlay.itemLevel.name && pt.overlay === overlay.name) {
      const parent = g.parentOf(pt);
      if (parent && parent.level === scope.kind && parent.token === scope.token) {
        used.add(rule.field === "$raw" ? parseInt(pt.raw, 10) : parseInt(pt.fields[rule.field], 10));
      }
    } else if (rule.alsoCountFrom && overlay.childLevel && pt.level === overlay.childLevel.name && pt.overlay === overlay.name) {
      const parent = g.parentOf(pt); // the item token this fractal belongs to
      if (parent) {
        const grand = g.parentOfLevelToken(parent.level, parent.token);
        if (grand && grand.level === scope.kind && grand.token === scope.token) {
          used.add(parseInt(parent.token, 10));
        }
      }
    }
  }
  const next = used.size === 0 ? base + 1 : Math.max(...used) + 1;
  if (next > base + rule.boundsMax) return null;
  const width = g.itemWidth(overlay);
  const pt = g.parseToken(String(next).padStart(width, "0"));
  return pt ? toAddress(g, pt) : null;
}

function nextFreeGeneric(g: Grammar, scope: Scope, notes: string[]): Address | null {
  for (const rule of g.def.allocation) {
    if (!rule.overlay) continue;
    const overlay = overlayByName(g, rule.overlay);
    if (overlay.parentLevel !== scope.kind) continue;
    if (!g.paramSet(overlay.parameter).has(scope.token)) continue;
    return allocateOverlay(g, overlay, rule, scope, notes);
  }
  if (shadowingOverlay(g, scope)) return null;
  for (const rule of g.def.allocation) {
    if (rule.overlay) continue;
    const lvl = g.levels.get(rule.level)?.def;
    if (!lvl || lvl.containedBy !== scope.kind) continue;
    const floor = g.paramNumber(rule.floor, 0);
    const used = new Set<number>();
    for (const note of notes) {
      const pt = g.parseToken(idTokenFromName(basename(note)));
      if (!pt || pt.level !== rule.level) continue;
      const parent = g.parentOf(pt);
      if (!parent || parent.level !== scope.kind || parent.token !== scope.token) continue;
      used.add(parseInt(pt.fields[rule.field], 10));
    }
    for (let n = floor; n <= rule.boundsMax; n++) {
      if (used.has(n)) continue;
      const decimal = String(n).padStart(rule.width, "0");
      const pt = g.parseToken(`${scope.token}.${decimal}`);
      return pt ? toAddress(g, pt) : null;
    }
    return null; // exhausted
  }
  return null;
}

function allocatableGeneric(g: Grammar, scope: Scope): { allocatable: boolean; hint?: string } {
  for (const rule of g.def.allocation) {
    if (!rule.overlay) continue;
    const overlay = overlayByName(g, rule.overlay);
    if (overlay.parentLevel !== scope.kind) continue;
    if (g.paramSet(overlay.parameter).has(scope.token)) return { allocatable: true };
  }
  const shadow = shadowingOverlay(g, scope);
  if (shadow) return { allocatable: false, hint: `allocate via scope "${shadow.token}"` };
  for (const rule of g.def.allocation) {
    if (rule.overlay) continue;
    const lvl = g.levels.get(rule.level)?.def;
    if (lvl && lvl.containedBy === scope.kind) return { allocatable: true };
  }
  return { allocatable: false, hint: "no allocation rule applies to this scope" };
}

// ── membersOf: ancestor-chain membership, generalized ───────────────────
//
// FINDING (see report): jd.ts's per-kind isMember switch turns out to be
// exactly "does `scope` appear anywhere in the candidate's ancestor
// chain" — a single generic predicate, once ancestors() exists, with NO
// per-level-kind branching needed. This is one of the cleanest wins in the
// port: the brief didn't call this out as a primitive, but it fell out of
// having ancestors() for other reasons (levelsOf, chainOf).

function membersOf(g: Grammar, scope: Scope, notes: string[]): Member[] {
  const rows: Array<{ path: string; pt: ParsedToken }> = [];
  for (const path of notes) {
    const pt = g.parseToken(idTokenFromName(basename(path)));
    if (!pt) continue;
    if (g.ancestors(pt).some((a) => a.level === scope.kind && a.token === scope.token)) {
      rows.push({ path, pt });
    }
  }
  rows.sort((a, b) => {
    const [ap, as_] = sortKeyOf(g, a.pt);
    const [bp, bs] = sortKeyOf(g, b.pt);
    return ap - bp || as_ - bs;
  });
  return rows.map(({ path, pt }) => ({ path, address: pt.raw }));
}

// ── expectedFolder ───────────────────────────────────────────────────────

function expectedFolder(g: Grammar, addr: Address, notes: string[]): string | null {
  if (addr.levels.length < 2) return null;
  const containerToken = addr.levels[addr.levels.length - 2];
  for (const note of notes) {
    const hit = scopesAlongPath(g, note).find((entry) => entry.scope.token === containerToken);
    if (hit) return folderSegments(note).slice(0, hit.index + 1).join("/");
  }
  return null;
}

// ── the provider ─────────────────────────────────────────────────────────

export function genericProvider(g: Grammar): ScopeProvider {
  const capabilities = deriveCapabilities(g);

  function parse(raw: string): Address | null {
    const pt = g.parseToken(raw.trim());
    return pt ? toAddress(g, pt) : null;
  }

  function format(addr: Address): string {
    return addr.raw;
  }

  function addressOf(path: string): Address | null {
    return parse(idTokenFromName(basename(path)));
  }

  function validateName(filename: string): SchemeFinding[] {
    const token = idTokenFromName(filename);
    if (g.looksLikeAddress(token) && g.parseToken(token) === null) {
      return [{ code: "malformed_name", path: filename, detail: `'${token}' looks like a ${g.def.name} address but does not parse` }];
    }
    return [];
  }

  return {
    capabilities,
    parse,
    format,
    addressOf,
    validateName,
    scopeOf(path: string): Scope | null {
      const chain = scopesAlongPath(g, path);
      return chain.length === 0 ? null : chain[chain.length - 1].scope;
    },
    chainOf(scope: Scope): Scope[] {
      return chainOfScope(g, scope).map(({ level, token }) => ({ kind: level, token }));
    },
    membersOf(scope: Scope, notes: string[]): Member[] {
      return membersOf(g, scope, notes);
    },
    expectedFolder(addr: Address, notes: string[]): string | null {
      return expectedFolder(g, addr, notes);
    },
    nextFree(scope: Scope, notes: string[]): Address | null {
      return nextFreeGeneric(g, scope, notes);
    },
    allocatable(scope: Scope) {
      return allocatableGeneric(g, scope);
    },
  };
}
