/**
 * parity.test.mjs — SPIKE. Design-validation code only; do not ship.
 *
 * A REPRESENTATIVE subset of the real jd.ts corpus (scheme-jd.test.mjs +
 * scheme-jd-scopes.test.mjs), ported to run against
 * genericProvider(compile(JD_DEFINITION).instantiate()) instead of
 * jdProvider(DEFAULT_JD_CONFIG). Same expected values as the real corpus —
 * this IS the acid test the design brief specifies ("byte-identical parse/
 * format/allocation behavior").
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../spike/compile.js";
import { JD_DEFINITION } from "../spike/jd-definition.js";
import { genericProvider } from "../spike/generic-provider.js";

const p = genericProvider(compile(JD_DEFINITION).instantiate());

// ── capabilities ─────────────────────────────────────────────────────────

describe("capabilities (derived, not declared)", () => {
  test("JD is a fully-capable definition", () => {
    assert.deepEqual(p.capabilities, { validate: true, itemAddresses: true, allocate: true, ordered: true });
  });
});

// ── parse: all five shapes ──────────────────────────────────────────────

describe("parse — the five JD shapes", () => {
  test("id (XX.YY)", () => {
    const a = p.parse("06.11");
    assert.equal(a?.kind, "id");
    assert.deepEqual(a?.levels, ["00-09", "06", "11"]);
  });

  test("id widened to a 3-digit decimal (XX.YYY)", () => {
    const a = p.parse("06.110");
    assert.equal(a?.kind, "id");
    assert.deepEqual(a?.levels, ["00-09", "06", "110"]);
  });

  test("area (XX-YY)", () => {
    const a = p.parse("00-09");
    assert.equal(a?.kind, "area");
    assert.deepEqual(a?.levels, ["00-09"]);
  });

  test("category (XX)", () => {
    const a = p.parse("06");
    assert.equal(a?.kind, "category");
    assert.deepEqual(a?.levels, ["00-09", "06"]);
  });

  test("expanded-item in an expanded AREA (90-99) — no category folder", () => {
    const a = p.parse("92021");
    assert.equal(a?.kind, "expanded-item");
    assert.deepEqual(a?.levels, ["90-99", "92021"]);
  });

  test("expanded-item in an expanded CATEGORY (27) — category folder survives", () => {
    const a = p.parse("27001");
    assert.equal(a?.kind, "expanded-item");
    assert.deepEqual(a?.levels, ["20-29", "27", "27001"]);
  });

  test("fractal-id (NNNNN.YY) inside an expanded area", () => {
    const a = p.parse("92021.10");
    assert.equal(a?.kind, "fractal-id");
    assert.deepEqual(a?.levels, ["90-99", "92021", "10"]);
  });

  test("a fractal id inside an expanded CATEGORY (not an expanded area) does not parse", () => {
    assert.equal(p.parse("27021.10"), null);
  });

  test("a bare 5-digit token outside both expandedAreas and expandedCategories does not parse", () => {
    assert.equal(p.parse("12345"), null);
  });

  test("digits must match in an area token", () => {
    assert.equal(p.parse("10-29"), null);
  });

  test("rejects malformed ids", () => {
    assert.equal(p.parse("26 2.18"), null);
    assert.equal(p.parse("nope"), null);
  });

  test("trims surrounding whitespace", () => {
    const a = p.parse("  06.11  ");
    assert.equal(a?.kind, "id");
    assert.equal(a?.raw, "06.11");
  });
});

// ── format round-trip ────────────────────────────────────────────────────

describe("format", () => {
  test("round-trips every shape", () => {
    for (const raw of ["06.11", "06.110", "00-09", "06", "92021", "27001", "92021.10"]) {
      assert.equal(p.format(p.parse(raw)), raw);
    }
  });
});

// ── validateName ─────────────────────────────────────────────────────────

describe("validateName", () => {
  test("a leading token that looks numeric but does not parse is malformed_name", () => {
    const findings = p.validateName("10-29 Something.md");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].code, "malformed_name");
    assert.match(findings[0].detail, /10-29/);
  });

  test("a valid JD id produces no findings", () => {
    assert.deepEqual(p.validateName("06.11 Foo bar.md"), []);
  });

  test("a plain non-numeric name produces no findings", () => {
    assert.deepEqual(p.validateName("plain note.md"), []);
  });
});

// ── scopeOf: ancestor-chain positional validation ───────────────────────

describe("scopeOf — positionally-validated ancestor chain", () => {
  test("a note two folders deep resolves to its category", () => {
    assert.deepEqual(p.scopeOf("00-09 System/06 Agent tooling/06.11 Vault MCP.md"), { kind: "category", token: "06" });
  });

  test("an id's own attachment folder is NOT a nested category, even when its name looks like one", () => {
    const path = "00-09 System/06 Agent tooling/06.11 Vault MCP/11 Attachments/photo.md";
    assert.deepEqual(p.scopeOf(path), { kind: "category", token: "06" });
  });

  test("a category token nested one level too deep (inside another category) is not a scope", () => {
    const path = "50-59 Something/52 Other/06 Rogue/06.01 Fake.md";
    assert.deepEqual(p.scopeOf(path), { kind: "category", token: "52" });
  });

  test("an expanded-item folder (within an expanded area) is its own scope", () => {
    assert.deepEqual(p.scopeOf("90-99 Projects/92021 Big thing/92021.10 Sub.md"), { kind: "expanded-item", token: "92021" });
  });
});

// ── chainOf ──────────────────────────────────────────────────────────────

describe("chainOf — self first, root last", () => {
  test("an expanded-item in an expanded AREA chains straight to the area (no category level)", () => {
    assert.deepEqual(p.chainOf({ kind: "expanded-item", token: "92021" }), [
      { kind: "expanded-item", token: "92021" },
      { kind: "area", token: "90-99" },
    ]);
  });

  test("an expanded-item in an expanded CATEGORY chains through the category", () => {
    assert.deepEqual(p.chainOf({ kind: "expanded-item", token: "27001" }), [
      { kind: "expanded-item", token: "27001" },
      { kind: "category", token: "27" },
      { kind: "area", token: "20-29" },
    ]);
  });
});

// ── membersOf: collation, including the 27001-between-26-and-28 case ───

describe("membersOf — collation as data", () => {
  test("a category's members are its ids, sorted numerically by decimal", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.00 JDex.md",
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      "00-09 System/06 Agent tooling/06.12 Bridge.md",
    ];
    assert.deepEqual(
      p.membersOf({ kind: "category", token: "06" }, notes).map((m) => m.address),
      ["06.00", "06.11", "06.12"],
    );
  });

  test("area listing sorts an expanded category's members between its numeric neighbors", () => {
    const notes = [
      "20-29 Something/28 Foo/28.11 X.md",
      "20-29 Something/27 Expanded/27002 Second.md",
      "20-29 Something/26 Bar/26.11 Y.md",
      "20-29 Something/27 Expanded/27001 First.md",
    ];
    const members = p.membersOf({ kind: "area", token: "20-29" }, notes);
    assert.deepEqual(
      members.map((m) => m.address),
      ["26.11", "27001", "27002", "28.11"],
    );
  });

  test("a fractal-id sorts immediately after its own parent item, before the next item", () => {
    const notes = [
      "90-99 Projects/92022 Other.md",
      "90-99 Projects/92021 Big thing/92021.10 Sub.md",
      "90-99 Projects/92021 Big thing.md",
    ];
    const members = p.membersOf({ kind: "area", token: "90-99" }, notes);
    assert.deepEqual(
      members.map((m) => m.address),
      ["92021", "92021.10", "92022"],
    );
  });

  test("multiple fractal children stay grouped under their own parent, in decimal order", () => {
    const notes = [
      "90-99 Projects/92022 Other.md",
      "90-99 Projects/92021 Big thing/92021.11 B.md",
      "90-99 Projects/92021 Big thing.md",
      "90-99 Projects/92021 Big thing/92021.10 A.md",
      "90-99 Projects/92020 Prior.md",
    ];
    const members = p.membersOf({ kind: "area", token: "90-99" }, notes);
    assert.deepEqual(
      members.map((m) => m.address),
      ["92020", "92021", "92021.10", "92021.11", "92022"],
    );
  });

  test("numeric sort, not lexical: a 3-digit decimal (110) sorts after 11 and 12", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.110 Third.md",
      "00-09 System/06 Agent tooling/06.11 First.md",
      "00-09 System/06 Agent tooling/06.12 Second.md",
    ];
    assert.deepEqual(
      p.membersOf({ kind: "category", token: "06" }, notes).map((m) => m.address),
      ["06.11", "06.12", "06.110"],
    );
  });
});

// ── expectedFolder ───────────────────────────────────────────────────────

describe("expectedFolder", () => {
  const NOTES = [
    "00-09 System/00.00 Index.md",
    "00-09 System/06 Agent tooling/06.00 JDex.md",
    "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  ];

  test("an id's expected folder is its category's actual folder", () => {
    assert.equal(p.expectedFolder(p.parse("06.13"), NOTES), "00-09 System/06 Agent tooling");
  });

  test("a rogue folder sharing the container's bare token, but wrongly positioned, is ignored", () => {
    const notes = [
      "50-59 Something/52 Other/06 Rogue/06.01 Fake.md",
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    ];
    assert.equal(p.expectedFolder(p.parse("06.13"), notes), "00-09 System/06 Agent tooling");
  });
});

// ── nextFree: lowest-free + floor + expanded max+1 + exhaustion ────────

describe("nextFree", () => {
  const NOTES = [
    "00-09 System/06 Agent tooling/06.00 JDex.md",
    "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    "00-09 System/06 Agent tooling/06.12 Bridge.md",
    "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  ];

  test("category scope: lowest unused decimal >= 10 (standard zeros reserved)", () => {
    assert.equal(p.format(p.nextFree({ kind: "category", token: "06" }, NOTES)), "06.10");
  });

  test("a full category (all 10..99 used) is exhausted -> null", () => {
    const notes = [];
    for (let n = 10; n <= 99; n++) notes.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    assert.equal(p.nextFree({ kind: "category", token: "06" }, notes), null);
  });

  test("configurable contentDecimalFloor: floor 5 -> content starts at .05", () => {
    const withFloor5 = genericProvider(compile(JD_DEFINITION).instantiate({ contentDecimalFloor: 5 }));
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    assert.equal(withFloor5.format(withFloor5.nextFree({ kind: "category", token: "06" }, notes)), "06.05");
  });

  test("an area scope (not expanded) cannot allocate -> null", () => {
    assert.equal(p.nextFree({ kind: "area", token: "00-09" }, NOTES), null);
  });

  test("a category scope whose area is expanded is NOT decimal-allocatable -> null (item 1 bug fix)", () => {
    assert.equal(p.nextFree({ kind: "category", token: "92" }, NOTES), null);
  });

  test("an expanded area allocates the next 5-digit sequential id, counting fractal children's parent", () => {
    assert.equal(p.format(p.nextFree({ kind: "area", token: "90-99" }, NOTES)), "92022");
  });

  test("an expanded area with nothing used yet starts at <band-digit>0001", () => {
    assert.equal(p.format(p.nextFree({ kind: "area", token: "90-99" }, [])), "90001");
  });

  test("an expanded area exhausted at 99999 -> null", () => {
    assert.equal(p.nextFree({ kind: "area", token: "90-99" }, ["90-99 Projects/99999 Last.md"]), null);
  });

  test("an expanded category allocates the next 5-digit sequential id", () => {
    const notes = ["20-29 Something/27 Expanded/27001 First.md"];
    assert.equal(p.format(p.nextFree({ kind: "category", token: "27" }, notes)), "27002");
  });

  test("an expanded category exhausted at <cat>999 -> null", () => {
    assert.equal(p.nextFree({ kind: "category", token: "27" }, ["20-29 Something/27 Expanded/27999 Last.md"]), null);
  });
});

// ── allocatable: structural, not vault-content-dependent ────────────────

describe("allocatable — category-in-expanded-band refusal", () => {
  test("a plain category is allocatable", () => {
    assert.deepEqual(p.allocatable({ kind: "category", token: "06" }), { allocatable: true });
  });

  test("an expanded category is allocatable", () => {
    assert.deepEqual(p.allocatable({ kind: "category", token: "27" }), { allocatable: true });
  });

  test("an expanded area is allocatable", () => {
    assert.deepEqual(p.allocatable({ kind: "area", token: "90-99" }), { allocatable: true });
  });

  test("a plain (non-expanded) area is not allocatable, with a hint", () => {
    const result = p.allocatable({ kind: "area", token: "00-09" });
    assert.equal(result.allocatable, false);
    assert.equal(typeof result.hint, "string");
    assert.ok(result.hint.length > 0);
  });

  test("a category folded into an expanded area's band is not allocatable, hinting the band scope by name", () => {
    const result = p.allocatable({ kind: "category", token: "92" });
    assert.equal(result.allocatable, false);
    assert.match(result.hint, /90-99/);
  });

  test("an expanded-item scope (fractal-id allocation) is not allocatable", () => {
    assert.equal(p.allocatable({ kind: "expanded-item", token: "92021" }).allocatable, false);
  });
});
