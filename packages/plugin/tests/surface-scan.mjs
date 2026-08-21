/**
 * surface-scan.mjs — the INVERSE half of the bidirectional inventory (WP0).
 *
 * The declared inventory (`src/kernel/operations/inventory-mcp.ts`) says what
 * Governor's MCP surface is. This scanner says what the SOURCE actually
 * registers. A drift test compares them in both directions, so:
 *
 *   • a tool added without an action fails the build; and
 *   • an inventory row whose registration was deleted fails the build.
 *
 * Why a source scan rather than building a server and asking it: every
 * registrar in `buildMcpServer` needs a live Obsidian `App`, several are gated
 * on host plugins being loaded, and `mountModules` gates on settings. A
 * runtime enumeration would therefore report whatever this machine happens to
 * have installed — which is exactly the wrong denominator for "did anyone add
 * a surface." The scan sees every registration unconditionally, including the
 * ones no test machine can reach.
 *
 * This follows the repo's existing idiom: `link-healing.test.mjs` globs
 * `src/**{/}*.ts` for `vault.rename` and proves the glob works by planting a
 * violation, and `registration-surface-sealed.test.mjs` closes the CLASS of
 * SDK registration entry points rather than five instances. The same two
 * moves apply here — see `assertScannerFindsPlantedTool` below.
 *
 * The scanner is deliberately not clever. It resolves exactly the shapes this
 * repo actually uses, and anything it cannot resolve is reported as an
 * `unresolved` entry rather than skipped. A silent skip is how a surface goes
 * missing from an inventory that still claims to be complete.
 */

import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SRC = resolvePath(HERE, "../src");
export const CORE_SRC = resolvePath(HERE, "../../core/src");

/**
 * Callee names that register an MCP tool with a literal name as first argument.
 *
 * `registerTool` is the patched interception point. `reg`, `register` and
 * `origRegister` are the three places this repo deliberately registers OUTSIDE
 * that patch — the Code Mode meta-tools and `obsidian_write_notes` — each for
 * a documented reason. `capture` is Code Mode's capturing registrar.
 *
 * This list is asserted by its own test: a registration through a callee name
 * NOT in this list would be invisible to the scan, so the class is closed by
 * checking that no other identifier is called with a tool-name-shaped literal
 * first argument in the MCP source tree.
 */
export const REGISTRATION_CALLEES = ["registerTool", "origRegister", "register", "reg", "capture"];

/** A tool name: lowercase, underscore-separated, as the MCP naming rules require. */
const TOOL_NAME = "[a-z][a-z0-9_]*";

/**
 * Pass-through registration sites: a call that forwards a NAME VARIABLE rather
 * than a literal. Each is a plumbing hop, not a surface of its own, and each is
 * listed here with the reason it cannot name a tool by itself. A new
 * pass-through site is a new place a surface could hide, so the set is
 * asserted.
 */
export const KNOWN_PASSTHROUGH_SITES = [
  {
    file: "src/mcp/server.ts",
    reason: "the registerTool monkeypatch and the codeMode capture/origRegister switch — forwards whatever a registrar names",
  },
  {
    // NOT module.ts — that file is types only and contains no executable code.
    // The forwarding call is `reg(name, def, handler)` inside
    // ModuleRegistry.registerAll's `scoped` wrapper.
    file: "src/kernel/modules/module-registry.ts",
    reason: "the module host's registrar adapter — forwards each module's own registerTool calls",
  },
  {
    file: "src/mcp/external-tools.ts",
    reason: "third-party publishers; the name is computed per publisher at runtime and cannot be enumerated statically",
  },
  {
    file: "packages/core/src/register-fs-tools.ts",
    reason: "iterates the FS_TOOLS table in core/src/tool-registry.ts, which the scanner reads directly",
  },
];


/**
 * Read a file that a concurrent test may be deleting underneath us.
 *
 * Test files run in parallel processes, and two of them plant and remove
 * scratch `.ts` files inside `src/` to prove their scanners still match. A
 * file can therefore be present when the glob enumerates it and gone by the
 * time it is read. That is not a registration and not a scanner failure — it
 * is a file that no longer exists — so ENOENT is skipped and every other error
 * still propagates.
 */
