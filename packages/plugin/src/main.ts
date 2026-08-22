import { Plugin, FileSystemAdapter, Modal, Notice, TFile, type Component } from "obsidian";
import * as fs from "node:fs";
import { UnixSocketListener } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import type { CapturedRegistry } from "./mcp/tools-code-mode.js";
import { openToolRunner } from "./tool-runner.js";
import { vaultSlug, socketPath, stateDir, bridgeDestPath } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { ConnectionSetupModal, VaultMcpSettingTab } from "./connection-ui.js";
import { findClaudeBinary, claudeIsRegistered, claudeRegister, claudeRemove, claudeEnsureConnectPlugin } from "./claude-cli.js";
import { ExternalToolRegistry, type VaultMcpApi } from "./mcp/external-tools.js";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore, UidIndex, loadInstallId, migrateLegacyModuleIds, DEFAULT_VOCABULARIES, type VocabInstanceSettings, type ModuleSettings } from "./kernel/index.js";
import { createSessionStore } from "./kernel/governance/sessions/session-store.js";
import { createProposalStore } from "./kernel/governance/proposals/proposal-store.js";
import { buildAdmission, type AdmissionUiDeps } from "./governance/admission-wiring.js";
import { openGitRepository } from "./governance/history-store/git-repository.js";
import { historyDir } from "./governance/history-store/local-data-root.js";
import { effectiveScope, isTracked } from "./kernel/governance/history-store/history-scope.js";
import { proposalRef } from "./kernel/governance/history-store/refs.js";
import { EXCLUDED_PREFIXES } from "./governance/territories.js";
import type { HistoryRepository } from "./kernel/governance/history-store/repository.js";
import { obsidianProbe, obsidianServerIdentity, obsidianUidSource } from "./kernel/obsidian-probe.js";
import { DEFAULT_SCHEMES, type SchemeInstanceConfig } from "./kernel/scheme/registry.js";
import { DEFAULT_PROTECTED_PROPERTIES, setDeclaredProtectedProperties } from "@vault-mcp/core";
import { wireGovernance, nudgeGovernanceQueue, setLegacyWriteGuard, baselinesOf } from "./governance/wiring.js";
import { buildMigration, type Migration } from "./governance/migration-wiring.js";
import { mountAction } from "./governance/mount-state.js";
import { wireSkills } from "./skills/wiring.js";
import { wireSchemePanes, registerSchemeCommands } from "./scheme/wiring.js";
import { runFolderMigration, LEGACY_PLUGIN_ID } from "./id-migration.js";

interface VaultMcpSettings {
  setupAcknowledged: boolean;
  readOnly: boolean;
  allowlist: string[];
  enabled: boolean;
  allowDangerousCli: boolean;
  /**
   * Register the raw `obsidian_cli` proxy. DEFAULT OFF: the dedicated
   * pinned-subcommand tools (obsidian_note_history/diff, obsidian_base_create,
   * the snippet tools, obsidian_plugin_install/uninstall) cover the observed
   * real usage with typed args and path scoping, and the proxy's free-text
   * command string is the root of a whole guard-complexity family
   * (#76/#79/#107/#110/#137/#153). When ON, the proxy behaves exactly as
   * before — command policy, danger gate, accept guard, deny sets all intact.
   * Takes effect on the next session connect.
   */
  rawCliProxy: boolean;
  /**
   * Plugin ids whose tools may declare themselves read-only and be believed.
   * Empty by default: an external tool's `readOnlyHint: true` is otherwise
   * treated as mutating (queued, journaled, allowlist-scoped, blocked in
   * read-only mode) — see mcp/external-tools.ts.
   */
  trustedReadOnlyPlugins: string[];
  /**
   * Declared protected frontmatter properties (#224): `{key, grade}` rows the
   * accept guard enforces on EVERY guarded transport (grade `agent-forbidden`
   * — introduce/change/remove refused, byte-identical carry-forward allowed —
   * or `authority-conferring`, which additionally honors the value only once
   * blessed). Human-only-mutable by construction (settings tab; no MCP path
   * writes plugin config). The accepted family + acceptance-status are a
   * HARDCODED floor underneath — entries naming them are ignored loudly
   * (@vault-mcp/core normalizeProtectedProperties); this list can only EXTEND
   * the perimeter. Synced into the core guard registry on load and save.
   */
  protectedProperties: Array<{ key: string; grade: string }>;
  /**
   * Controlled-vocabulary sources for the vocab tools (mcp/tools-vocab.ts):
   * `{ id, provider, root, config }` rows, mirroring the scheme settings
   * shape. Defaults to one registry-blueprint instance over the vault's
   * registries slot plus one glossary instance. Edited in the settings tab via
   * the vocab module's bespoke per-instance form (connection-ui.ts
   * `renderVocabInstances`) — add / remove instances and edit id / provider /
   * root / config there; edits land per-connection through the vocab tool
   * layer's `getVocabularies` thunk.
   */
  vocabularies: VocabInstanceSettings[];
  /**
   * Scope-provider instances (scheme id + provider name + per-provider
   * config). Defaults to DEFAULT_SCHEMES — the single "jd" instance backed by
   * the Johnny Decimal provider with its own default config. Scheme semantics
   * are configuration, not hardwired (Nelson's ruling): only the default
   * instance's JD config gets a settings-tab UI (comma-separated expanded
   * areas/categories + content-decimal floor); additional instances or
   * exotic overrides stay data.json-editable, no UI (YAGNI) — see
   * kernel/scheme/registry.ts for the deep-merge-over-defaults and
   * skip-and-report-on-invalid-config behavior this list feeds.
   */
  schemes: SchemeInstanceConfig[];
  /**
   * The module host's per-module rows (`{ enabled?, config? }` keyed by
   * module id — "scheme", "vocab"). An absent row means the module's default
   * (both built-ins default enabled); `enabled: false` unmounts that module's
   * whole tool surface on the next connection. See kernel/modules/ and
   * mcp/modules-mount.ts.
   */
  modules: ModuleSettings;
  /**
   * Command policy for the arbitrary-execution surfaces (obsidian_cli +
   * obsidian_run_command): a deny list (always wins) and the per-command
   * re-enable list for the deny-by-default opaque-accept set (quickadd/eval/
   * command; quickadd:* and js-engine:* run_command ids). Human-only by construction — no MCP
   * surface writes plugin settings, and the surfaces that could reach one
   * indirectly are what this policy denies. See mcp/cli-policy.ts.
   */
  cliPolicy: { deny: string[]; allowOpaque: string[] };
  /**
   * Enforce record immutability (#264): refuse non-append mutation of a note
   * whose frontmatter carries `record: true`. Default ON — the guard exists
   * because a mis-quoted write destroyed a byte-verified record archive. The
   * off switch is here because the check is deliberately over-inclusive (it
   * refuses on ANY named path, including one an operation only reads), so a
   * legitimate workflow it blocks needs a way through that isn't hand-editing
   * frontmatter. Read live per call — no reconnect needed.
   */
  enforceRecordImmutability: boolean;
  /**
   * Capture the exact bytes Governor returns from a native read, so a reviewer can replay what an agent was actually shown.
   *
   * DEFAULT OFF, and it stays off until a human turns it on. Capturing note bodies writes vault content to `~/.claude/governor/observations/<vault>/` — outside the vault, outside Sync — and that is a privacy decision a plugin must not make on somebody's behalf by shipping it enabled.
   *
   * Only NATIVE actions are captured. The 123 derived contracts claim nothing about their observations, so turning this on does not suddenly start recording every tool in the product; today it means `obsidian_read_note` alone.
   */
  captureObservations: boolean;
  /**
   * Ceiling on total captured bytes, per vault. A stopgap, and named as one: real retention does not exist yet, so without a cap the store grows forever. Capture stops and says why rather than filling the disk.
   */
  captureMaxBytes: number;
  /**
   * Local history recording (WP4, D10). DEFAULT OFF: Git retains historical bytes, and D10 makes turning that on a disclosed human choice, never a shipped default. Nothing consumes the repository until proposals (WP6) — the setting exists now so the scope is chosen before the first byte is recorded, not after.
   */
  historyEnabled: boolean;
  /**
   * The human-chosen history scope (D10) — SEPARATE from any connection allowlist, which can never widen or narrow it. whole-vault records everything minus exclusions; explicit records only the included roots. Exclusions always win, and the guarded territories are always appended at runtime regardless of what this stores.
   */
  historyScope: { mode: "whole-vault" | "explicit"; include: string[]; exclude: string[] };
  /**
   * The in-Obsidian dev tool-runner ("Vault MCP: Run tool…" — src/tool-runner.ts).
   * Default ON: it grants nothing the MCP surface doesn't already grant — it
   * invokes the same guarded captured tools a code-mode connection gets, so
   * every rail (read-only mode, allowlist, queue, journal, accept-forbidden)
   * binds identically. The toggle exists so a locked-down vault can remove the
   * in-app surface anyway; it is read live by the command's checkCallback, so
   * flipping it needs no reload.
   */
  devToolRunner: boolean;
}
// WP6b-2: the admission UI-deps factory, keyed off the plugin instance in a
// module-local WeakMap (the wiring.ts pattern) — NOT a plugin property, so
// renderer JS walking `app.plugins` finds no admit-capable function (§9).
const admissionFactories = new WeakMap<Plugin, () => AdmissionUiDeps>();
// WP8: per-plugin migration surface (import / cutover / rollback), built in onload.
const migrations = new WeakMap<Plugin, Migration>();

