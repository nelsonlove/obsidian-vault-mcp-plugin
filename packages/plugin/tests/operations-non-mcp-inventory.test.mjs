/**
 * operations-non-mcp-inventory.test.mjs — WP0's second half.
 *
 * MCP is one door onto Governor. It is not the only one, and it is not the
 * important one: the accept gesture has NO MCP surface by design, so an
 * inventory that stopped at the bridge would omit precisely the operations
 * that create standing.
 *
 * This file inventories the rest — Obsidian commands, the review-pane
 * authority perimeter, and the automation entry points that run with no caller
 * at all — and pins the two structural properties the acceptance model rests
 * on:
 *
 *   1. governance contributes ZERO Obsidian commands. `obsidian_run_command`
 *      makes every command agent-reachable through `executeCommandById`, so an
 *      accept command would be a self-approval primitive one prompt-injection
 *      away. The absence is load-bearing, so it is asserted rather than
 *      assumed.
 *   2. the seven authority-bearing functions are module-scope and NOT
 *      exported. Export is what would make one reachable from a plugin
 *      instance, a view instance, or any other object an agent-facing path can
 *      get hold of.
 *
 * Both are true today. Neither was checked by anything before this file.
 *
 * The registry adds a third, at build time: an action marked `governorOnly`
 * cannot be bound to an agent-reachable surface. That is the static
 * counterpart to the pane's two runtime gesture layers (`addEventListener`
 * rather than `.onclick =`, plus `isRealGesture(evt)` requiring `isTrusted`).
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  scanCommands,
  scanGovernanceCommands,
  scanModuleScopeOnly,
  scanAutomationSites,
  scanFunctionReaches,
  scanExports,
  PLUGIN_SRC,
} from "./surface-scan.mjs";
import {
  COMMAND_SURFACES,
  AUTHORITY_SURFACES,
  AUTOMATION_SURFACES,
  ACCEPT_PERIMETER_FUNCTIONS,
  WIRING_EXPORTS,
  nonMcpActions,
  nonMcpBindings,
} from "../src/kernel/operations/inventory-non-mcp.ts";
import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import { MCP_SURFACE_INVENTORY } from "../src/kernel/operations/inventory-mcp.ts";

const commands = await scanCommands();

// ── Obsidian commands, both directions ───────────────────────────────────────

describe("non-MCP inventory — Obsidian commands", () => {
  const declared = new Map(COMMAND_SURFACES.map((r) => [r.id, r]));

  test("every declared command exists in the source", () => {
    const missing = [...declared.keys()].filter((id) => !commands.has(id));
    assert.deepEqual(missing, [], `declared but never registered: ${missing.join(", ")}`);
  });

  test("every registered command is declared", () => {
    const undeclared = [...commands.keys()].filter((id) => !declared.has(id));
    assert.deepEqual(
      undeclared,
      [],
      "these commands are registered but have no action — a command is as reachable as an MCP tool " +
        "(obsidian_run_command executes any of them by id), so it needs a row:\n" +
        undeclared.map((id) => `  ${id} (${commands.get(id).file})`).join("\n")
    );
  });

  test("the counts match", () => {
    assert.equal(declared.size, commands.size);
  });
});

// ── the property the acceptance model rests on ───────────────────────────────

describe("non-MCP inventory — governance contributes no command", () => {
  test("src/governance registers zero Obsidian commands", async () => {
    const found = await scanGovernanceCommands();
    assert.deepEqual(
      found,
      [],
      "a governance command would be reachable through obsidian_run_command's executeCommandById, " +
        "making the accept path agent-invocable:\n" + found.map((f) => `  ${f.id} in ${f.file}`).join("\n")
    );
  });

  test("no declared command's action is Governor-only", () => {
    for (const row of COMMAND_SURFACES) {
      assert.notEqual(row.authority, "governor-only", `command '${row.id}' must not bind an authority action`);
    }
  });
});

// ── the accept perimeter is unreachable by construction ──────────────────────

describe("non-MCP inventory — the accept perimeter stays module-scope", () => {
  test("every authority function named in the perimeter is present in wiring.ts", async () => {
    const { present } = await scanModuleScopeOnly("governance/wiring.ts", ACCEPT_PERIMETER_FUNCTIONS);
    assert.deepEqual(
      [...present].sort(),
      [...ACCEPT_PERIMETER_FUNCTIONS].sort(),
      "a function named in the accept perimeter no longer exists — the inventory is describing code that is gone"
    );
  });

  test("none of them is exported", async () => {
    const { exported } = await scanModuleScopeOnly("governance/wiring.ts", ACCEPT_PERIMETER_FUNCTIONS);
    assert.deepEqual(
      [...exported],
      [],
      "exporting an accept-equivalent function is what would let it be reached from a plugin instance, a view " +
        "instance, or any object an agent-facing path can obtain:\n" + [...exported].join(", ")
    );
  });
  test("the export set of wiring.ts is exactly the pinned list", async () => {
    // Checking the ten perimeter names closes ten instances. Pinning the whole
    // export set closes the CLASS: a new export — including one that captures
    // an accept-capable closure without being named after it — becomes a
    // visible decision rather than something a reviewer must happen to notice.
    const actual = await scanExports("governance/wiring.ts");
    assert.deepEqual(
      [...actual].sort(),
      [...WIRING_EXPORTS].sort(),
      "governance/wiring.ts's exports changed; confirm the new one carries no accept-capable closure, then update WIRING_EXPORTS"
    );
  });

  test("each action's `audited` claim matches whether its implementation reaches appendLog", async () => {
    // The previous draft asserted "the acceptance log records these" in a
    // comment and applied `retention: durable` to every authority action. Two
    // were wrong. A claim about existing behaviour belongs in a scan.
    //
    // `performAccept` and `performRevert` append through their delegates
    // (`acceptNote` / `revertNote`, which call an injected `appendLog`), so
    // those two names count as reaching the log. Each delegate is listed
    // explicitly rather than followed automatically.
    const reaches = await scanFunctionReaches(
      "governance/wiring.ts",
      ACCEPT_PERIMETER_FUNCTIONS,
      ["appendLog", "acceptNote", "revertNote"]
    );
    const registry = createActionRegistry();
    for (const action of nonMcpActions()) registry.register(action);
    for (const b of nonMcpBindings()) registry.bind(b);

    const wrong = [];
    for (const row of AUTHORITY_SURFACES) {
      const found = reaches.get(row.implementation);
      assert.ok(found !== null && found !== undefined, `could not delimit ${row.implementation} in wiring.ts`);
      const logs = found.size > 0;
      const action = registry.get(row.action, 1);
      const claimsDurable = action.retention.operation === "durable";
      if (logs !== claimsDurable) {
        wrong.push(
          `  ${row.action} (via ${row.implementation}): declares retention=${action.retention.operation}, ` +
            `but it ${logs ? "DOES" : "does NOT"} reach the acceptance log`
        );
      }
    }
    assert.deepEqual(wrong, [], "an audit claim that does not match the code is worse than no claim:\n" + wrong.join("\n"));
  });

  test("the two unaudited authority acts are named, so the gap cannot be forgotten", async () => {
    // This is a real product gap, not an inventory quirk: `performAdopt` is
    // the mass-silence capability and it writes no operation record at all,
    // and `setClassEnabled` changes what may be admitted without review with
    // no record of who changed it. Pinning the set means fixing either one
    // fails this test and forces the inventory to be updated with it.
    const registry = createActionRegistry();
    for (const action of nonMcpActions()) registry.register(action);
    for (const b of nonMcpBindings()) registry.bind(b);
    const unaudited = [...new Set(AUTHORITY_SURFACES.map((r) => r.action))]
      .filter((id) => registry.get(id, 1)?.retention.operation !== "durable")
      .sort();
    assert.deepEqual(unaudited, ["governance.adopt-baseline", "governance.set-auto-accept-class"]);
  });
});

// ── automation ───────────────────────────────────────────────────────────────

describe("non-MCP inventory — automation entry points", () => {
  test("every declared automation site exists in its named file", async () => {
    const scanned = await scanAutomationSites();
    const byFile = new Map();
    for (const s of scanned) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    for (const row of AUTOMATION_SURFACES) {
      assert.ok(
        byFile.has(row.file),
        `automation row '${row.id}' names ${row.file}, which contains no automation entry point at all`
      );
    }
  });

  test("`touchesAuthority` is enforced, not decoration", async () => {
    // The field was dead data in the first draft: declared, set, and read by
    // nothing. A flag that records "this automation can change authority
    // state" and then changes nothing is worse than no flag, because it reads
    // as a control.
    const authorityAutomationFiles = new Set(
      nonMcpBindings()
        .filter((b) => b.kind === "automation" && b.source)
        .filter((b) => AUTHORITY_SURFACES.some((r) => r.action === b.action))
        .map((b) => b.source)
    );
    for (const row of AUTOMATION_SURFACES) {
      if (row.touchesAuthority) {
        assert.ok(
          authorityAutomationFiles.has(row.file),
          `automation row '${row.id}' claims touchesAuthority but no authority action is bound to an automation ` +
            `surface in ${row.file} — the claim is not backed by a fenced action`
        );
      } else {
        assert.ok(
          !authorityAutomationFiles.has(row.file),
          `automation row '${row.id}' does NOT claim touchesAuthority, but an authority action is bound to an ` +
            `automation surface in ${row.file}`
        );
      }
    }
  });

  test("every file containing an automation entry point is represented", async () => {
    const scanned = await scanAutomationSites();
    const declaredFiles = new Set(AUTOMATION_SURFACES.map((r) => r.file));
    const unrepresented = [...new Set(scanned.map((s) => s.file))].filter((f) => !declaredFiles.has(f));
    assert.deepEqual(
      unrepresented,
      [],
      "these files subscribe to events, arm timers, or hook layout-ready but have no automation row — work that " +
        "runs with no caller is the hardest kind to notice, so it must be declared:\n" +
        unrepresented.map((f) => `  ${f}`).join("\n")
    );
  });
});

// ── the registry accepts the whole non-MCP set ───────────────────────────────

describe("non-MCP inventory — builds a valid action registry", () => {
  const registry = createActionRegistry();
  for (const action of nonMcpActions()) registry.register(action);
  for (const b of nonMcpBindings()) registry.bind(b);
  const problems = registry.validate();

  test("validates with no problems", () => {
    assert.deepEqual(problems.map((p) => `${p.code}: ${p.message}`), []);
  });

  test("every authority action is Governor-only and carries the authority class", () => {
    for (const row of AUTHORITY_SURFACES) {
      const action = registry.get(row.action, 1);
      assert.ok(action, `${row.action} is not registered`);
      assert.equal(action.authority.governorOnly, true, `${row.action} must be Governor-only`);
      assert.ok(action.changeClasses.includes("authority"), `${row.action} must carry the authority class`);
    }
  });

  test("every authority binding is ui or automation — never agent-reachable", () => {
    for (const b of nonMcpBindings()) {
      const action = registry.get(b.action, b.actionVersion);
      if (!action?.authority.governorOnly) continue;
      assert.ok(
        b.kind === "ui" || b.kind === "automation" || b.kind === "internal",
        `authority surface '${b.id}' is bound as '${b.kind}', which an agent can reach`
      );
    }
  });

  test("no authority ACTION id appears in the MCP inventory", () => {
    // `row.action`, not `row.id`. Checking the surface id would be vacuous:
    // surface ids are dotted (`governance.pane.accept`) and MCP tool names are
    // snake_case, so they cannot collide by construction and the assertion
    // would pass no matter what. The action id is the thing that could
    // plausibly be exposed as a tool, which is the mistake worth catching.
    const mcpTools = new Set(MCP_SURFACE_INVENTORY.map((r) => r.tool));
    for (const row of AUTHORITY_SURFACES) {
      assert.ok(!mcpTools.has(row.action), `authority action '${row.action}' also appears as an MCP tool`);
    }
  });
});

// ── the registry REFUSES the thing it exists to refuse ───────────────────────

describe("non-MCP inventory — binding an authority action to MCP fails the build", () => {
  test("the fence is live, not merely documented", () => {
    const registry = createActionRegistry();
    for (const action of nonMcpActions()) registry.register(action);
    for (const b of nonMcpBindings()) registry.bind(b);
    // The exact mistake a future contributor might make: exposing accept as a tool.
    registry.bind({ kind: "mcp", id: "obsidian_accept_proposal", action: AUTHORITY_SURFACES[0].action, actionVersion: 1 });
    const codes = registry.validate().map((p) => p.code);
    assert.ok(
      codes.includes("authority_agent_surface"),
      `binding an authority action to an MCP surface must fail validation; got: ${codes.join(", ") || "(no problems)"}`
    );
  });
});

// ── the command scan is proven, not assumed ──────────────────────────────────

describe("non-MCP inventory — the command scan is proven against a planted command", () => {
  const planted = resolvePath(PLUGIN_SRC, "__command-scan-scratch.ts");
  after(() => rm(planted, { force: true }));

  test("a newly added command is caught and reported as undeclared", async () => {
    await writeFile(
      planted,
      [
        "// [test artifact — safe to delete] planted by operations-non-mcp-inventory.test.mjs",
        "export function registerPlanted(plugin: { addCommand: (c: unknown) => void }) {",
        '  plugin.addCommand({ id: "planted-violation", name: "Planted", callback: () => {} });',
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    const rescan = await scanCommands();
    assert.ok(
      rescan.has("planted-violation"),
      "the command scan no longer matches this repo's addCommand shape — it would silently under-report a new command"
    );
  });
});
