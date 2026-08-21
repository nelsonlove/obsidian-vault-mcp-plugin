// The declared NON-MCP SURFACE INVENTORY — Gate 0, WP0 (second half).
//
// MCP is one door onto Governor. It is not the only one, and it is not the
// important one: the accept gesture has NO MCP surface by design, so an
// inventory that stopped at the bridge would omit precisely the operations
// that create standing.
//
// Three kinds of door are declared here:
//
//   ui          an Obsidian command, a review-pane control, a settings button
//               — something a human clicks
//   automation  a timer, a vault or metadata event subscription, a
//               layout-ready hook — work that starts with no caller at all
//   internal    a Governor-to-Governor call
//
// The AUTHORITY rows are the point of the exercise. They are the only actions
// in this repository declared `governorOnly` with the `authority` change
// class, and `registry.ts` refuses at build time to bind any of them to an
// `mcp` or `external` surface. That is the static counterpart to the two
// runtime controls the pane already enforces: every capability-bearing control
// is wired with `addEventListener` rather than `.onclick =` (so the function is
// not a reachable property), and every handler calls `isRealGesture(evt)`,
// which requires a genuine `Event` with `isTrusted === true`.
//
// Two structural facts this inventory depends on are asserted by its test
// rather than assumed, because both are load-bearing and neither was checked
// by anything before:
//
//   • `src/governance/` registers ZERO Obsidian commands. Every command is
//     agent-invocable through `obsidian_run_command`'s `executeCommandById`,
//     so an accept command would be a self-approval primitive one
//     prompt-injection away.
//   • none of the ten accept-perimeter functions is exported, and the file's
//     export set is pinned. Export is what would make one reachable from a
//     plugin instance, a view instance, or any other object an agent-facing
//     path can obtain — and pinning the whole set closes the class rather than
//     the ten instances.

import type { ActionDefinition, Distribution, SurfaceKind } from "./action.js";
import { compatibilityAction } from "./compatibility.js";
import type { SurfaceBinding } from "./surface-binding.js";

// ── the accept perimeter ─────────────────────────────────────────────────────

/**
 * The module-scope functions in `governance/wiring.ts` that can change
 * authority state. Named here so the test can assert they still exist and are
 * still unexported — an inventory that describes deleted code is worse than
 * none, and an exported one is a hole.
 *
 * `wiring.ts`'s own header gives the membership test: "A capability that
 * advances a baseline, accepts a change, adopts a baseline, or flips an
 * auto-accept class is accept-equivalent: it silences the review queue."
 * Applied literally, that is every writer of `setBaseline`, `rekey` or the
 * auto-accept allowlist. There are ten.
 *
 * The first draft of this list had seven, and the three it missed are the
 * three with NO gesture anywhere:
 *
 *   maybeAutoAccept     advances a baseline for an allowlisted mechanical
 *                       class, driven by a 2.5s poll — no click, no
 *                       isRealGesture, nothing
 *   sweepAutoAccept     its driver, over the cached pending queue
 *   reconcileBaselines  re-addresses baselines whose notes moved while the
 *                       plugin was off
 *
 * Missing them is instructive rather than embarrassing: the gesture-gated
 * capabilities are easy to find because a human clicks them, and the ones that
 * run by themselves are exactly the ones an inventory built by reading the UI
 * will overlook.
 */
export const ACCEPT_PERIMETER_FUNCTIONS = [
  "performAccept",
  "performRevert",
  "performAdopt",
  "setClassEnabled",
  "performRequestChanges",
  "performWithdraw",
  "reconcile",
  "maybeAutoAccept",
  "sweepAutoAccept",
  "reconcileBaselines",
] as const;

/**
 * The exports of `governance/wiring.ts`, pinned.
 *
 * Checking that the ten perimeter functions are unexported closes those ten
 * instances. Pinning the whole export set closes the CLASS: a new export is a
 * visible decision rather than something a reviewer has to notice.
 *
 * `nudgeGovernanceQueue` is exported deliberately and does reach the
 * auto-accept chain — but only by changing WHEN the poll runs, never what it
 * may accept. Eligibility is decided inside `maybeAutoAccept` by the
 * objective-bytes, allowlist and rail checks, which no caller can influence.
 */