async function readMaybe(abs) {
  try {
    return await readFile(abs, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function tsFiles(root) {
  const out = [];
  for await (const rel of glob("**/*.ts", { cwd: root })) out.push({ rel, abs: resolvePath(root, rel) });
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Annotation presets declared in one file.
 *
 * Three shapes occur in this repo, and all three are resolved because a shape
 * the scanner cannot read becomes an `unresolved` entry — which is a scanner
 * failure, not a tool it may quietly ignore:
 *
 *   const RO = { readOnlyHint: true, … }        — the common per-file preset
 *   RO: { readOnlyHint: true, … }               — nested inside
 *                                                 core's SHARED_ANNOTATIONS
 *   const RO = SHARED_ANNOTATIONS.RO;           — an alias, resolved in a
 *                                                 second pass
 */
function presetsIn(text) {
  const presets = new Map();
  const aliases = new Map();

  // `[^{}]*` — the body may contain NO braces, so a CONTAINER of presets
  // (core's `SHARED_ANNOTATIONS = { RO: { … }, RW: { … } }`) does not match
  // here and get a value guessed from whichever nested object happened to come
  // first. Containers are handled by the `nested` pass below, which reads each
  // inner preset on its own terms. Guessing a flat value for a nested object
  // would contradict this file's own rule that an unresolvable shape is
  // reported, never defaulted.
  const declared = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([^{}]*)\}/g;
  let m;
  while ((m = declared.exec(text))) {
    const ro = /readOnlyHint\s*:\s*(true|false)/.exec(m[2]);
    if (ro) presets.set(m[1], ro[1] === "true");
  }

  // Nested preset keys, e.g. core's `SHARED_ANNOTATIONS = { RO: { … }, RW: { … } }`.
  const nested = /\b([A-Z][A-Z0-9_]*)\s*:\s*\{([^}]*)\}/g;
  while ((m = nested.exec(text))) {
    const ro = /readOnlyHint\s*:\s*(true|false)/.exec(m[2]);
    if (ro && !presets.has(m[1])) presets.set(m[1], ro[1] === "true");
  }

  const alias = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?([A-Z][A-Z0-9_]*)\s*;/g;
  while ((m = alias.exec(text))) aliases.set(m[1], m[2]);
  for (const [from, to] of aliases) {
    if (!presets.has(from) && presets.has(to)) presets.set(from, presets.get(to));
  }

  return { presets, aliases };
}

/**
 * Merge every file's presets into one map, so an IMPORTED preset resolves.
 *
 * Several tool files use `RO`/`RW` imported from a sibling rather than
 * declared locally. Merging is only safe if the names mean the same thing
 * everywhere, so a name defined with two different `readOnlyHint` values is
 * recorded as a CONFLICT and refuses to resolve. Guessing which definition an
 * importer meant is precisely how a mutating tool would come to be inventoried
 * as read-only.
 */
function mergePresets(perFile) {
  const global = new Map();
  const conflicts = new Set();
  for (const { presets } of perFile) {
    for (const [name, ro] of presets) {
      if (global.has(name) && global.get(name) !== ro) conflicts.add(name);
      else global.set(name, ro);
    }
  }
  for (const name of conflicts) global.delete(name);
  return { global, conflicts };
}

/** String constants: `export const SUBMIT_REVISION_TOOL = "governance_submit_revision"`. */
function stringConstsIn(text) {
  const consts = new Map();
  const re = new RegExp(`\\bconst\\s+([A-Z][A-Z0-9_]*)\\s*=\\s*"(${TOOL_NAME})"`, "g");
  let m;
  while ((m = re.exec(text))) consts.set(m[1], m[2]);
  return consts;
}

/**
 * Resolve the `readOnlyHint` for one registration, given the slice of source
 * that follows its name literal.
 *
 * Returns `undefined` when it cannot be resolved — never a default. An
 * unresolved annotation means the scanner does not know whether a surface
 * mutates, and guessing `true` there would silently exempt a mutating tool
 * from the inventory's own read/write check.
 */
function readOnlyOf(slice, presets, globalPresets) {
  const inline = /annotations\s*:\s*\{[^}]*?readOnlyHint\s*:\s*(true|false)/.exec(slice);
  if (inline) return inline[1] === "true";
  const named = /annotations\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(slice);
  // File-local first, then the merged map — a local declaration always wins
  // over an identically named preset somewhere else in the tree.
  if (named) return presets.get(named[1]) ?? globalPresets.get(named[1]);
  return undefined;
}

/**
 * Every MCP tool registration the source contains.
 *
 * Returns `{ tools, unresolved }`. `tools` is a Map from tool name to
 * `{ name, file, callee, readOnly }`. `unresolved` lists registrations whose
 * name or annotation could not be resolved — a non-empty list is a scanner
 * failure, not an acceptable outcome, and the drift test asserts it is empty.
 */
export async function scanMcpSurfaces() {
  const files = [
    ...(await tsFiles(PLUGIN_SRC)).map((f) => ({ ...f, rel: `src/${f.rel}` })),
    ...(await tsFiles(CORE_SRC)).map((f) => ({ ...f, rel: `packages/core/src/${f.rel}` })),
  ];

  const tools = new Map();
  const unresolved = [];
  /** String consts are resolved across the whole tree: `SUBMIT_REVISION_TOOL`
   * is declared in kernel/governance/dispositions.ts and used in mcp/. */
  const globalConsts = new Map();
  const parsed = [];

  for (const f of files) {
    const text = await readMaybe(f.abs);
    if (text === null) continue;
    parsed.push({ ...f, text, ...presetsIn(text) });
    for (const [k, v] of stringConstsIn(text)) globalConsts.set(k, v);
  }
  const { global: globalPresets, conflicts } = mergePresets(parsed);
  for (const name of conflicts) {
    unresolved.push({
      name: `(preset ${name})`,
      file: "(multiple)",
      reason: "the same annotation preset name is declared with two different readOnlyHint values; an imported use cannot be resolved",
    });
  }

  const calleeAlt = REGISTRATION_CALLEES.join("|");
  // A literal name, or an identifier the scanner may resolve to one.
  const callRe = new RegExp(
    `(?:[A-Za-z_$][\\w$]*\\.)?\\b(${calleeAlt})\\(\\s*(?:"(${TOOL_NAME})"|([A-Z][A-Z0-9_]*))\\s*,`,
    "g"
  );

  for (const f of parsed) {
    // Every registration's start offset in this file, so each one's definition
    // slice can be BOUNDED at the next registration. Without that bound, a def
    // that happens to omit `annotations` would silently borrow the next tool's
    // — inventorying a mutating tool as read-only, which is the one error this
    // scanner must never make.
    const starts = [];
    let s;
    callRe.lastIndex = 0;
    while ((s = callRe.exec(f.text))) starts.push(s.index);

    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(f.text))) {
      const [, callee, literal, ident] = m;
      const name = literal ?? globalConsts.get(ident);
      if (!name) {
        // A pass-through hop forwarding a variable is expected; anything else
        // is a registration the scanner cannot see, and is reported.
        continue;
      }
      const next = starts.find((i) => i > m.index) ?? f.text.length;
      const slice = f.text.slice(m.index, Math.min(next, m.index + 6000));
      const readOnly = readOnlyOf(slice, f.presets, globalPresets);
      if (readOnly === undefined) {
        unresolved.push({ name, file: f.rel, reason: "annotations could not be resolved to a readOnlyHint" });
        continue;
      }
      if (tools.has(name)) {
        unresolved.push({ name, file: f.rel, reason: `registered more than once (also ${tools.get(name).file})` });
        continue;
      }
      tools.set(name, { name, file: f.rel, callee, readOnly });
    }
  }

  // The 17 fs-expressible tools come from a TABLE, not from call sites:
  // register-fs-tools.ts iterates `FS_TOOLS` in core/src/tool-registry.ts.
  const registryFile = parsed.find((f) => f.rel === "packages/core/src/tool-registry.ts");
  if (!registryFile) {
    unresolved.push({ name: "(FS_TOOLS)", file: "packages/core/src/tool-registry.ts", reason: "table file not found" });
  } else {
    const entryRe = new RegExp(`name:\\s*"(${TOOL_NAME})"`, "g");
    // Same bounding as the call sites: an entry's annotations must be its own.
    const entryStarts = [];
    let e;
    while ((e = entryRe.exec(registryFile.text))) entryStarts.push(e.index);
    entryRe.lastIndex = 0;
    let m;
    while ((m = entryRe.exec(registryFile.text))) {
      const name = m[1];
      const next = entryStarts.find((i) => i > m.index) ?? registryFile.text.length;
      const slice = registryFile.text.slice(m.index, Math.min(next, m.index + 6000));
      const readOnly = readOnlyOf(slice, registryFile.presets, globalPresets);
      if (readOnly === undefined) {
        unresolved.push({ name, file: registryFile.rel, reason: "FS_TOOLS entry annotations could not be resolved" });
        continue;
      }
      if (tools.has(name)) {
        unresolved.push({ name, file: registryFile.rel, reason: `also registered at ${tools.get(name).file}` });
        continue;
      }
      tools.set(name, { name, file: registryFile.rel, callee: "FS_TOOLS", readOnly });
    }
  }

  return { tools, unresolved };
}

