// jd-definition.ts — SPIKE. Design-validation code only; do not ship.
//
// Johnny Decimal expressed IN the SchemeDefinition schema (definition.ts),
// with parameters expandedAreas / expandedCategories / contentDecimalFloor
// matching jd.ts's JdConfig exactly (same defaults) so genericProvider ports
// against the SAME default configuration the real corpus assumes.

import type { SchemeDefinition } from "./definition.js";

export const JD_DEFINITION: SchemeDefinition = {
  name: "johnny-decimal",

  levels: [
    // area: "X0-X9" — two single-digit captures either side of literal
    // separators, tied together by a sameDigit constraint. No dedicated
    // "digitRange" primitive needed (see definition.ts's header note).
    {
      name: "area",
      tokenPattern: {
        parts: [
          { kind: "digits", name: "bandLo", width: 1 },
          { kind: "literal", text: "0-" },
          { kind: "digits", name: "bandHi", width: 1 },
          { kind: "literal", text: "9" },
        ],
        sameDigit: [["bandLo", "bandHi"]],
      },
      containedBy: null,
      itemLevel: false,
    },
    // category: "XX"
    {
      name: "category",
      tokenPattern: { parts: [{ kind: "digits", name: "category", width: 2 }] },
      containedBy: "area",
      rootAllowed: true, // a bare category folder with no area wrapper is tolerated
      itemLevel: false,
      // areaOfCategory: first digit of the category, wrapped in the area template.
      parentTokenFormula: {
        parts: [
          { kind: "field", field: "category", charAt: 0 },
          { kind: "literal", text: "0-" },
          { kind: "field", field: "category", charAt: 0 },
          { kind: "literal", text: "9" },
        ],
      },
    },
    // id: "XX.YY" or "XX.YYY" (2-3 digit decimal, survey's widening)
    {
      name: "id",
      tokenPattern: {
        parts: [
          { kind: "digits", name: "category", width: 2 },
          { kind: "literal", text: "." },
          { kind: "digitsVariant", name: "decimal", widths: [2, 3] },
        ],
      },
      containedBy: "category",
      itemLevel: true,
      parentTokenField: "category",
      leafField: "decimal", // Address.levels ends in "11", not "06.11" — ported verbatim from jd.ts's levelsOf; see report.
    },
  ],

  addressKinds: [
    { level: "area", itemLevel: false },
    { level: "category", itemLevel: false },
    { level: "id", itemLevel: true },
    { level: "expanded-item", itemLevel: true },
    { level: "fractal-id", itemLevel: true },
  ],

  overlays: [
    // expandedAreas: a whole area band (e.g. "90-99") uses flat 5-digit
    // ids; the category folder disappears; a fractal-id level nests under
    // each item.
    {
      name: "expandedAreas",
      parameter: "expandedAreas",
      testLevel: "category", // tested via the item's own 2-digit prefix...
      testKeyFormula: {
        // ...derived to its enclosing area (areaOfCategory again — same
        // formula shape as category's own parentTokenFormula above, just
        // applied to a different level's "category" field).
        parts: [
          { kind: "field", field: "category", charAt: 0 },
          { kind: "literal", text: "0-" },
          { kind: "field", field: "category", charAt: 0 },
          { kind: "literal", text: "9" },
        ],
      },
      parentLevel: "area",
      itemLevel: {
        name: "expanded-item",
        tokenPattern: {
          parts: [
            { kind: "digits", name: "category", width: 2 },
            { kind: "digits", name: "seq", width: 3 },
          ],
        },
        base: "bandDigit",
      },
      childLevel: {
        name: "fractal-id",
        tokenPattern: {
          parts: [
            { kind: "digits", name: "category", width: 2 },
            { kind: "digits", name: "seq", width: 3 },
            { kind: "literal", text: "." },
            { kind: "digits", name: "decimal", width: 2 },
          ],
        },
        parentTokenFormula: {
          parts: [
            { kind: "field", field: "category" },
            { kind: "field", field: "seq" },
          ],
        },
        leafField: "decimal",
      },
    },
    // expandedCategories: a single category (e.g. "27") uses flat 5-digit
    // ids; the category folder SURVIVES. No childLevel — fractal-ids only
    // exist under an expanded AREA in this version (jd.ts's allocatable()
    // explicitly refuses fractal allocation under an expanded-item that
    // came from an expanded category too, but PARSING one — e.g.
    // "27021.10" — is rejected outright: RE_FRACTAL only checks
    // expandedAreas. Modeled here by simply not declaring a childLevel).
    {
      name: "expandedCategories",
      parameter: "expandedCategories",
      testLevel: "category", // tested directly — no derivation
      parentLevel: "category",
      itemLevel: {
        name: "expanded-item",
        tokenPattern: {
          parts: [
            { kind: "digits", name: "category", width: 2 },
            { kind: "digits", name: "seq", width: 3 },
          ],
        },
        base: "category",
      },
    },
  ],

  allocation: [
    // Plain category: lowest-free two-digit decimal, floor from the
    // contentDecimalFloor parameter (default 10 — standard zeros .00-.09
    // reserved).
    {
      level: "id",
      strategy: "lowest-free",
      floor: { param: "contentDecimalFloor", default: 10 },
      field: "decimal",
      width: 2,
      boundsMax: 99,
    },
    // Expanded area band: max-plus-one over the full 5-digit value; a
    // fractal-id's PARENT item also counts as "used" (a fractal child
    // implies its parent item already exists).
    {
      level: "expanded-item",
      overlay: "expandedAreas",
      strategy: "max-plus-one",
      field: "$raw",
      alsoCountFrom: { level: "fractal-id" },
      width: 5,
      boundsMax: 9999, // relative to band base (base+1 .. base+9999)
    },
    // Expanded category: max-plus-one over the full 5-digit value.
    {
      level: "expanded-item",
      overlay: "expandedCategories",
      strategy: "max-plus-one",
      field: "$raw",
      width: 5,
      boundsMax: 999, // relative to category base (base+1 .. base+999)
    },
  ],

  // Collation keys as data (item 2 / worker-1's fractal-collation fix, both
  // encoded structurally rather than as bespoke sort-comparator code).
  // "$raw" / "$parent" are the two sentinel KeyTerm fields the generic
  // provider recognizes (see generic-provider.ts's evalKeyTerms): the
  // whole matched token as an integer, and the level's OWN parent token
  // (computed via parentOf) as an integer. Both are needed here because
  // JD's expanded-item/fractal-id collation keys are scaled off the FULL
  // 5-digit item number (e.g. 92021), not any one sub-field of it — see
  // report for why this couldn't just be "the seq field".
  ordering: [
    { level: "category", primary: [{ field: "category" }], secondary: [{ const: -1 }] },
    { level: "id", primary: [{ field: "category" }], secondary: [{ field: "decimal" }] },
    {
      level: "expanded-item",
      primary: [{ field: "category" }],
      secondary: [{ field: "$raw", scale: 1000 }],
    },
    {
      level: "fractal-id",
      primary: [{ field: "category" }],
      secondary: [{ field: "$parent", scale: 1000 }, { const: 1 }, { field: "decimal" }],
    },
  ],

  parameters: [
    { name: "expandedAreas", type: "stringArray", default: ["90-99"] },
    { name: "expandedCategories", type: "stringArray", default: ["27"] },
    { name: "contentDecimalFloor", type: "number", default: 10 },
  ],

  // LOOKS_NUMERIC, ported: a leading token starting with a digit, made up
  // of digits/./- , that nonetheless fails every level's tokenPattern is
  // reported as malformed_name rather than silently "not addressed".
  nameHeuristic: { firstDigit: true, restChars: ["digit", ".", "-"] },
};