export const WIRING_EXPORTS = [
  "GovernanceWireDeps",
  "isGovernanceMounted",
  "nudgeGovernanceQueue",
  "wireGovernance",
  "renderGovernanceSettings",
] as const;

export interface AuthorityRow {
  /** Surface identity — where the human gesture or automation lives. */
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  /** Registered action id. */
  action: string;
  title: string;
  postcondition: string;
  /** The `governance/wiring.ts` function this surface ultimately calls. */
  implementation: (typeof ACCEPT_PERIMETER_FUNCTIONS)[number];
  paths?: string[];
  /** Change classes beyond `authority`, when the act also alters content. */
  alsoChanges?: Array<"content" | "structural">;
  /** How reachability is restricted, in one phrase. */
  reachability: string;
}

export const AUTHORITY_SURFACES: AuthorityRow[] = [
  {
    id: "governance.pane.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal",
    postcondition: "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    implementation: "performAccept",
    paths: ["path"],
    reachability: "pane detail-view and Proposed-section buttons, wired with addEventListener + isRealGesture",
  },
  {
    id: "governance.context-menu.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal from the file menu",
    postcondition: "Open a confirmation modal whose own confirm button performs the accept.",
    implementation: "performAccept",
    paths: ["path"],
    // Obsidian renders file-menu items natively and delivers no trusted Event
    // to the menu callback, so `isRealGesture` there was permanently inert and
    // was removed. The menu item can therefore only OPEN a modal; the accept
    // happens from that modal's own click, which restores both gesture layers.
    // Worst case for a forged menu trigger is that a dialog appears.
    reachability: "menu item opens a ConfirmModal only; the write happens from the modal's gesture-gated confirm",
  },
  {
    id: "governance.pane.revert",
    kind: "ui",
    action: "governance.revert",
    title: "Revert to the admitted baseline",
    postcondition: "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    implementation: "performRevert",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane detail-view button, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline",
    postcondition: "Advance every pending note's baseline to its current content in one act.",
    implementation: "performAdopt",
    reachability: "pane button, addEventListener + isRealGesture + a confirm step",
  },
  {
    id: "governance.settings.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline (settings tab)",
    postcondition: "The same mass advance, reached from the settings tab.",
    implementation: "performAdopt",
    reachability: "settings-tab button sharing the pane's wireAdoptButton, same two gesture layers",
  },
  {
    id: "governance.pane.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class",
    postcondition: "Change which mechanical change classes Governor may admit without a further gesture.",
    implementation: "setClassEnabled",
    reachability: "pane allowlist checkboxes, addEventListener + isRealGesture",
  },
  {
    id: "governance.settings.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class (settings tab)",
    postcondition: "The same policy change, reached from the settings tab.",
    implementation: "setClassEnabled",
    reachability: "settings-tab checkboxes sharing the pane's renderAllowlist",
  },
  {
    id: "governance.pane.request-changes",
    kind: "ui",
    action: "governance.request-changes",
    title: "Request changes on a proposal",
    postcondition: "Move a proposal to revising and record the human's feedback, conferring no standing.",
    implementation: "performRequestChanges",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button and modal, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.withdraw",
    kind: "ui",
    action: "governance.withdraw",
    title: "Withdraw a proposal",
    postcondition: "Remove a proposal from review without accepting it.",
    implementation: "performWithdraw",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button, addEventListener + isRealGesture",
  },
  {
    // The one baseline advance with NO click anywhere. It is gated instead on
    // a POSITIVE signal — `recentGenuineHumanInput`, derived from real
    // `beforeinput`/`paste` DOM events — which is exactly the
    // "local-human-observed" origin class: observed, not cryptographically
    // proven, and trusted within the documented same-user threat model.
    id: "governance.automation.reconcile-observed-edit",
    kind: "automation",
    action: "governance.reconcile-observed-human-edit",
    title: "Reconcile an observed human edit",
    postcondition:
      "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    implementation: "reconcile",
    paths: ["path"],
    reachability: "vault 'modify' event, debounced; gated on recentGenuineHumanInput rather than on any gesture",
  },
  {
    // No gesture anywhere. Driven by the 2.5s journal poll and by
    // `nudgeGovernanceQueue` after every journal append.
    id: "governance.automation.auto-accept-sweep",
    kind: "automation",
    action: "governance.auto-accept",
    title: "Auto-accept sweep",
    postcondition:
      "Advance the baseline of every pending note whose diff is confined to an enabled mechanical change class.",
    // `maybeAutoAccept`, not `sweepAutoAccept`: the sweep is only the driver
    // that walks the pending queue, and the act — the baseline advance and its
    // audit record — happens one level down. Attributing the row to the driver
    // made the audit claim come out wrong, which is how the distinction
    // surfaced.
    implementation: "maybeAutoAccept",
    reachability:
      "sweepAutoAccept over the cached pending queue, driven by the journal poll and the post-append nudge; safety comes from the objective-bytes comparison, the mechanical-class allowlist and the rail check inside maybeAutoAccept, NOT from a gesture",
  },
  {
    id: "governance.automation.rekey-on-rename",
    kind: "automation",
    action: "governance.rekey-baseline",
    title: "Follow a renamed note",
    postcondition: "Re-address a baseline when Governor witnesses the rename.",
    // The call is an inline closure inside the vault 'rename' handler rather
    // than a named function, so the perimeter entry it is attributed to is
    // `reconcileBaselines`, which owns the same rekey contract.
    implementation: "reconcileBaselines",
    paths: ["from", "to"],
    reachability: "vault 'rename' event; rekey carries acceptance across verbatim and never routes through setBaseline",
  },
  {
    id: "governance.automation.reconcile-baselines",
    kind: "automation",
    action: "governance.rekey-baseline",
    title: "Repair baselines orphaned while the plugin was off",
    postcondition:
      "Re-address baselines whose notes moved unwitnessed, matching on the uid inside the stored baseline content.",
    implementation: "reconcileBaselines",
    reachability: "one-shot metadataCache 'resolved' event at mount",
  },
];