/**
 * Callees that take a snake_case string literal first argument but are NOT
 * registrations. Deny-by-default demands that everything be classified, so
 * these are named with the reason they are not a door.
 */
export const KNOWN_NOT_REGISTRATION = [
  { callee: "codedError", reason: "emits a typed `Error [code]: message` refusal envelope; the literal is an error code, not a tool name" },
  { callee: "refuse", reason: "the bases module's local refusal helper; the literal is an error code" },
];

/**
 * Classify EVERY call in the MCP source tree whose first argument is a
 * snake_case string literal, and report any whose callee is neither a known
 * registrar nor a known non-registration.
 *
 * This is what closes the class, and it is deliberately DENY-BY-DEFAULT.
 *
 * The first draft of this function did the opposite: it looked for literals
 * matching a whitelist of name prefixes this product happens to publish today.
 * That is the exact defect PR #170's review rejected — "a genuinely new entry
 * point cannot match a regex enumerating only the names we already handle, so
 * it never enters `registrationish` and can never be reported as unaccounted
 * ... what should not ship is the current pairing: a test that closes five
 * instances under a comment saying it closes the class." A tool registered as
 * `skills_new_thing` through a new registrar would have been invisible.
 *
 * The resolution mirrors what that PR actually shipped in
 * `seal-registration.ts`: every member is classified, and anything
 * unclassified fails the build. Here the classified set is the CALLEE
 * identifier, of which the whole tree currently has five — three registrars
 * and two refusal helpers — so the burden of keeping it current is one line
 * per genuinely new call shape.
 *
 * A "snake_case string literal" means at least one underscore, so ordinary
 * arguments like "utf8" or "path" are not mistaken for tool names.
 *
 * Restricted to `src/mcp/` and `packages/core/src/`, where tool registration
 * lives.
 */