const DEFAULT_SETTINGS: VaultMcpSettings = {
  setupAcknowledged: false,
  readOnly: false,
  allowlist: [],
  enabled: true,
  allowDangerousCli: false,
  rawCliProxy: false,
  trustedReadOnlyPlugins: [],
  protectedProperties: DEFAULT_PROTECTED_PROPERTIES.map((p) => ({ ...p })),
  // Cloned so settings edits can never mutate the module-level default rows
  // (item 6: schemes now clones symmetrically with vocabularies — a shallow
  // `.map((s) => ({...s}))` would miss a nested `config` object were one ever
  // added to DEFAULT_SCHEMES's entries, so this uses structuredClone for a
  // real deep copy rather than assuming the shape stays flat).
  vocabularies: DEFAULT_VOCABULARIES.map((v) => ({ ...v })),
  schemes: structuredClone(DEFAULT_SCHEMES),
  modules: {},
  cliPolicy: { deny: [], allowOpaque: [] },
  enforceRecordImmutability: true,
  devToolRunner: true,
  captureObservations: false,
  captureMaxBytes: 50 * 1024 * 1024,
  historyEnabled: false,
  historyScope: { mode: "whole-vault", include: [], exclude: [] },
};

class DiagnosticsModal extends Modal {
  constructor(app: any, private readonly lines: string[]) { super(app); }
  onOpen() {
    this.titleEl.setText("governor diagnostics");
    for (const l of this.lines) this.contentEl.createEl("p", { text: l });
  }
  onClose() { this.contentEl.empty(); }
}