interface AuthoritySpec {
  id: string;
  title: string;
  postcondition: string;
  paths: string[];
  alsoChanges?: Array<"content" | "structural">;
  /**
   * Whether this act reaches `appendLog` and therefore leaves a durable
   * operation record. VERIFIED against source by the test, not asserted here —
   * the previous draft claimed all seven were logged and two were not.
   */
  audited: boolean;
  /**
   * Targets found at runtime rather than received as arguments. `none` is only
   * correct for an act on one named note.
   */
  discovered: "none" | "bounded" | "unbounded";
}

/** One native authority action per distinct `action` id above. */
function authorityAction({
  id,
  title,
  postcondition,
  paths,
  alsoChanges = [],
  audited,
  discovered,
}: AuthoritySpec): ActionDefinition {
  return {
    id,
    version: 1,
    title,
    postcondition,
    owner: "acceptance",
    // Never public in the MCP sense — there is no client-facing door at all.
    // `private` here means "operator/human surface", not "operator pack".
    distribution: "private",
    modes: ["authority"],
    // Canonical order: content before authority.
    changeClasses: [...alsoChanges, "authority"],
    // Deliberately the weakest capture, and deliberately NOT `replayable`.
    //
    // The target contract says authority inputs are replayable — but no
    // observation substrate exists yet, so declaring `replayable` here would
    // assert a guarantee no code provides. Raised in WP2, when there is
    // something to raise it to.
    observations: { defaultCapture: "ephemeral", supportsProposal: false },
    effects: { direct: ["standing", "accepted-frontmatter", "baseline"], discovered },
    authority: { governorOnly: true, automaticAdmission: "never" },
    scope: {
      argumentKeys: paths,
      resolvesAddresses: false,
      enumeration: paths.length > 0 ? "not-applicable" : "filter-before-read",
      whenScoped: "available",
    },
    // `durable` ONLY where the act actually reaches `appendLog`. Two do not,
    // and saying otherwise would claim an audit trail that does not exist —
    // see the AUTHORITY_ACTIONS entries and the test that verifies each
    // `audited` flag against source.
    retention: { operation: audited ? "durable" : "ephemeral" },
    inputs: paths,
    // Authored against this registry rather than derived from a registration —
    // there IS no registration metadata to derive from, because the accept
    // path is deliberately a set of module-scope closures with no tool, no
    // command and no exported symbol.
    //
    // `native` means the CONTRACT was authored. It does NOT mean the action is
    // routed through the operation executor — nothing is, yet. WP1 does that.
    native: true,
  };
}