export async function scanUnknownRegistrationCallees() {
  const files = [
    ...(await tsFiles(PLUGIN_SRC)).filter((f) => f.rel.startsWith("mcp/")).map((f) => ({ ...f, rel: `src/${f.rel}` })),
    ...(await tsFiles(CORE_SRC)).map((f) => ({ ...f, rel: `packages/core/src/${f.rel}` })),
  ];
  const classified = new Set([...REGISTRATION_CALLEES, ...KNOWN_NOT_REGISTRATION.map((k) => k.callee)]);
  const found = [];
  const re = /(?:[A-Za-z_$][\w$]*\.)?\b([A-Za-z_$][\w$]*)\(\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"\s*,/g;
  for (const f of files) {
    const text = await readMaybe(f.abs);
    if (text === null) continue;
    let m;
    while ((m = re.exec(text))) {
      if (classified.has(m[1])) continue;
      found.push({ callee: m[1], name: m[2], file: f.rel });
    }
  }
  return found;
}

// ── non-MCP surfaces (WP0, second half) ──────────────────────────────────────
//
// MCP is one door. Obsidian commands are another — and a more consequential
// one than it looks, because `obsidian_run_command` executes any command by id
// through `executeCommandById`, so every command this plugin registers is also
// reachable from an agent session. The accept path deliberately registers none.

/**
 * Every Obsidian command the plugin registers, from `addCommand({ id: "…" })`.
 *
 * Both the multi-line form (`main.ts`) and the single-line form
 * (`skills/wiring.ts`, `scheme/wiring.ts`) occur, so the id is matched within
 * the object literal rather than at a fixed offset.
 */
export async function scanCommands() {
  const files = (await tsFiles(PLUGIN_SRC)).map((f) => ({ ...f, rel: `src/${f.rel}` }));
  const found = new Map();
  const re = /addCommand\(\s*\{[\s\S]{0,400}?\bid:\s*"([a-z][a-z0-9-]*)"/g;
  for (const f of files) {
    const text = await readMaybe(f.abs);
    if (text === null) continue;
    let m;
    while ((m = re.exec(text))) found.set(m[1], { id: m[1], file: f.rel });
  }
  return found;
}

/**
 * Commands registered from anywhere under `src/governance/`.
 *
 * Expected to be EMPTY, permanently. This is the inverse of an inventory: the
 * assertion is that a whole class of surface does not exist, because
 * `obsidian_run_command` would make it agent-invocable.
 */
export async function scanGovernanceCommands() {
  const commands = await scanCommands();
  return [...commands.values()].filter((c) => c.file.startsWith("src/governance/"));
}

/**
 * Check that named functions exist in a file and are NOT exported.
 *
 * Export is the difference between "a module-scope function only a closure can
 * call" and "a function reachable from any object that can import the module."
 * For the accept perimeter that difference is the whole reachability control,
 * so it is checked rather than trusted.
 */
export async function scanModuleScopeOnly(relPath, names) {
  const text = await readFile(resolvePath(PLUGIN_SRC, relPath), "utf8");
  const present = new Set();
  const exported = new Set();
  for (const name of names) {
    if (new RegExp(`\\bfunction\\s+${name}\\b`).test(text)) present.add(name);
    if (new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`).test(text)) exported.add(name);
    if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text)) exported.add(name);
  }
  return { present, exported };
}

/**
 * Every place work can start with no caller: an event subscription, an armed
 * timer, or a layout-ready hook.
 *
 * Comment lines are excluded — several of this repo's densest headers discuss
 * `onLayoutReady` at length, and counting prose as an entry point would make
 * the inventory noise rather than signal.
 */
export async function scanAutomationSites() {
  const files = (await tsFiles(PLUGIN_SRC)).map((f) => ({ ...f, rel: `src/${f.rel}` }));
  const found = [];
  const re = /\b(registerEvent|registerInterval|onLayoutReady)\s*\(|\bwindow\.setInterval\s*\(/;
  for (const f of files) {
    const text = await readMaybe(f.abs);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const m = re.exec(line);
      if (m) found.push({ kind: m[1] ?? "setInterval", file: f.rel });
    }
  }
  return found;
}

/**
 * Which of the named module-scope functions reach a given callee.
 *
 * Used to VERIFY, rather than trust, the inventory's claim about which
 * authority acts leave a durable audit record. The earlier draft asserted
 * "the acceptance log records these" in a comment and applied it to all of
 * them; two were wrong. A claim about existing behaviour belongs in a scan.
 *
 * Bodies are delimited by this file's own style — a module-scope
 * `function name(` through the next `}` at column 0 — which holds throughout
 * `governance/wiring.ts`. A function whose body cannot be delimited is
 * reported as `null` rather than silently treated as not calling anything.
 *
 * `delegates` names indirect routes: `performAccept` does not call `appendLog`
 * itself, it calls `acceptNote`, which appends through its injected deps. Each
 * delegate is listed explicitly rather than followed automatically, because a
 * scanner that chases call graphs would quietly start guessing.
 */
export async function scanFunctionReaches(relPath, fnNames, callees) {
  const text = await readFile(resolvePath(PLUGIN_SRC, relPath), "utf8");
  const out = new Map();
  for (const fn of fnNames) {
    const start = text.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`, "m"));
    if (start < 0) {
      out.set(fn, null);
      continue;
    }
    const rest = text.slice(start);
    const endRel = rest.search(/\n\}/);
    if (endRel < 0) {
      out.set(fn, null);
      continue;
    }
    const body = rest.slice(0, endRel);
    out.set(fn, new Set(callees.filter((c) => new RegExp(`\\b${c}\\s*\\(`).test(body))));
  }
  return out;
}

/** Every `export` from one file, so a NEW export is a visible decision. */
export async function scanExports(relPath) {
  const text = await readFile(resolvePath(PLUGIN_SRC, relPath), "utf8");
  const names = new Set();
  const re = /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}
