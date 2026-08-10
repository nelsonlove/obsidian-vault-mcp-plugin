/**
 * others.test.mjs — SPIKE. Design-validation code only; do not ship.
 *
 * SKETCH definitions for PARA, Zettelkasten, and GTD (scope-partition layer
 * only — contexts/vocab are registry territory per issue #97's amendment,
 * out of scope here). Existence proofs, not full grammars: enough to check
 * the derived-capability matrix the module's original spec-seed table
 * demands (JD/ZK/GTD/PARA: grammar-over-identities vs
 * grammar-over-classification-tokens) actually falls out of the SAME
 * compile()/genericProvider() machinery jd-definition.ts uses — no
 * classification-token special case needed anywhere in compile.ts or
 * generic-provider.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../spike/compile.js";
import { genericProvider } from "../spike/generic-provider.js";

// ── PARA: four fixed buckets, no addresses, no order, no allocation ────
//
// Each bucket is its own root-level container token (a literal-only
// tokenPattern — one primitive, zero digit captures). No addressKinds are
// itemLevel — PARA buckets classify notes; they never number them.

const PARA_DEFINITION = {
  name: "para",
  levels: [
    { name: "projects", tokenPattern: { parts: [{ kind: "literal", text: "Projects" }] }, containedBy: null, itemLevel: false },
    { name: "areas", tokenPattern: { parts: [{ kind: "literal", text: "Areas" }] }, containedBy: null, itemLevel: false },
    { name: "resources", tokenPattern: { parts: [{ kind: "literal", text: "Resources" }] }, containedBy: null, itemLevel: false },
    { name: "archives", tokenPattern: { parts: [{ kind: "literal", text: "Archives" }] }, containedBy: null, itemLevel: false },
  ],
  addressKinds: [], // no kind is item-level -> itemAddresses derives false
  overlays: [],
  allocation: [], // -> allocate derives false
  ordering: [], // -> ordered derives false (an unordered enum, by design)
  parameters: [],
};

// ── GTD: lists as scopes (the scope-partition layer only) ──────────────
//
// Same shape as PARA structurally — a fixed set of root containers — which
// is itself a finding: the schema doesn't need a DIFFERENT mechanism for
// "GTD lists" vs "PARA buckets"; they're the same primitive (an enumerated
// set of root-level classification containers) wearing different labels.

const GTD_DEFINITION = {
  name: "gtd",
  levels: [
    { name: "inbox", tokenPattern: { parts: [{ kind: "literal", text: "Inbox" }] }, containedBy: null, itemLevel: false },
    { name: "next-actions", tokenPattern: { parts: [{ kind: "literal", text: "Next Actions" }] }, containedBy: null, itemLevel: false },
    { name: "waiting-for", tokenPattern: { parts: [{ kind: "literal", text: "Waiting For" }] }, containedBy: null, itemLevel: false },
    { name: "someday-maybe", tokenPattern: { parts: [{ kind: "literal", text: "Someday Maybe" }] }, containedBy: null, itemLevel: false },
  ],
  addressKinds: [],
  overlays: [],
  allocation: [],
  ordering: [],
  parameters: [],
};

// ── Zettelkasten: timestamp ids, folgezettel partial order ──────────────
//
// FINDING (see report): "allocate=timestamp?" from the module brief turns
// out to be a real capability gap, not just an open question. This
// schema's AllocationRule strategies (lowest-free / max-plus-one) both
// scan EXISTING notes for a free slot in a bounded numeric space under a
// scope. A Zettelkasten id is generated fresh from wall-clock time — there
// is nothing to scan, no "next free slot", and no scope to bound it. No
// AllocationRule shape here can express "allocate = read the clock", so
// this sketch declares NO allocation rule and allocate legitimately
// derives false, even though a real ZK implementation absolutely can mint
// new ids (via a mechanism this schema doesn't model at all).
//
// FINDING 2: folgezettel order is PARTIAL (siblings under "10a" branch
// independently of "10b"), but Capabilities.ordered is a plain boolean —
// there is no way to say "ordered, but not totally". One ordering key is
// declared (proving the schema's ordering primitive applies to non-JD
// shapes too), which derives ordered:true — collapsing "partial" to "yes",
// losing the distinction the module's original capability table drew.

const ZK_DEFINITION = {
  name: "zettelkasten",
  levels: [
    {
      name: "note",
      tokenPattern: { parts: [{ kind: "digits", name: "timestamp", width: 12 }] }, // YYYYMMDDHHMM
      containedBy: null,
      itemLevel: true,
    },
  ],
  addressKinds: [{ level: "note", itemLevel: true }], // -> itemAddresses derives true
  overlays: [],
  allocation: [], // -> allocate derives false (see finding above)
  ordering: [{ level: "note", primary: [{ field: "timestamp" }], secondary: [] }], // -> ordered derives true (see finding 2)
  parameters: [],
};

describe("derived-capability matrix — the module's original JD/ZK/GTD/PARA table", () => {
  test("jd: item-address scheme, full capability set", () => {
    // Imported lazily to avoid coupling this file's failure to jd-definition's.
    return import("../spike/jd-definition.js").then(({ JD_DEFINITION }) => {
      const g = compile(JD_DEFINITION).instantiate();
      assert.deepEqual(genericProvider(g).capabilities, { validate: true, itemAddresses: true, allocate: true, ordered: true });
    });
  });

  test("para: classification-token scheme, no addresses/allocation/order", () => {
    const g = compile(PARA_DEFINITION).instantiate();
    assert.deepEqual(genericProvider(g).capabilities, { validate: true, itemAddresses: false, allocate: false, ordered: false });
  });

  test("gtd: classification-token scheme (scope-partition layer only), same shape as para", () => {
    const g = compile(GTD_DEFINITION).instantiate();
    assert.deepEqual(genericProvider(g).capabilities, { validate: true, itemAddresses: false, allocate: false, ordered: false });
  });

  test("zettelkasten: item-address scheme, but allocate is NOT expressible in this schema", () => {
    const g = compile(ZK_DEFINITION).instantiate();
    assert.deepEqual(genericProvider(g).capabilities, { validate: true, itemAddresses: true, allocate: false, ordered: true });
  });
});

describe("PARA — parse/scopeOf over enumerated root containers", () => {
  const p = genericProvider(compile(PARA_DEFINITION).instantiate());

  test("each bucket parses as its own container kind", () => {
    assert.equal(p.parse("Projects")?.kind, "projects");
    assert.equal(p.parse("Archives")?.kind, "archives");
  });

  test("a note under a bucket folder resolves scopeOf to that bucket", () => {
    assert.deepEqual(p.scopeOf("Projects/Some project/note.md"), { kind: "projects", token: "Projects" });
  });

  test("an unrecognized bucket name does not parse", () => {
    assert.equal(p.parse("SomethingElse"), null);
  });
});

describe("GTD — lists as scopes", () => {
  const p = genericProvider(compile(GTD_DEFINITION).instantiate());

  test("a list name parses as its own container kind", () => {
    assert.equal(p.parse("Next Actions")?.kind, "next-actions");
  });

  test("a task note under a list folder resolves scopeOf to that list", () => {
    assert.deepEqual(p.scopeOf("Waiting For/reply from Nelson.md"), { kind: "waiting-for", token: "Waiting For" });
  });
});

describe("Zettelkasten — timestamp ids, parse/format + itemAddresses", () => {
  const p = genericProvider(compile(ZK_DEFINITION).instantiate());

  test("a 12-digit timestamp parses as a note address", () => {
    const a = p.parse("202608100915");
    assert.equal(a?.kind, "note");
    assert.deepEqual(a?.levels, ["202608100915"]);
  });

  test("format round-trips", () => {
    assert.equal(p.format(p.parse("202608100915")), "202608100915");
  });

  test("nextFree is null everywhere — allocation isn't expressible for a clock-generated id", () => {
    assert.equal(p.nextFree({ kind: "note", token: "202608100915" }, []), null);
  });
});