const AUTHORITY_ACTIONS: ActionDefinition[] = [
  authorityAction({
    id: "governance.accept",
    title: "Accept a proposal",
    postcondition: "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    paths: ["path"],
    audited: true, // reaches appendLog through acceptNote's injected deps
    discovered: "none",
  }),
  authorityAction({
    id: "governance.revert",
    title: "Revert to the admitted baseline",
    postcondition: "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true, // through revertNote
    discovered: "none",
  }),
  authorityAction({
    id: "governance.adopt-baseline",
    title: "Adopt current content as the baseline",
    postcondition: "Advance every governed note's baseline to its current content in one act.",
    paths: [],
    // NOT audited. `performAdopt` loops over `governedMarkdownFiles(plugin)`
    // calling `setBaseline` and never reaches `appendLog` — so the single most
    // consequential capability in the product, the one its own source calls
    // "mass-silence", leaves NO operation record. That is a real gap in the
    // predecessor, surfaced by declaring it honestly rather than smoothed over
    // by a blanket `durable`. WP8's cutover is where it gets fixed; recording
    // it now is what makes it impossible to forget.
    audited: false,
    // It receives no path and discovers its entire target set at runtime —
    // every governed markdown file in the vault. This is the same shape as
    // `obsidian_repoint_link`, the case `action.ts` cites as the reason the
    // field exists.
    discovered: "unbounded",
  }),
  authorityAction({
    id: "governance.set-auto-accept-class",
    title: "Set an auto-accept class",
    postcondition: "Change which mechanical change classes Governor may admit without a further gesture.",
    paths: [],
    // NOT audited either: `setClassEnabled` writes the allowlist through
    // `saveAllowlist` and appends nothing. Changing what may be admitted
    // without review is a policy change with no record of who changed it.
    audited: false,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.request-changes",
    title: "Request changes on a proposal",
    postcondition: "Move a proposal to revising and record the human's feedback, conferring no standing.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.withdraw",
    title: "Withdraw a proposal",
    postcondition: "Remove a proposal from review without accepting it.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.reconcile-observed-human-edit",
    title: "Reconcile an observed human edit",
    postcondition: "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    paths: ["path"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    // The eighth capability, and the one an inventory built by reading the UI
    // will miss: it advances a baseline with NO gesture anywhere, driven by a
    // 2.5s poll and by every journal append. Its safety comes from a different
    // place than the pane's — the objective-bytes comparison, the mechanical-
    // class allowlist and the rail check inside `maybeAutoAccept` — not from
    // `isRealGesture`. Declaring it as its own authority action is what lets
    // the registry fence it at all; folded into a generic automation row, it
    // was classified as an ordinary non-authority mutation.
    id: "governance.auto-accept",
    title: "Auto-accept an allowlisted mechanical change",
    postcondition:
      "Advance a note's baseline without any gesture when its diff is confined to an enabled mechanical change class.",
    paths: ["path"],
    audited: true,
    // The sweep iterates the cached pending queue rather than a named target.
    discovered: "unbounded",
  }),
  authorityAction({
    // Re-addressing, NOT acceptance: `rekey` carries content, hash, acceptedAt
    // and acceptedBy across verbatim and deliberately does not route through
    // `setBaseline`, which would stamp a fresh acceptance nobody gave. It is
    // still an authority act, because it decides which note an existing
    // acceptance now applies to.
    id: "governance.rekey-baseline",
    title: "Re-address a baseline to follow its note",
    postcondition:
      "Move an existing baseline to a renamed note's path, carrying its acceptance across without stamping a new one.",
    paths: ["from", "to"],
    audited: true,
    discovered: "unbounded",
  }),
];

// ── Obsidian commands ────────────────────────────────────────────────────────