export default class VaultMcpPlugin extends Plugin {
  private listener: UnixSocketListener | null = null;
  private slug = "";
  declare settings: VaultMcpSettings;
  private externalRegistry = new ExternalToolRegistry();
  // The governance review pane's live-mount handle: the child Component wireGovernance registers
  // its view/ribbon/events/interval on, or null when the pane is unmounted. Non-null ⇔ mounted, so
  // it doubles as the idempotency state. `governanceReconcile` serializes mount/unmount so a rapid
  // enable→disable can't interleave a half-finished mount with a teardown.
  private governanceComponent: Component | null = null;
  private governanceReconcile: Promise<void> = Promise.resolve();
  // Same live-mount handle/serialization pattern as governance's, for the scheme Inbox + Drift
  // panes (jd-dashboard fold Stages B/C, governor#286): one shared Component for both panes,
  // since they're gated by the same "scheme" module toggle and always mount/unmount together.
  private schemePanesComponent: Component | null = null;
  private schemePanesReconcile: Promise<void> = Promise.resolve();
  // Public plugin-to-plugin API: app.plugins.plugins['governor'].api (the
  // property rides the plugin instance, so it moved with the 0.12.0 id
  // migration automatically; the old 'vault-mcp' lookup finds nothing once
  // the old plugin entry is removed — SDK consumers need a dual-id read).
  api: VaultMcpApi = {
    apiVersion: 1,
    registerTools: (owner, tools) => this.externalRegistry.registerTools(owner, tools),
    unregisterTools: (owner) => this.externalRegistry.unregisterTools(owner),
  };

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // A hand-edited/corrupt data.json must not silently DISABLE a guard: any
    // value that isn't an explicit `false` reads as enforced (same
    // fail-toward-the-safe-default discipline as the cliPolicy/protected-
    // property normalization below, where a dropped malformed entry can only
    // mean more denied, never less).
    this.settings.enforceRecordImmutability = this.settings.enforceRecordImmutability !== false;
    // Explicit opt-in: anything other than a literal `true` reads as off, so a corrupt or partial settings file can never turn capture on by accident.
    this.settings.captureObservations = this.settings.captureObservations === true;
    if (typeof this.settings.captureMaxBytes !== "number" || this.settings.captureMaxBytes <= 0) {
      this.settings.captureMaxBytes = DEFAULT_SETTINGS.captureMaxBytes;
    }
    // History fails toward NOT recording: only an explicit true enables, and a
    // corrupt scope disables recording AND resets to explicit-with-nothing —
    // the shape that records zero paths. The first draft reset to the
    // whole-vault DEFAULT, which is the MOST-recording shape: a user whose
    // explicit include list survived a corrupted mode field would silently
    // have gone from "record Notes/" to "record everything".
    this.settings.historyEnabled = this.settings.historyEnabled === true;
    const hs = this.settings.historyScope;
    if (
      !hs ||
      (hs.mode !== "whole-vault" && hs.mode !== "explicit") ||
      !Array.isArray(hs.include) ||
      !Array.isArray(hs.exclude) ||
      ![...hs.include, ...hs.exclude].every((x) => typeof x === "string")
    ) {
      this.settings.historyScope = { mode: "explicit", include: [], exclude: [] };
      this.settings.historyEnabled = false;
    }
    // 0.12.0 module-id rename (`governance` → `acceptance`): adopt a legacy
    // `modules.governance` row under the new id when no `modules.acceptance`
    // row exists yet, dropping the old key so the next save persists the new
    // shape (one-time migrate-on-save; the row's live config rides across
    // verbatim). Pinned by tests/settings-migration.test.mjs.
    this.settings.modules = migrateLegacyModuleIds(this.settings.modules);
    // Object.assign is shallow: a hand-edited data.json carrying a PARTIAL
    // cliPolicy (one list, not both) would leave the other undefined and
    // crash the settings tab; a WRONG-TYPED one (a string where a list
    // belongs) would crash the policy matcher mid-call. Normalize to fresh
    // arrays of strings — dropping malformed values, never throwing — and
    // never alias DEFAULT_SETTINGS' own arrays (the schemes structuredClone
    // discipline). Policy semantics are unaffected: a dropped malformed
    // entry can only mean MORE denied, never less.
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    this.settings.cliPolicy = {
      deny: list(this.settings.cliPolicy?.deny),
      allowOpaque: list(this.settings.cliPolicy?.allowOpaque),
    };
    // #224: coerce the declared protected-property rows to the storable shape
    // first (a hand-edited data.json carrying a non-array or junk rows must not
    // crash the settings-tab render — the cliPolicy discipline above). Raw
    // grade STRINGS are preserved as typed so the textarea round-trips; full
    // validation stays in the registry setter.
    this.settings.protectedProperties = Array.isArray(this.settings.protectedProperties)
      ? this.settings.protectedProperties
          .filter((r): r is { key: string; grade: string } => !!r && typeof (r as { key?: unknown }).key === "string")
          .map((r) => ({ key: r.key, grade: typeof r.grade === "string" ? r.grade : "agent-forbidden" }))
      : DEFAULT_PROTECTED_PROPERTIES.map((p) => ({ ...p }));
    // Sync the list into the core guard registry (the setter normalizes —
    // floor keys and unknown grades are dropped loudly, so a tampered
    // data.json can extend the perimeter but never shrink or restate the
    // hardcoded accepted-family floor).
    setDeclaredProtectedProperties(this.settings.protectedProperties);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    // Keep the core guard registry live with settings-tab edits (#224).
    setDeclaredProtectedProperties(this.settings.protectedProperties);
  }

  private discoveryCount(): number {
    try { return fs.readdirSync(stateDir()).filter((f) => f.endsWith(".json")).length; }
    catch { return 0; }
  }

  async autoRegister(force = false): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) {
      if (force) new Notice("governor: `claude` CLI not found. Use the manual command in settings.");
      else this.showFallbackOnce();
      return;
    }
    if (!force && this.discoveryCount() > 1) { this.showFallbackOnce(); return; } // ambiguous: multiple vaults
    try {
      if (await claudeIsRegistered(bin)) {
        // `claude mcp add` errors on a duplicate name, so never re-add.
        if (force) new Notice("governor: already connected to Claude Code.");
        this.ensureConnectPlugin(bin, force);
        return;
      }
      await claudeRegister(bin, bridgeDestPath(), this.app.vault.getName());
      new Notice(
        "governor: connected to Claude Code (server name 'governor'). Restart any open Claude Code session to use it. " +
          "If this vault was registered under the old 'vault-mcp' name, remove that entry: claude mcp remove vault-mcp.",
      );
      this.ensureConnectPlugin(bin, force);
    } catch (e) {
      new Notice(`governor: auto-register failed — ${(e as Error).message}. Use the manual command in settings.`);
      this.showFallbackOnce();
    }
  }

  // #38: fire-and-forget provisioning of the vault-mcp-connect Claude Code
  // plugin (SessionStart health hook + /vault-mcp-status) alongside the MCP
  // registration. Idempotent + quiet: a Notice only on a forced run or when
  // something was actually installed; failures log once, never nag.
  private ensureConnectPlugin(bin: string, force: boolean): void {
    void claudeEnsureConnectPlugin(bin)
      .then((r) => {
        if (r === "installed") new Notice("governor: installed the vault-mcp-connect Claude Code plugin.");
        else if (force) new Notice("governor: vault-mcp-connect plugin already installed.");
      })
      .catch((e: unknown) => {
        console.error("governor: connect-plugin provisioning skipped —", e instanceof Error ? e.message : e);
      });
  }

  async claudeRemoveRegistration(): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) { new Notice("governor: `claude` CLI not found."); return; }
    await claudeRemove(bin);
    new Notice("governor: removed Claude Code registration.");
  }

  private showFallbackOnce(): void {
    if (this.settings.setupAcknowledged) return;
    new ConnectionSetupModal(this.app, async () => { this.settings.setupAcknowledged = true; await this.saveSettings(); }).open();
  }

  /**
   * Keep the uid index fresh off Obsidian's own events — no polling, no timers,
   * no filesystem reads.
   *
   *   • build once when the layout is ready, because before that the metadata
   *     cache is still warming and a build would index a fraction of the vault;
   *   • `metadataCache.changed` covers every uid EDIT — added, changed, removed
   *     — and every newly created note, since the cache parses it on arrival;
   *   • `vault.rename` is the one that matters most: it is precisely the event
   *     a path-keyed store loses to, and the whole reason the index exists;
   *   • `vault.delete` drops the mapping.
   *
   * registerEvent so every handler is detached when the plugin unloads.
   *
   * `onLayoutReady` is the exception: it takes a plain callback and returns no
   * EventRef, so there is nothing for registerEvent to detach. A plugin unloaded
   * before the layout settles would otherwise still run its rebuild — indexing a
   * vault on behalf of an instance that no longer exists — so the callback is
   * gated on a disposed flag that `register` flips at unload. Wired only when
   * something can READ it — a live socket (`settings.enabled`) or the dev
   * tool-runner (whose captured tools resolve `uid:` addressing and report uid
   * coverage over this same index; an unwired index would make those answers
   * silently empty, precisely in the socket-off mode the runner supports) —
   * via `ensureUidIndexWired`, so an instance serving neither does no upkeep.
   */
  private uidIndexWired = false;
  private ensureUidIndexWired(index: UidIndex): void {
    if (this.uidIndexWired) return;
    this.uidIndexWired = true;
    this.wireUidIndex(index);
  }

  private wireUidIndex(index: UidIndex): void {
    let disposed = false;
    this.register(() => { disposed = true; });
    this.app.workspace.onLayoutReady(() => { if (!disposed) index.rebuild(); });
    this.registerEvent(this.app.metadataCache.on("changed", (file) => index.onChanged(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => index.onRenamed(oldPath, file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => index.onDeleted(file.path)));
  }

  async onload() {
    // 0.12.0 plugin-id migration (vault-mcp → governor, #266): adopt the OLD
    // plugin folder's data (settings, journal, install-id, baselines,
    // acceptance log, receipts) into this plugin's own dir BEFORE settings
    // load and before the kernel opens the journal. Idempotent (marker /
    // no-data.json / already-provisioned ⇒ skip), abort-don't-overwrite, and
    // never fatal to the load — see src/id-migration.ts. The old folder is
    // left in place (with a MIGRATED.md marker) for the human to remove after
    // live verification.
    //
    // EVERY non-success outcome raises a STICKY Notice (`new Notice(msg, 0)`),
    // not just a console line. The reason is specific: when adoption does not
    // happen, `loadSettings()` below falls back to DEFAULT_SETTINGS — socket
    // enabled, read-only OFF, allowlist EMPTY, acceptance module off — i.e.
    // the guard config silently resets to OPEN, and the first `saveSettings()`
    // writes a fresh data.json into the new dir, which permanently closes the
    // one-shot adoption window (every later load then hits the "already has
    // its own data.json" skip). A console.error nobody opens is not a signal
    // for that.
    const migrationPluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const migrationNotice = (msg: string) => {
      console.error(`[governor] ${msg}`);
      try { new Notice(`governor: ${msg}`, 0); } catch { /* pre-layout; the console line stands */ }
    };
    try {
      const legacyDir = `${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`;
      // Obsidian runs the old id and the new id as two DIFFERENT plugins, so
      // both are live while community-plugins.json lists both. `enabledPlugins`
      // is the right probe here (not the loaded-instance rule): it is populated
      // at startup regardless of which of the two loaded first.
      const legacyPluginEnabled =
        ((this.app as any).plugins?.enabledPlugins as Set<string> | undefined)?.has(LEGACY_PLUGIN_ID) === true;
      const result = await runFolderMigration(this.app.vault.adapter, legacyDir, migrationPluginDir, {
        legacyPluginEnabled,
      });
      if (result.plan.action === "migrate") {
        if (result.failedEntry) {
          migrationNotice(
            `data-folder migration INCOMPLETE — '${result.failedEntry}' failed to move; ` +
              `moved so far: ${result.moved.join(", ") || "(none)"}. No marker written; ` +
              `old folder left at ${legacyDir} — reconcile by hand before re-enabling. ` +
              `Settings are running at DEFAULTS until this is resolved.`,
          );
        } else {
          console.log(`[governor] adopted legacy plugin data from ${legacyDir}: ${result.moved.join(", ")}`);
        }
      } else if (result.plan.action === "abort") {
        migrationNotice(`data-folder migration ABORTED: ${result.plan.reason}`);
      } else if (result.plan.warn) {
        // A non-routine skip: the old folder looks half-migrated. Escalated on
        // EVERY load until a human resolves it — the stranded data here is the
        // append-only journal, which no later run can reconstruct.
        migrationNotice(`data-folder migration needs attention: ${result.plan.reason}`);
      }
    } catch (e) {
      migrationNotice(
        `data-folder migration FAILED — continuing with DEFAULT settings; the old folder is untouched. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // Load settings FIRST so the enabled gate and guard settings are available.
    await this.loadSettings();

    const vaultName = this.app.vault.getName();
    this.slug = vaultSlug(vaultName);
    const sock = socketPath(this.slug);

    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

    // Write the build-time-embedded bridge into ~/.claude/governor/ (and a
    // grace-period copy into the legacy ~/.claude/vault-mcp/ — see discovery.ts).
    try { writeBridge(); }
    catch (e) { console.error("[governor] writeBridge failed", e); }

    // Kernel v0 — ONE queue and ONE journal per plugin instance, shared by
    // every per-connection server built below. The journal lives beside the
    // plugin's own data (`.obsidian/plugins/governor/journal/YYYY-MM.jsonl`),
    // out of the note tree so it can never be mistaken for vault content.
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    // The identity substrate's uid index — one per plugin instance, like the
    // queue: it is a map of the vault, not of a connection.
    const uidIndex = new UidIndex(obsidianUidSource(this.app));
    // #261: every journal append nudges the governance module's queue poll. Renderer timers
    // are throttled/suspended by Chromium while the window is occluded, so the 2.5s poll
    // interval does not tick during unattended sessions — exactly when agents write. The
    // journal grows only through this kernel, so the append itself is the reliable
    // "journal grew" event; the nudge is a no-op while governance is unmounted, and the
    // signature/in-flight gates in pollJournal keep repeated nudges cheap.
    //
    // #272: the same append also nudges the WRITE QUEUE's wall-clock deadline check.
    // Some journal records land without taking a queue slot (idempotent replays,
    // deduped waiters, key mismatches), so an append can happen while an operation
    // is wedged mid-queue — one more timer-free event that abandons an overdue
    // operation instead of leaving it holding the queue in an occluded window.
    const writeQueue = new WriteQueue();
    const journal = new WriteJournal(this.app.vault.adapter, `${pluginDir}/journal`);
    // A cheap monotonic head marker for session base states (WP5): the count
    // of appends observed since this plugin instance loaded, anchored by the
    // load instant. Approximate on purpose — evidence for reconciliation,
    // not a lock — and honest about its scope: it orders points WITHIN one
    // plugin lifetime and identifies the lifetime across restarts.
    const journalBoot = new Date().toISOString();
    let journalAppends = 0;
    const journalHeadMarker = () => `${journalBoot}#${journalAppends}`;
    const journalAppend = journal.append.bind(journal);
    journal.append = (record) => {
      const done = journalAppend(record);
      void done.then(() => {
        journalAppends++;
        writeQueue.nudge();
        nudgeGovernanceQueue(this);
      });
      return done;
    };
    const kernel = new Kernel(
      writeQueue,
      journal,
      obsidianProbe(this.app, () => this.settings.enforceRecordImmutability),
      new IdempotencyStore(),
      new LockStore(),
      uidIndex,
    );

    // Server identity — the transport asserting which vault and which install.
    // The install id is a small file beside the journal (`install-id.json`), so
    // the identity that stamps every record lives with the records; it survives
    // restarts, and a failure to persist degrades to an ephemeral id rather than
    // failing the load.
    const { install } = await loadInstallId(this.app.vault.adapter, pluginDir);
    const serverIdentity = obsidianServerIdentity(this.app, install, this.manifest.version);

    // ── the session store (WP5) ─────────────────────────────────────────────
    //
    // One durable append-only log beside the plugin's other evidence
    // (`governance/sessions.jsonl`). Session records carry identifiers and
    // digests, never note bodies, so — unlike observation payloads — they
    // belong WITH the synced/backed-up evidence, and auditability wins.
    const sessionsFile = `${pluginDir}/governance/sessions.jsonl`;
    const sessionAdapter = this.app.vault.adapter;
    // Appends are serialized through one chain: the exists?append:write pair
    // is not atomic, and two concurrent connection opens on a fresh vault
    // could otherwise both take the `write` branch, silently losing one
    // `opened` event. Same mutex shape the history store's CAS uses.
    let sessionIoChain: Promise<unknown> = Promise.resolve();
    // Proposals share the sessions' IO shape: append-only JSONL beside the
    // acceptance log, serialized through its own chain. Identifiers and
    // digests only — never note bodies (those live in the history store).
    const proposalsFile = `${pluginDir}/governance/proposals.jsonl`;
    let proposalIoChain: Promise<unknown> = Promise.resolve();
    const proposalStore = createProposalStore({
      appendLine: (line) => {
        const task = async () => {
          const dir = `${pluginDir}/governance`;
          if (!(await sessionAdapter.exists(dir))) await sessionAdapter.mkdir(dir);
          if (await sessionAdapter.exists(proposalsFile)) await sessionAdapter.append(proposalsFile, line + "\n");
          else await sessionAdapter.write(proposalsFile, line + "\n");
        };
        const next = proposalIoChain.then(task, task);
        proposalIoChain = next.catch(() => undefined);
        return next;
      },
      readLines: async () => {
        if (!(await sessionAdapter.exists(proposalsFile))) return [];
        const raw = await sessionAdapter.read(proposalsFile);
        return raw.split("\n").filter(Boolean);
      },
    });

    // The history repository, opened LAZILY on first recording: an idle vault
    // with history off never touches the gitdir. One instance per plugin —
    // the single-writer assumption the CAS mutex documents.
    let historyRepoPromise: Promise<HistoryRepository> | null = null;
    const lazyHistoryRepo = () =>
      (historyRepoPromise ??= openGitRepository({
        gitdir: historyDir(vaultSlug(vaultName)),
        worktree: (this.app.vault.adapter as unknown as { basePath: string }).basePath,
      }));

    // The admission machinery factory (WP6b-2): claims IO, settlement append
    // into the acceptance log, note IO, all closure-held. Built per mount by
    // wireGovernance's call-site; the standing capability itself is
    // constructed inside buildAdmission from the lazy history repo.
    const claimsFile = `${pluginDir}/governance/admission-claims.jsonl`;
    let claimIoChain: Promise<unknown> = Promise.resolve();
    const claimIo = {
      appendLine: (line: string) => {
        const task = async () => {
          const dir = `${pluginDir}/governance`;
          if (!(await sessionAdapter.exists(dir))) await sessionAdapter.mkdir(dir);
          if (await sessionAdapter.exists(claimsFile)) await sessionAdapter.append(claimsFile, line + "\n");
          else await sessionAdapter.write(claimsFile, line + "\n");
        };
        const next = claimIoChain.then(task, task);
        claimIoChain = next.catch(() => undefined);
        return next;
      },
      readLines: async () => {
        if (!(await sessionAdapter.exists(claimsFile))) return [];
        return (await sessionAdapter.read(claimsFile)).split("\n").filter(Boolean);
      },
    };
    const acceptanceLogFile = `${pluginDir}/governance/acceptance-log.jsonl`;

    // WP8: the migration surface — legacy evidence import + the
    // human-confirmed authority cutover. Built here (adapter-backed stores
    // beside the other governance files, all in-vault and inside the
    // obsidian-backup net), state loaded before the guard is set so the
    // BaselineStore's live guard reflects the persisted flip from the first
    // write after load.
    const migration: Migration = buildMigration({
      io: {
        exists: (p) => sessionAdapter.exists(p),
        read: (p) => sessionAdapter.read(p),
        write: (p, d) => sessionAdapter.write(p, d),
        append: (p, d) => sessionAdapter.append(p, d),
        mkdir: (p) => sessionAdapter.mkdir(p),
      },
      paths: {
        govDir: `${pluginDir}/governance`,
        acceptanceLog: acceptanceLogFile,
        pendingIndex: `${pluginDir}/governance/pending-index.json`,
        baselinesDir: `${pluginDir}/governance/baselines`,
        legacyEvidence: `${pluginDir}/governance/legacy-evidence.jsonl`,
        cutoverState: `${pluginDir}/governance/cutover.json`,
      },
      baselines: () => baselinesOf(this),
      now: () => Date.now(),
    });
    migrations.set(this, migration);
    // AWAITED, not fire-and-forget: until the persisted state is read,
    // isCutOver() would answer from the default (not cut over), so on a
    // vault that HAS cut over a legacy write could slip through the load
    // window — and a swallowed load failure would leave two standing
    // writers permanently (review finding). A loadState failure itself
    // reads as corrupt inside the store and fails toward fewer writers.
    await migration.loadState();
    setLegacyWriteGuard(this, () => !migration.isCutOver());

    admissionFactories.set(this, () =>
      buildAdmission({
        repo: lazyHistoryRepo,
        claimIo,
        proposals: proposalStore,
        readNoteBytes: async (path) => {
          if (!(await sessionAdapter.exists(path))) return null;
          return new TextEncoder().encode(await sessionAdapter.read(path));
        },
        writeNoteBytes: async (path, bytes) => {
          // Through the VAULT API, not the raw adapter: vault.modify fires the
          // modify event, so the written-back bytes surface through the
          // ordinary review machinery (classifier → queue) instead of landing
          // silently. A revert is a change like any other — D06.
          const file = this.app.vault.getAbstractFileByPath(path);
          const text = new TextDecoder().decode(bytes);
          if (file instanceof TFile) await this.app.vault.modify(file, text);
          else await this.app.vault.create(path, text);
        },
        appendSettlement: (record) => {
          // Serialized like its sibling stores, and the exists?append:write
          // pair kept inside the chain — which strictly orders settlement
          // and claims appends against EACH OTHER. Honest bound (re-review):
          // wiring.ts's appendLog writes the same file OFF this chain, so the
          // first-ever-settlement vs first-ever-accept-record race on a
          // not-yet-existing file is narrowed, not closed; both writers are
          // human-gesture-paced, so the practical window is nil.
          const task = async () => {
            const line = JSON.stringify(record) + "\n";
            if (await sessionAdapter.exists(acceptanceLogFile)) await sessionAdapter.append(acceptanceLogFile, line);
            else await sessionAdapter.write(acceptanceLogFile, line);
          };
          const next = claimIoChain.then(task, task);
          claimIoChain = next.catch(() => undefined);
          return next;
        },
        refreshProjections: async () => nudgeGovernanceQueue(this),
      })
    );

    const sessionStore = createSessionStore({
      appendLine: (line) => {
        const task = async () => {
          const dir = `${pluginDir}/governance`;
          if (!(await sessionAdapter.exists(dir))) await sessionAdapter.mkdir(dir);
          if (await sessionAdapter.exists(sessionsFile)) await sessionAdapter.append(sessionsFile, line + "\n");
          else await sessionAdapter.write(sessionsFile, line + "\n");
        };
        const next = sessionIoChain.then(task, task);
        sessionIoChain = next.catch(() => undefined);
        return next;
      },
      readLines: async () => {
        if (!(await sessionAdapter.exists(sessionsFile))) return [];
        const raw = await sessionAdapter.read(sessionsFile);
        return raw.split("\n").filter(Boolean);
      },
    });

    const ctx = {
      pluginVersion: this.manifest.version,
      socketPath: sock,
      vaultName,
      pluginDir,
      enabledPlugins: () => Array.from((this.app as any).plugins.enabledPlugins as Set<string>),
      getSettings: () => ({
        readOnly: this.settings.readOnly,
        allowlist: this.settings.allowlist,
        allowDangerousCli: this.settings.allowDangerousCli,
        rawCliProxy: this.settings.rawCliProxy,
        trustedReadOnlyPlugins: this.settings.trustedReadOnlyPlugins,
        schemes: this.settings.schemes,
        modules: this.settings.modules,
        cliPolicy: this.settings.cliPolicy,
        captureObservations: this.settings.captureObservations,
        captureMaxBytes: this.settings.captureMaxBytes,
        historyEnabled: this.settings.historyEnabled,
        historyScope: this.settings.historyScope,
      }),
      serverIdentity,
      sessions: {
        open: (session: import("./kernel/governance/sessions/session.js").SessionV1, now: number) => sessionStore.open(session, now),
        get: (sessionId: string) => sessionStore.get(sessionId),
        close: (sessionId: string, now: number) => sessionStore.close(sessionId, now),
        markExpired: (sessionId: string, now: number) => sessionStore.markExpired(sessionId, now),
        replicaId: install,
        vaultId: vaultName,
        journalHead: () => journalHeadMarker(),
      },
      proposals: {
        open: (proposal: import("./kernel/governance/proposals/proposal.js").ProposalV1, now: number) => proposalStore.open(proposal, now),
        uidOf: (path: string) => {
          const uid = (this.app.metadataCache.getCache(path)?.frontmatter as Record<string, unknown> | undefined)?.uid;
          return typeof uid === "string" && uid.length > 0 ? uid : null;
        },
        vaultId: vaultName,
        // Record the proposal's base and proposed snapshots in the history
        // store (WP4 consumed at last), returning the recording ref — the
        // evidence admission-time verification replays base bytes from,
        // because the write itself destroys them (the review's HIGH finding:
        // without this, every overwrite proposal was permanently
        // unverifiable). Null when the path is outside the effective history
        // scope: an untracked path is ungoverned by the new system, and the
        // producer skips the proposal rather than opening a dead one.
        record: async (proposalId: string, path: string, baseBytes: Uint8Array | null, proposedBytes: Uint8Array) => {
          const scope = effectiveScope(this.settings.historyScope, EXCLUDED_PREFIXES);
          if (!isTracked(scope, path)) return null;
          const repo = await lazyHistoryRepo();
          const ref = proposalRef(proposalId);
          // Base first (recorded-missing for a creation), proposed chained on
          // it — the ref chain IS the diff, and stock git can read both.
          const base = await repo.recordSnapshot({
            ref,
            files: [{ path, bytes: baseBytes }],
            message: `base for proposal ${proposalId}`,
            timestamp: Math.floor(Date.now() / 1000),
            expectedRef: null,
          });
          await repo.recordSnapshot({
            ref,
            files: [{ path, bytes: proposedBytes }],
            message: `proposed for proposal ${proposalId}`,
            timestamp: Math.floor(Date.now() / 1000),
            expectedRef: base.oid,
          });
          return ref;
        },
      },
      getExternalTools: () => this.externalRegistry.entries(),
      getVocabularies: () => this.settings.vocabularies,
      kernel,
    };

    // The uid index is kept fresh only while something can actually read it:
    // a live socket, or the dev tool-runner (which resolves uid: addressing
    // over the same index, socket or no socket). Neither ⇒ no reader ⇒ no
    // upkeep. The runner command below also calls ensureUidIndexWired on use,
    // covering a devToolRunner toggle flipped ON mid-session.
    if (this.settings.enabled || this.settings.devToolRunner) this.ensureUidIndexWired(uidIndex);

    if (this.settings.enabled) {
      // One MCP server per connection → concurrent Claude Code sessions and
      // background agents share the plugin without evicting each other.
      this.listener = new UnixSocketListener(sock, (transport, connOpts) => {
        const server = buildMcpServer(this.app, ctx, { codeMode: connOpts.codeMode });
        server.connect(transport).catch((e) => console.error("[governor] connect failed", e));
      });
      await this.listener.listen();

      const discovery: Discovery = {
        socket_path: sock,
        vault_path: basePath,
        vault_name: vaultName,
        plugin_version: this.manifest.version,
        obsidian_version: (this.app as any).appVersion ?? "",
        started_at: new Date().toISOString(),
        capabilities: ["preamble"],
      };
      writeDiscovery(this.slug, discovery);
      console.log(`[governor] listening on ${sock}`);
    } else {
      console.log("[governor] disabled in settings; socket not started");
    }

    this.addSettingTab(new VaultMcpSettingTab(this.app, this));

    // ── acceptance review pane (#83, cycle 2; module id `acceptance` since 0.12.0,
    // historically `governance` — the src/governance/ dirs keep the old name) ────
    // Mounted when the acceptance module is enabled (default OFF — the module default is
    // `enabled: false`, so an absent settings row means off). This is the human-only Accept
    // surface: an Obsidian review pane whose Accept / Revert / Adopt / auto-accept-allowlist
    // controls are gesture-gated closures — NEVER a command, an MCP tool, or a method on this
    // plugin instance. It is independent of the MCP socket (`settings.enabled`): a human can review
    // even with the transport off. The read-only obsidian_pending_review MCP view is registered
    // always-on in server.ts, separate from this toggle.
    //
    // The mount FOLLOWS the toggle LIVE: flipping the acceptance-enabled toggle in the settings tab
    // mounts or unmounts the pane + gavel ribbon immediately, with NO plugin reload (see
    // `setGovernanceMounted` and connection-ui.ts's per-module enable hook). Here at onload we mount
    // it once if it starts enabled. See src/governance/.
    if (this.settings.modules?.acceptance?.enabled === true) {
      void this.setGovernanceMounted(true);
    }

    // ── skills GUI (#82 residuals: the human affordances the fold left out) ────
    // Wired ONLY when the skills module is enabled (default OFF — the module default is
    // `enabled: false`, so an absent settings row means off). Same toggle that mounts the six
    // MCP tools per connection: enabling the skills module turns on both its tools AND this
    // in-Obsidian GUI (Preview pane, six commands, ribbon, opt-in export-on-save). The GUI is
    // additive — the tool surface + compiler core are unchanged. Read once at onload like the
    // governance pane; toggling it takes effect on plugin reload (the tools take effect on the
    // next session connect). See src/skills/.
    if (this.settings.modules?.skills?.enabled === true) {
      try {
        wireSkills(this, {
          getConfig: () => (this.settings.modules?.skills?.config ?? {}) as Record<string, unknown>,
        });
      } catch (e) {
        console.error("[governor] skills GUI wiring failed", e);
      }
    }

    // ── scheme Inbox + Drift panes (jd-dashboard fold, Stages B/C) ─────────────
    // Mounted on the scheme module's own enabled flag, matching its
    // default-true semantics elsewhere (modules-mount.ts:
    // `settings.modules?.scheme?.enabled === false` is the disabled check, so
    // an absent settings row means on) — both panes are meaningless without
    // scheme addressing configured, same reasoning as skills' GUI riding its
    // own module's toggle above. LIVE mount/unmount (governor#286, fixed
    // after #285/#287 shipped with the pre-#200 onload-only shape): flipping
    // the toggle in settings mounts or unmounts both panes immediately, no
    // plugin reload, via `setSchemePanesMounted` below — same pattern as
    // governance's pane, minus any accept-relevant state (there is none
    // here; both panes are read-only). Neither pane forces a leaf open on
    // its own — the ribbon icon / command opens it on demand.
    if (this.settings.modules?.scheme?.enabled !== false) {
      void this.setSchemePanesMounted(true);
    }
    // Commands register unconditionally, once, regardless of live mount
    // state — see scheme/wiring.ts's registerSchemeCommands doc comment for
    // why (no public Obsidian API to live-unregister a command).
    registerSchemeCommands(this, () => this.settings.modules?.scheme?.enabled !== false);

    this.addCommand({
      id: "connect-claude-code",
      name: "Connect to Claude Code",
      callback: () => this.autoRegister(true),
    });

    // ── dev tool-runner: "Vault MCP: Run tool…" ────────────────────────────────
    // ONE command over the whole tool surface, not one command per tool: ~68
    // commands would spam the palette, and — since every Obsidian command is
    // agent-reachable via obsidian_run_command — would multiply the policy
    // surface for zero gain. The registry is built LAZILY per invocation via a
    // fresh codeMode capture build (the same registration path a new MCP
    // connection runs), so conditional tools reflect the live plugin state.
    // The built server is never connected to any transport — only its captured
    // guarded handlers are used — and its journal actor carries
    // client: "tool-runner" so runner writes are distinguishable in the audit
    // stream while still landing exactly like MCP writes.
    //
    // This command being agent-invokable via obsidian_run_command is fine BY
    // CONSTRUCTION: it grants nothing MCP doesn't already grant (an agent with
    // run_command has the MCP tools directly, under the same guard), and the
    // modal chain requires real UI interaction anyway. Registered regardless of
    // `settings.enabled` (the socket) — dev use with the transport off is the
    // point — but gated live on the devToolRunner setting via checkCallback,
    // which also gates executeCommandById.
    this.addCommand({
      id: "run-tool",
      name: "Run tool…",
      checkCallback: (checking) => {
        if (!this.settings.devToolRunner) return false;
        if (!checking) {
          // A late toggle-on must not leave the runner reading a never-built
          // uid index (empty answers for uids that exist). Idempotent; and
          // onLayoutReady fires immediately when the layout is already ready,
          // so a mid-session first wire rebuilds right away.
          this.ensureUidIndexWired(uidIndex);
          openToolRunner(this.app, () => {
            let registry: CapturedRegistry = new Map();
            buildMcpServer(this.app, ctx, {
              codeMode: true,
              clientLabel: "tool-runner",
              onRegistry: (r) => (registry = r),
            });
            return registry;
          });
        }
        return true;
      },
    });

    void this.autoRegister();

    this.addCommand({
      id: "show-diagnostics",
      name: "Show diagnostics",
      callback: () => {
        const enabled = Array.from((this.app as any).plugins.enabledPlugins as Set<string>);
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"]
          .map((id) => `${id}: ${enabled.includes(id) ? "yes" : "no"}`);
        new DiagnosticsModal(this.app, [
          `Vault: ${this.app.vault.getName()}`,
          `Socket: ${socketPath(this.slug)}`,
          `Version: ${this.manifest.version}`,
          ...integrations,
        ]).open();
      },
    });

    // Signal publishers (vault-mcp-api SDK) that the api is (re-)available.
    // Both events fire during the 0.12.0 id-migration grace period: `governor:ready`
    // is the canonical event going forward; `vault-mcp:ready` is kept for any
    // publisher built against the old id (the SDK needs a dual-id read or a
    // major bump before the legacy event can be dropped).
    this.app.workspace.trigger("governor:ready", this.api);
    this.app.workspace.trigger("vault-mcp:ready", this.api);
  }

  /**
   * The settings tab calls this when a module's enable toggle flips (connection-ui.ts's per-module
   * "Enabled" toggle). Acceptance and scheme are the two modules whose Obsidian surface mounts/
   * unmounts LIVE from here, with no plugin reload — acceptance's review pane + gavel ribbon, and
   * scheme's Inbox + Drift panes (governor#286). Every other module is tool-only: its MCP surface
   * mounts per connection, so its toggle still takes effect on the next session connect (unchanged
   * semantics) and there is nothing to mount or unmount in-app.
   */
  async onModuleEnabledChanged(moduleId: string, enabled: boolean): Promise<void> {
    if (moduleId === "acceptance") await this.setGovernanceMounted(enabled);
    if (moduleId === "scheme") await this.setSchemePanesMounted(enabled);
  }

  /**
   * Drive the governance pane's mount state to `enabled`, live, without a plugin reload. Idempotent
   * (enabling when already mounted, or disabling when already unmounted, is a no-op) and serialized
   * so a rapid enable→disable can't interleave a mount with a teardown. Mount runs the full
   * wireGovernance registration (view + ribbon + events + poll interval, all on a child Component);
   * unmount is `removeChild`, which runs every cleanup that Component registered — detaching open
   * governance leaves (dropping the sole reference to the accept-capable controller), unregistering
   * the view type, removing the ribbon, cancelling the interval, clearing the debounce timers, and
   * flipping the disposed flag. The accept boundary is preserved across the cycle: mount/unmount
   * changes only WHETHER the pane exists, never HOW its gesture-gated controls are reached.
   */
  async setGovernanceMounted(enabled: boolean): Promise<void> {
    const next = this.governanceReconcile.then(() => this.applyGovernanceMount(enabled));
    // Keep the chain alive even if one step rejected, so a later toggle still reconciles.
    this.governanceReconcile = next.catch(() => {});
    await next;
  }

  private async applyGovernanceMount(enabled: boolean): Promise<void> {
    const action = mountAction(this.governanceComponent !== null, enabled);
    if (action === "none") return; // already in the desired state — idempotent no-op
    if (action === "mount") {
      try {
        this.governanceComponent = await wireGovernance(this, {
          getConfig: () => (this.settings.modules?.acceptance?.config ?? {}) as Record<string, unknown>,
          // Built fresh per mount, handed as an argument (§9: never a property).
          admission: admissionFactories.get(this)?.(),
          migration: migrations.get(this),
        });
      } catch (e) {
        console.error("[governor] governance pane wiring failed", e);
        this.governanceComponent = null;
      }
    } else {
      this.removeChild(this.governanceComponent!);
      this.governanceComponent = null;
    }
  }

  /**
   * Drive the scheme Inbox + Drift panes' mount state to `enabled`, live, without a plugin reload —
   * same idempotent, serialized shape as `setGovernanceMounted` (governor#286). Mount runs
   * `wireSchemePanes` (both views + both ribbons, on one shared child Component); unmount is
   * `removeChild`, which detaches any open leaves and unregisters both view types. Neither pane
   * carries acceptance-relevant state, so unlike governance's cycle there's nothing beyond
   * existence for mount/unmount to change.
   */
  async setSchemePanesMounted(enabled: boolean): Promise<void> {
    const next = this.schemePanesReconcile.then(() => this.applySchemePanesMount(enabled));
    this.schemePanesReconcile = next.catch(() => {});
    await next;
  }

  private async applySchemePanesMount(enabled: boolean): Promise<void> {
    const action = mountAction(this.schemePanesComponent !== null, enabled);
    if (action === "none") return;
    if (action === "mount") {
      try {
        this.schemePanesComponent = wireSchemePanes(this, {
          getSchemes: () => this.settings.schemes ?? DEFAULT_SCHEMES,
        });
      } catch (e) {
        console.error("[governor] scheme panes wiring failed", e);
        this.schemePanesComponent = null;
      }
    } else {
      this.removeChild(this.schemePanesComponent!);
      this.schemePanesComponent = null;
    }
  }

  async onunload() {
    await this.listener?.close();
    removeDiscovery(this.slug);
  }
}