export interface CommandRow {
  /** The command id as registered. Obsidian namespaces it as `governor:<id>`. */
  id: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  /** `governor-only` is refused by this inventory's test: a command is
   * agent-invocable through `obsidian_run_command`, so it may never bind an
   * authority action. */
  authority?: "governor-only";
  /** Writes outside the vault. Part of the same disclosure set as the bridge
   * rows — the footprint is a property of the PLUGIN, not of one row family. */
  outsideVault?: boolean;
  note?: string;
}

export const COMMAND_SURFACES: CommandRow[] = [
  {
    id: "connect-claude-code",
    title: "Connect to Claude Code",
    postcondition: "Register this vault's bridge with the local Claude Code CLI.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    note: "spawns the `claude` binary; never writes ~/.claude.json directly",
  },
  {
    id: "run-tool",
    title: "Run tool…",
    postcondition: "Invoke any captured tool through the same guarded path a Code Mode connection uses.",
    owner: "core",
    distribution: "private",
    readOnly: false,
    // Not a bypass — it dispatches through the identical guard/queue/journal
    // path — but it IS a distinct door, and one that can reach any mutating
    // tool from inside Obsidian. Gated live on `settings.devToolRunner`.
    note: "dev tool-runner, gated on settings.devToolRunner via checkCallback",
  },
  {
    id: "show-diagnostics",
    title: "Show diagnostics",
    postcondition: "Display bridge, vault and integration state in a modal.",
    owner: "core",
    distribution: "public-default",
    readOnly: true,
  },
  {
    id: "scheme-inbox-open",
    title: "Scheme: open JD inboxes",
    postcondition: "Activate the scheme inbox view.",
    owner: "scheme",
    distribution: "public-optional",
    readOnly: true,
  },
  {
    id: "scheme-drift-open",
    title: "Scheme: open JD drift",
    postcondition: "Activate the scheme drift view.",
    owner: "scheme",
    distribution: "public-optional",
    readOnly: true,
  },
  {
    id: "skills-export",
    title: "Skills: export skills & agents to Claude Code",
    postcondition: "Write the compiled skills and agents to the configured output directory, outside the vault.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "skills-validate",
    title: "Skills: validate tree",
    postcondition: "Report compile errors, warnings and preload counts without writing.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
  {
    id: "skills-tree",
    title: "Skills: show tree",
    postcondition: "Display the agent and skill hierarchy.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
  {
    id: "skills-mark",
    title: "Skills: mark note as skill / agent / policy / command",
    postcondition: "Set the active note's skills frontmatter, through the accept-forbidden guard.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
  },
  {
    id: "skills-release",
    title: "Skills: export release to repo",
    postcondition: "Export the compiled corpus into a repository checkout and stamp a version.",
    owner: "skills",
    distribution: "private",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "skills-preview",
    title: "Skills: preview compiled output",
    postcondition: "Activate the skills preview view.",
    owner: "skills",
    distribution: "private",
    readOnly: true,
  },
];

// ── automation ───────────────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  /** Repo-relative file, checked against the scan. */
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  /** True when this automation can change authority state with no gesture. */
  touchesAuthority: boolean;
  /** Writes outside the vault. */
  outsideVault?: boolean;
}

export const AUTOMATION_SURFACES: AutomationRow[] = [
  {
    id: "automation.governance.events",
    file: "src/governance/wiring.ts",
    title: "Governance event subscriptions and journal poll",
    postcondition:
      "Keep the review queue current from vault modify/rename/delete events, a 2.5s journal poll and a layout-ready paint.",
    owner: "acceptance",
    // The poll drives sweepAutoAccept -> maybeAutoAccept, which CAN advance a
    // baseline for an allowlisted mechanical class; the modify handler drives
    // reconcile, which can advance one silently. Both are authority-bearing.
    touchesAuthority: true,
  },
  {
    id: "automation.core.uid-index",
    file: "src/main.ts",
    title: "Stable identity index maintenance",
    postcondition: "Keep the uid index fresh from metadata-cache and vault events; gated on the socket being enabled.",
    owner: "core",
    touchesAuthority: false,
  },
  {
    id: "automation.scheme.inbox-refresh",
    file: "src/scheme/inbox-pane.ts",
    title: "Scheme inbox refresh",
    postcondition: "Rescan the inbox view when notes are created, deleted or renamed.",
    owner: "scheme",
    touchesAuthority: false,
  },
  {
    id: "automation.skills.preview-refresh",
    file: "src/skills/pane.ts",
    title: "Skills preview refresh",
    postcondition: "Recompile the preview when its sources change.",
    owner: "skills",
    touchesAuthority: false,
  },
  {
    id: "automation.skills.export-on-save",
    file: "src/skills/wiring.ts",
    title: "Skills export on save",
    postcondition: "Re-export the compiled corpus after a debounce when the opt-in setting is on.",
    owner: "skills",
    touchesAuthority: false,
    outsideVault: true,
  },
];

// ── projections ──────────────────────────────────────────────────────────────

const COMMAND_ACTION_PREFIX = "compat.command.";
const AUTOMATION_ACTION_PREFIX = "compat.automation.";

export function commandActionId(id: string): string {
  return `${COMMAND_ACTION_PREFIX}${id}`;
}

/** Every non-MCP action: derived ones for commands and automation, authored
 * ones for the authority perimeter. */
export function nonMcpActions(): ActionDefinition[] {
  const commands = COMMAND_SURFACES.map((row) =>
    compatibilityAction({
      surface: `command.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry Obsidian command; reachable from the palette and from obsidian_run_command${row.note ? ` (${row.note})` : ""}`,
    })
  );
  const automation = AUTOMATION_SURFACES.map((row) =>
    compatibilityAction({
      surface: `automation.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      // Automation has no caller, so nothing about it is read-only in the
      // sense the guard means; it is declared mutating so it can never be
      // mistaken for a free operation.
      readOnly: false,
      distribution: "private",
      reason: "pre-registry automation entry point; runs with no caller",
    })
  );
  return [...commands, ...automation, ...AUTHORITY_ACTIONS];
}

export function nonMcpBindings(): SurfaceBinding[] {
  const commands: SurfaceBinding[] = COMMAND_SURFACES.map((row) => ({
    kind: "ui",
    id: `command:${row.id}`,
    action: `compat.command.${row.id}`,
    actionVersion: 1,
    ...(row.note ? { note: row.note } : {}),
  }));
  const automation: SurfaceBinding[] = AUTOMATION_SURFACES.map((row) => ({
    kind: "automation",
    id: row.id,
    action: `compat.automation.${row.id}`,
    actionVersion: 1,
    source: row.file,
  }));
  const authority: SurfaceBinding[] = AUTHORITY_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: row.action,
    actionVersion: 1,
    source: "src/governance/wiring.ts",
    note: row.reachability,
  }));
  return [...commands, ...automation, ...authority];
}

// ── bridge, settings, and internal surfaces ──────────────────────────────────
//
// The last of WP0's inverse inventory. What counts as a SURFACE here, and what
// does not, matters — an inventory padded with every internal helper is as
// useless as one that omits a door.
//
// A surface is something a caller can invoke, something that runs by itself, or
// something that writes outside the vault. A function invoked only as the
// implementation of an already-declared action is NOT a surface; it is that
// action's body. `stampAcceptedFrontmatter`, `buildAcceptDeps`, `appendLog`,
// `saveAllowlist` and the baseline-store writers are all in that category —
// they are how `governance.accept` and its siblings do their work, and
// declaring them again would double-count one door.
//
// Two things in this section are easy to miss and worth stating plainly:
//
//   • `writeBridge()` and `autoRegister()` run on EVERY plugin load,
//     unconditionally — not gated on `settings.enabled`. Both write outside the
//     vault (`~/.claude/governor/`), and `autoRegister` spawns the `claude`
//     binary. A user who disables the socket still gets both.
//   • enabling the `acceptance` module from the settings tab mounts governance,
//     and mounting arms a one-shot `metadataCache "resolved"` handler that runs
//     `reconcileBaselines` — a declared authority action. A settings toggle is
//     therefore an authority-adjacent control, which is not obvious from
//     looking at the toggle.

export interface PlainSurfaceRow {
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  /** Writes outside the vault, which is a privacy and disclosure fact. */
  outsideVault?: boolean;
  /** Reaches the network. Distribution review asks for this explicitly. */
  network?: boolean;
  /** Runs on every plugin load regardless of settings. */
  unconditional?: boolean;
  /** Reaches a declared authority action, however indirectly. */
  reachesAuthority?: string;
  note?: string;
}

export const BRIDGE_SURFACES: PlainSurfaceRow[] = [
  {
    id: "bridge.write-bridge",
    kind: "automation",
    file: "src/main.ts",
    title: "Write the bundled bridge",
    postcondition: "Write bridge.mjs to ~/.claude/governor/ and the legacy directory on every plugin load.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    note: "runs even when the socket is disabled",
  },
  {
    id: "bridge.write-discovery",
    kind: "automation",
    file: "src/main.ts",
    title: "Publish connection discovery",
    postcondition: "Write this vault's discovery JSON so a client can find its socket.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    note: "gated on settings.enabled",
  },
  {
    id: "bridge.remove-discovery",
    kind: "automation",
    file: "src/main.ts",
    title: "Remove connection discovery",
    postcondition: "Delete this vault's discovery JSON at unload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "bridge.claude-register",
    kind: "internal",
    file: "src/main.ts",
    title: "Register with the Claude Code CLI",
    postcondition: "Spawn the `claude` binary to add or remove this vault's MCP server registration.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    note: "autoRegister() runs on every load, outside the settings.enabled gate; never writes ~/.claude.json directly",
  },
  {
    // Found by review, and the most consequential omission in the first draft.
    //
    // `autoRegister()` does not stop at registering this vault's MCP server.
    // On success — and on "already registered" — it calls
    // `claudeEnsureConnectPlugin`, which runs
    //
    //     claude plugin marketplace add nelsonlove/claude-code-plugins
    //     claude plugin install vault-mcp-connect@... --scope user
    //
    // That adds a third-party MARKETPLACE SOURCE to the user's Claude Code
    // configuration and installs a SECOND PLUGIN at user scope — persisted
    // outside the vault, affecting every Claude Code session on the machine
    // rather than this vault, and reaching the network to do it. It runs on
    // every plugin load, unconditionally.
    //
    // It is check-first and idempotent, so in steady state it is two `list`
    // calls and no change. That makes it cheap; it does not make it invisible,
    // and a capability that provisions software at user scope is exactly what
    // a distribution review has to be told about. Declared here with its real
    // postcondition rather than folded into "registers this vault".
    id: "bridge.ensure-connect-plugin",
    kind: "internal",
    file: "src/claude-cli.ts",
    title: "Provision the companion Claude Code plugin",
    postcondition:
      "Add the companion marketplace source to the user's Claude Code configuration and install the vault-mcp-connect plugin at user scope, if either is absent.",
    owner: "core",
    distribution: "private",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    network: true,
    note: "check-first and idempotent; reached from autoRegister(), which runs on every load outside the settings.enabled gate",
  },
];

export const SETTINGS_SURFACES: PlainSurfaceRow[] = [
  {
    id: "settings.connect-claude-code",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Connect to Claude Code",
    postcondition: "Force a CLI registration for this vault.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "settings.disconnect",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Disconnect",
    postcondition: "Remove this vault's CLI registration.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "settings.toggle-socket",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Enable or disable the socket",
    postcondition: "Flip settings.enabled; takes effect on reload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "settings.module-enabled",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Enable or disable a module",
    postcondition: "Mount or unmount a module's panes live, without a plugin reload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    // Enabling `acceptance` mounts governance, and mounting arms the one-shot
    // metadataCache "resolved" handler that runs reconcileBaselines. A toggle
    // that looks like a preference can therefore start an authority act.
    reachesAuthority: "governance.rekey-baseline",
    note: "acceptance -> setGovernanceMounted -> wireGovernance -> arms reconcileBaselines",
  },
  {
    id: "settings.copy-command",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Copy the setup command",
    postcondition: "Copy the registration command to the clipboard.",
    owner: "core",
    distribution: "public-default",
    readOnly: true,
  },
  {
    id: "settings.vocab-add-instance",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Add a vocabulary instance",
    postcondition: "Append a vocabulary source to settings and repaint.",
    owner: "vocab",
    distribution: "public-optional",
    readOnly: false,
  },
  {
    id: "settings.vocab-remove-instance",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Remove a vocabulary instance",
    postcondition: "Remove a vocabulary source from settings and repaint.",
    owner: "vocab",
    distribution: "public-optional",
    readOnly: false,
  },
];

export const INTERNAL_SURFACES: PlainSurfaceRow[] = [
  {
    id: "internal.governance.publish-pending-index",
    kind: "internal",
    file: "src/governance/wiring.ts",
    title: "Publish the pending-review index",
    postcondition:
      "Write the review queue to pending-index.json so obsidian_pending_review can report it — or report it unavailable.",
    owner: "acceptance",
    distribution: "public-default",
    readOnly: false,
    note: "the producer behind the agent-visible read surface; absence must read as unavailable, never as an empty queue",
  },
  {
    id: "internal.core.save-settings",
    kind: "internal",
    file: "src/main.ts",
    title: "Persist settings",
    postcondition: "Write the plugin's settings to data.json.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "internal.core.install-id",
    kind: "internal",
    file: "src/main.ts",
    title: "Load or mint the install id",
    postcondition:
      "Read the persistent install id beside the journal, minting one if absent and degrading to an ephemeral id if the directory is unwritable.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "internal.core.folder-migration",
    kind: "internal",
    file: "src/main.ts",
    title: "Migrate the plugin folder id",
    postcondition: "Reconcile a plugin directory still named for the pre-0.12.0 id with the current manifest id.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
];

/** Every plain (non-authority, non-command, non-automation-family) surface. */
export const PLAIN_SURFACES: PlainSurfaceRow[] = [...BRIDGE_SURFACES, ...SETTINGS_SURFACES, ...INTERNAL_SURFACES];

/**
 * Every surface that writes outside the vault, ACROSS ALL FAMILIES.
 *
 * The first draft computed this over `PLAIN_SURFACES` alone while claiming it
 * was "the plugin's whole footprint outside the vault." It was not: the skills
 * export and release commands write to a directory outside the vault, and
 * their export-on-save automation re-triggers the same write on a timer. A
 * disclosure scoped to one row family is not a disclosure of the plugin.
 *
 * The footprint is a property of the PLUGIN, so it is computed over every
 * family and pinned by one test.
 */
export function outsideVaultSurfaces(): Array<{ id: string; network: boolean }> {
  return [
    ...PLAIN_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: r.id, network: r.network === true })),
    ...COMMAND_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: `command:${r.id}`, network: false })),
    ...AUTOMATION_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: r.id, network: false })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Functions that are the BODY of an already-declared action rather than doors
 * of their own. Listed so "why isn't this in the inventory?" has an answer that
 * is written down instead of remembered.
 */
export const NOT_SURFACES = [
  { name: "stampAcceptedFrontmatter", partOf: "governance.accept" },
  { name: "buildAcceptDeps", partOf: "governance.accept" },
  { name: "appendLog", partOf: "every audited authority action" },
  { name: "saveAllowlist", partOf: "governance.set-auto-accept-class" },
  // Shared infrastructure, not one action's helper: `performAdopt` uses it,
  // and so do `refresh()` and `listRevising()`.
  { name: "governedMarkdownFiles", partOf: "shared queue and listing infrastructure" },
  { name: "scheduleReconcile", partOf: "governance.reconcile-observed-human-edit" },
  { name: "quarantineWrite", partOf: "governance.accept" },
  { name: "persistRenameRecords", partOf: "governance.rekey-baseline" },
] as const;

export function plainActions(): ActionDefinition[] {
  return PLAIN_SURFACES.map((row) =>
    compatibilityAction({
      surface: row.id,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry ${row.kind} surface${row.outsideVault ? "; writes outside the vault" : ""}${row.unconditional ? "; runs on every plugin load regardless of settings" : ""}`,
    })
  );
}

export function plainBindings(): SurfaceBinding[] {
  return PLAIN_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: `compat.${row.id}`,
    actionVersion: 1,
    source: row.file,
    ...(row.note ? { note: row.note } : {}),
  }));
}
