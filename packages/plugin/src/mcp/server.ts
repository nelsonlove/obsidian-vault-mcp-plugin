import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TFile, stringifyYaml, parseYaml, type App } from "obsidian";
import { registerFsTools, ok } from "@vault-mcp/core";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerSchemeWriteTools } from "./tools-scheme-write.js";
import { registerSurveyTools } from "./tools-survey.js";
import { registerQuickAddTools } from "./tools-quickadd.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerImportTools, IMPORTER_PLUGIN_ID } from "./tools-import.js";
import { registerCliTools, obsidianTemplateReader } from "./tools-cli.js";
import { registerCliDedicatedTools } from "./tools-cli-dedicated.js";
import { registerSnippetTools, obsidianSnippetSource } from "./tools-snippets.js";
import { registerExternalTools, externalToolSnapshot } from "./external-tools.js";
import { registerLockTools } from "./tools-locks.js";
import { registerUidTools } from "./tools-uid.js";
import { registerPendingReviewTools, obsidianPendingReviewSource } from "./tools-pending-review.js";
import { registerGovernanceRevisionTool, registerGovernanceRevisionsListTool } from "./tools-governance-revision.js";
import { registerLinkTools, obsidianLinkSource } from "./tools-links.js";
import { registerConformanceDebtTools, registerConformanceDebtRenderTool } from "./tools-conformance-debt.js";
import { obsidianDebtRenderSource } from "./obsidian-debt-source.js";
import { obsidianVocabSource } from "./tools-vocab.js";
import { obsidianSkillsBackend } from "./tools-skills.js";
import { obsidianProvenanceBackend } from "./tools-provenance.js";
import { obsidianHealthBackend } from "./tools-health.js";
import { mountModules } from "./modules-mount.js";
import { FILECLASS_PLUGIN_ID } from "./tools-fileclass.js";
import { obsidianCrosssessionSource, obsidianReceiptStore } from "./tools-crosssession.js";
import { obsidianTriageSource } from "./obsidian-triage-source.js";
import { obsidianBasesSource } from "./obsidian-bases-source.js";
import { obsidianJdScaffoldSource } from "./obsidian-jd-scaffold-source.js";
import { registerCodeModeTools, makeCaptureRegister, type CapturedRegistry } from "./tools-code-mode.js";
import { makeGuarded, resolveGuardedPath, withKernelArgs } from "./guarded.js";
import { sealUnguardedRegistration } from "./seal-registration.js";
import { visiblePaths } from "../guard.js";
import type { JournalActor } from "../kernel/index.js";
import { obsidianProbe } from "../kernel/obsidian-probe.js";
import { ObsidianBackend } from "./obsidian-backend.js";
import { registerWriteNotesTool, type GuardedWrite } from "./tools-write-notes.js";
import { uuidv7, formatLocalTimestamp } from "./write-notes-compose.js";
import { makeRegistry, DEFAULT_SCHEMES } from "../kernel/scheme/registry.js";
import { buildMcpActionRegistry } from "../kernel/operations/mcp-registry.js";
import { createOperationExecutor } from "../kernel/operations/executor.js";

export interface BuildOpts {
  /** Code Mode: expose the search/describe/call meta-tool surface instead of the full tool set. */
  codeMode?: boolean;
  /**
   * Receive the captured guarded-tool registry after every registrar has run.
   * Only meaningful with `codeMode: true` — that is the mode in which
   * registrations are CAPTURED rather than registered on the SDK server (a
   * full-surface build hands back an empty registry). The in-Obsidian dev
   * tool-runner (src/tool-runner.ts) uses this to obtain, per invocation, the
   * exact tool set + guard wrappers a fresh code-mode MCP connection would get.
   */
  onRegistry?: (registry: CapturedRegistry) => void;
  /**
   * Journal-actor `client` label for a server no MCP client will ever attach
   * to (the tool-runner's registry-only builds). Used only as a FALLBACK: a
   * real connection's initialize handshake still wins, so an MCP session can
   * never be mislabeled.
   */
  clientLabel?: string;
}

// Per-connection id for the journal's actor block. Monotonic within a plugin
// load; the load-time epoch keeps ids from colliding across plugin reloads.
let connSeq = 0;
const CONN_EPOCH = Date.now().toString(36);

export function buildMcpServer(app: App, ctx: ServerCtx, opts: BuildOpts = {}): McpServer {
  // serverInfo, as returned by `initialize`. `title` carries the vault name so a
  // client with two governor servers attached can tell them apart at the
  // handshake, without a tool call — the same assertion the journal's
  // `actor.server` makes, made once at connect time.
  const server = new McpServer({
    name: "governor",
    version: ctx.pluginVersion,
    ...(ctx.vaultName ? { title: `governor (${ctx.vaultName})` } : {}),
  });
  const connectionId = `${CONN_EPOCH}-${++connSeq}`;

  // Wrap registerTool so every tool handler is guarded before registration.
  // This monkeypatch fires for ALL registerTool calls that follow, including the
  // 17 fs-expressible tools registered via registerFsTools below — because
  // registerFsTools calls server.registerTool, which is this patched version.
  // Cast origRegister to any to bypass overload signature checking on the wrapped handler.
  //
  // The same wrapper also routes MUTATING calls through the plugin-singleton
  // write queue and the write journal (ctx.kernel) — one interception point, so
  // the guarded set, the serialized set, and the journaled set are the same set
  // by construction.
  //
  // In Code Mode the same interception point CAPTURES each guarded tool into a
  // registry instead of registering it; the three meta-tools registered at the
  // end are the only tools the session sees. The guard wrapper travels with
  // the captured handler, so read-only/allowlist bind identically in both modes.
  const origRegister: any = server.registerTool.bind(server);
  // Resolved per call, not once: the MCP client's identity only exists after
  // the initialize handshake, which happens well after the server is built.
  // `server` is the transport's own assertion — which vault, which install,
  // which version — and is resolved once at load, not per call.
  const actor = (): JournalActor => {
    const info = (server.server as any)?.getClientVersion?.();
    // opts.clientLabel is a fallback for builds no client ever connects to
    // (the dev tool-runner): a real handshake identity always takes precedence.
    const client = info?.name ? (info.version ? `${info.name}/${info.version}` : String(info.name)) : opts.clientLabel;
    return {
      transport: "mcp",
      ...(client ? { client } : {}),
      connection: connectionId,
      ...(ctx.serverIdentity ? { server: ctx.serverIdentity } : {}),
    };
  };
  // Named so obsidian_write_notes' pre-compose resolve (below) can share the
  // IDENTICAL uid/scheme resolution + read-only/allowlist check `guarded`
  // itself applies — not a second copy of it.
  // ── the operation seam (WP1) ────────────────────────────────────────────────
  //
  // One registry and one executor per CONNECTION, matching the lifetime of the
  // server itself. That is not incidental: a third-party publisher's tool names
  // are computed from whichever plugins are loaded right now, so they only
  // exist at this moment. Binding them here keeps the executor's lookup exact
  // for every surface — including the ones that are not in this repository.
  //
  // Registry problems are reported the way the module host already reports its
  // own: loudly, to the console, without costing the connection. The declared
  // inventory's correctness is a BUILD property with its own test; re-deciding
  // it per connection would turn a build failure into a runtime outage.
  const actions = buildMcpActionRegistry(externalToolSnapshot(ctx));
  for (const p of actions.problems) console.error("[governor] action registry:", p);
  const executor = createOperationExecutor({
    registry: actions.registry,
    actor: () => {
      const a = actor();
      return { binding: `${a.connection}`, clientClaim: a.client ?? null };
    },
  });

  const guardedOpts = {
    getSettings: () => ctx.getSettings(),
    kernel: ctx.kernel,
    actor,
    executor,
    // `jd:<address>` addressing at the interception point: same per-call
    // freshness as registerSchemeTools's own registry() below (a scheme
    // config edit lands live), and the same notes() source it uses.
    schemes: () => makeRegistry(ctx.getSettings().schemes ?? DEFAULT_SCHEMES),
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
  };
  const guarded = makeGuarded(guardedOpts);
  const registry: CapturedRegistry = new Map();
  const capture = makeCaptureRegister(registry, guarded);
  const register = opts.codeMode
    ? capture
    : (name: string, def: any, handler: any) => origRegister(name, def, guarded(def, handler, name));
  // withKernelArgs runs on the way in, so `if_rev` / `idempotency_key` are
  // declared on every mutating tool's schema — in both modes, and for external
  // tools too — without any registrar knowing they exist. Undeclared arguments
  // are stripped by the SDK's own validation, so declaring here is what makes
  // them reachable by a client at all.
  (server as any).registerTool = (name: string, def: any, handler: any) =>
    register(name, withKernelArgs(def), handler);

  // Patching registerTool alone left FIVE other registration entry points on
  // the SDK server unguarded (#83). Sealing them is what makes module.ts's
  // "no module-specific bypass possible" true by construction rather than by
  // convention — load-bearing because moduleFromRegistrar hands adapted
  // modules the real server, and #83 mounts the accept-veto module here.
  sealUnguardedRegistration(server);

  // ── 17 fs-expressible tools — shared registry + live ObsidianBackend ────────
  // decodeHtml: false — no HTML entities expected from in-process calls.
  // includeIndexStatus omitted — Obsidian's cache is always live; read tools
  // don't need an index_status block.
  // rev: the same mtime token the journal records, so a read hands back exactly
  // what a following write can pass as `if_rev`.
  //
  // The backend also carries the READ BOUNDARY (slice 3.0): six of its methods
  // enumerate the vault with no path to guard, so they filter their own
  // iteration through the allowlist. The filter is resolved per call, like the
  // guard's own settings, so a settings change lands without a reconnect.
  // Same live enforcement getter as the plugin-singleton probe in main.ts:
  // only `.rev` is consumed here today, but a probe whose `record()` ignored
  // the setting would be a silent bypass the moment anything reads it.
  const probe = obsidianProbe(app, () => ctx.getSettings().enforceRecordImmutability !== false);
  const visible = (paths: string[]) => visiblePaths(paths, ctx.getSettings());
  // Hoisted so obsidian_write_notes can drive the same backend writeNote through
  // its own per-item guarded dispatch (see the write-notes block below).
  const backend = new ObsidianBackend(app, visible);
  registerFsTools(server, backend, {
    decodeHtml: false,
    rev: (p) => probe.rev(p),
  });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  // ctx carries the guard's settings: obsidian_repoint_link scans the vault for
  // itself, so it must contain that scan by the allowlist on its own — no
  // argument-level check can see a set the handler discovers.
  registerVaultWriteTools(server, app, ctx);
  // ── scope-provider write surface: assign/refile/renumber address ───────────
  // Cannot go through mountModules below: that host's registerAll gate refuses
  // any tool whose readOnlyHint !== true (its own header comment), and these
  // three mutate by design. Registered directly, same shape as
  // registerVaultWriteTools above. Reuses guardedOpts.schemes/schemeNotes
  // rather than building a third `makeRegistry(...)` closure identical to the
  // one guardedOpts already constructed above — same per-call freshness (a
  // scheme config edit lands live, no reconnect needed), one expression.
  registerSchemeWriteTools(server, app, {
    registry: guardedOpts.schemes,
    notes: guardedOpts.schemeNotes,
    getSettings: () => ctx.getSettings(),
  });
  // Folded in from obsidian-jd-survey (2026-08-19). Hand-registered here, the
  // same shape registerSchemeWriteTools above uses: modules-mount.ts's
  // registerAll gate refuses a non-readOnlyHint tool unless its module opts
  // in via `mutating: true` — a real path (five other modules take it), just
  // not the one chosen for this v1's obsidian_survey_slot.
  registerSurveyTools(server, app, {
    getSettings: () => ctx.getSettings(),
  });
  // ── QuickAdd macros as notes, Stage A (#quickadd-macros-as-notes) ──────────
  // Compiles Macro/UserScript choice notes into QuickAdd's own config via
  // saveSettings() — mutates another plugin's config, not a vault note, so
  // same as registerSchemeWriteTools above: cannot go through modules-mount.ts
  // (readOnlyHint !== true is refused there), registers directly here instead.
  registerQuickAddTools(server, app, ctx);
  registerComplementaryTools(server, app, ctx);
  // ctx: obsidian_list_bookmarks enumerates paths the human bookmarked, which
  // is another argument-less read of vault structure.
  registerNavTools(server, app, ctx);
  registerIntegrationTools(server, app, ctx);
  // ── headless Apple Notes import (#252) ─────────────────────────────────────
  // Conditional on the community Importer plugin's LOADED instance, same
  // gate discipline as registerIntegrationTools; mutating, so it registers
  // directly here (modules-mount.ts refuses readOnlyHint !== true). The
  // handler re-resolves the instance per call and version-gates against the
  // known-good importer versions — see tools-import.ts's header.
  registerImportTools(server, app, {
    importerPlugin: () => ((app as any).plugins?.plugins?.[IMPORTER_PLUGIN_ID] ?? null),
    getSettings: () => ctx.getSettings(),
  });
  // ── advisory scope claims (kernel v0) ──────────────────────────────────────
  // Registered here, after the interception patch, so a claim is guarded,
  // serialized and journaled like any other mutating operation — the claim is
  // itself an act the audit stream should record.
  registerLockTools(server, ctx, actor);
  // ── the uid index's read surface (identity substrate, Delivery step 2) ─────
  // Addressing by uid needs no tool of its own — `uid:<value>` binds at the
  // interception point above — so this is purely the lookup, in both directions.
  registerUidTools(server, ctx);
  // ── pending human-review queue, read-only (slice B3b; #83; repointed #261) ──
  // A READ of the index the governance module publishes at
  // `<plugin dir>/governance/pending-index.json` (the stewardship standalone's
  // path is dead since #164), so an agent can see what a human is about to
  // review and avoid stepping on it. Allowlist-filtered like tools-uid.ts (no
  // path oracle), and EXPLICITLY `published: false` — never silently empty —
  // when the governance module is disabled or has never refreshed. Read-only by
  // construction: it reports published review status; no accept/baseline verb.
  //
  // ALWAYS-ON, decoupled from the governance module toggle (#83 cycle 2 fix).
  // Cycle 1 mounted this THROUGH the governance module, which gated the only MCP
  // read surface behind that module's default-off toggle — a regression. It is
  // restored to an always-on read-only registration so the read surface stays
  // available regardless of whether the (default-off) accept PANE is enabled.
  // The governance module now gates ONLY the Obsidian review pane (wired in
  // main.ts), and contributes ZERO tools to the MCP transport — the accept
  // surface never touches the bridge. See modules-mount.ts's governance module.
  registerPendingReviewTools(server, {
    source: obsidianPendingReviewSource(app, ctx.pluginDir),
    getSettings: () => ctx.getSettings(),
  });
  // ── the revision round-trip's ONE agent verb (#101, phase 1 of #221) ───────
  // governance_submit_revision: a revising agent resubmits (revising → proposed,
  // addressed [!revision-request] callouts removed, optional [!revision-report]
  // inserted). An ORDINARY guarded mutating registration — it rides the patched
  // registerTool above, so read-only mode, the path allowlist, the queue, the
  // journal and the kernel args all bind at the standard interception point,
  // and the accept-forbidden guard re-checks the write inside the handler.
  // Always-on like obsidian_pending_review (it refuses on any non-revising
  // note, so it is inert until a human marks one revising via the pane). The
  // governance MODULE still contributes zero tools — this is a server.ts
  // registration, the registerVaultWriteTools shape.
  registerGovernanceRevisionTool(server, {
    read: async (p) => {
      const f = app.vault.getAbstractFileByPath(p);
      return f instanceof TFile ? app.vault.read(f) : null;
    },
    write: async (p, content) => {
      const f = app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) throw new Error(`not a note: ${p}`);
      await app.vault.process(f, () => content);
    },
    now: () => new Date(),
  });
  // The read-side discovery listing beside it — same always-on rationale
  // (read-only, confers nothing; a dispatcher's view of waiting revision work).
  registerGovernanceRevisionsListTool(server, {
    listNotes: async () =>
      app.vault.getMarkdownFiles().map((f) => ({
        path: f.path,
        frontmatter: (app.metadataCache.getFileCache(f)?.frontmatter ?? null) as Record<string, unknown> | null,
      })),
    read: async (p) => {
      const f = app.vault.getAbstractFileByPath(p);
      return f instanceof TFile ? app.vault.read(f) : null;
    },
    getSettings: () => ctx.getSettings(),
  });
  // ── capability modules: scope-provider + vocab + skills ────────────────────
  // Ruled decision #2 realized: the two capability modules register THROUGH
  // the ModuleRegistry — settings-toggleable (`modules.<id>.enabled`), behind
  // the accept/baseline tripwire, collision refusal, and the mount's
  // read-only-only registrar. The registrar handed over is the PATCHED
  // registerTool above, so module tools land at the same guard/queue/journal
  // interception point as every hand-registered tool, in both modes.
  const moduleRegistry = mountModules((name, def, handler) => (server as any).registerTool(name, def, handler), {
    getSettings: () => ctx.getSettings(),
    getVocabularies: ctx.getVocabularies,
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    vocabSource: obsidianVocabSource(app),
    skillsSource: obsidianSkillsBackend(app),
    provenanceSource: obsidianProvenanceBackend(app),
    healthSource: obsidianHealthBackend(app),
    // The fileclass module (#188) pins the CLI to THIS vault and gates on the
    // Fileclass plugin being LOADED (the instance, not enabledPlugins — a
    // configured-but-uninstalled plugin lingers there, per the plugin-gated-tools
    // locked decision).
    vaultName: ctx.vaultName,
    fileclassPresent: () => !!(app as any).plugins?.plugins?.[FILECLASS_PLUGIN_ID],
    // The crosssession module (#232): vault reads/appends via the duck-typed
    // source; read-receipt state in the plugin dir beside the journal
    // (`crosssession-receipts.json` — the install-id precedent), NOT data.json.
    crosssessionSource: obsidianCrosssessionSource(app as any),
    // `ctx.pluginDir` (manifest.dir), NOT the id-derived default — the two
    // diverge after an in-place 0.12.0 update where the folder is still named
    // `vault-mcp` while the manifest id is `governor`. Receipts landing in a
    // stray `plugins/governor/` folder outside the live plugin dir would never
    // migrate, and deleting that stray (it looks empty) re-serves already
    // attested cross-session entries. Same threading as the sibling
    // `obsidianPendingReviewSource(app, ctx.pluginDir)` above.
    crosssessionReceipts: obsidianReceiptStore(app as any, ctx.pluginDir),
    // The triage module (#221 phase 2): reads via the metadata cache, writes
    // via the SHARED primitives — moveOne (link-healing renameFile),
    // fileManager.trashFile, processFrontMatter — see obsidian-triage-source.ts.
    triageSource: obsidianTriageSource(app),
    // The bases module (#243): the hidden-leaf capture over Obsidian's own
    // Bases engine. The adapter feature-detects the public Bases API itself
    // and the registrar registers nothing when it is absent.
    basesSource: obsidianBasesSource(app),
    // The jd-scaffold module (Stage A + A2 + A3 of the jd-dashboard fold):
    // standard-zeros creation, category-index self-heal, promote-to-folder,
    // reindex-category, and template-driven note creation — reads via
    // getAllLoadedFiles/getAbstractFileByPath, writes via vault.create/
    // createFolder + fileManager.renameFile (link-healing). parseYaml feeds
    // the template-creation tools' accept-forbidden content scan.
    jdScaffoldSource: obsidianJdScaffoldSource(app),
    jdScaffoldParseYaml: parseYaml,
  });
  // Skip-and-report only reports if someone reads the report: every mount
  // defect (unknown module id in settings, a gate-refused tool, a config
  // finding) lands loudly in the console rather than evaporating with the
  // discarded registry. console.error, not a throw — a degraded module
  // surface must not cost the connection (the journal's own convention).
  for (const p of moduleRegistry.problems) console.error("[governor] module host:", p);
  // ── link drift, reported not repaired (slice 2.2) ──────────────────────────
  // Read-only by construction: moves already heal their own links through
  // fileManager.renameFile, so this reports the drift that came from OUTSIDE.
  registerLinkTools(server, obsidianLinkSource(app), ctx);
  // ── conformance debt register (issue #211, Parts A2 + B) ────────────────────
  // The READ tool reports the carried debt (baseline + sidecar + live run:
  // burn-down counts, staleness, budget) — whole-vault, like obsidian_health.
  // The RENDER tool (Part B) materializes the same report as a generated
  // register note beside the baseline; it is mutating (readOnlyHint: false), so
  // it rides the guard-patched registrar (read-only mode, queue, journal) and
  // refuses under an active allowlist unless the register path is inside it.
  // Neither has an accept verb: acceptance metadata is minted only at the
  // human-run --rebaseline, never here, and the rendered note carries only a
  // generated/generator derivation stamp (accept-guard-checked before writing).
  const debtSource = obsidianDebtRenderSource(app);
  const debtCtx = {
    config: ctx.getSettings().modules?.["conformance-debt"]?.config,
    getSettings: () => ctx.getSettings(),
  };
  registerConformanceDebtTools(server, debtSource, debtCtx);
  registerConformanceDebtRenderTool(server, debtSource, debtCtx);
  // ── official-CLI proxy — conditional on the CLI binary being installed ──────
  // AND on the default-OFF "Raw CLI proxy" setting (Security tab): the
  // dedicated pinned-subcommand tools below cover the real usage, so the
  // free-text proxy is a surface a human opts back into.
  // parseYaml is injected for the accept-forbidden guard's content-fence scan;
  // readTemplate for the template guard (create template= / quickadd:run-
  // template path= draw content from a vault note the params only NAME).
  // Both injected so tools-cli.ts stays obsidian-free for headless tests.
  registerCliTools(server, ctx, { parseYaml, readTemplate: obsidianTemplateReader(app) });
  // ── dedicated pinned-subcommand CLI tools (the obsidian_cli decomposition) ──
  // Same transport machinery (vault pinning, exec seam, deny list), one PINNED
  // subcommand per tool with typed args — conditional on the CLI binary only,
  // not on the raw-proxy setting. history:restore is deliberately not among
  // them (#110).
  registerCliDedicatedTools(server, ctx, { parseYaml });
  // ── CSS snippet tools — live app API (app.customCss), always registered ─────
  // The considered `.obsidian` exception: scoped to `.obsidian/snippets/*.css`
  // and nothing else (see tools-snippets.ts's header).
  registerSnippetTools(server, ctx, { source: obsidianSnippetSource(app as any) });
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  registerExternalTools(server, app, ctx);

  // ── batch write + server-side stamping (slice B1) ───────────────────────────
  // obsidian_write_notes is a DISPATCHER, not a single mutating op: to give each
  // item its own journal record it drives a per-item guarded single-writer, and
  // to avoid a reentrant queue deadlock it must not itself take a queue slot. So
  // it registers UNGUARDED via origRegister (the obsidian_call_tool precedent)
  // and each item runs through `guardedWrite` — a real makeGuarded wrapper, so
  // uid/read-only/allowlist/if_rev/idempotency/queue/journal all bind per item.
  // Not registered in Code Mode: that surface is the three meta-tools only, and
  // a session there reaches single writes via obsidian_call_tool.
  if (!opts.codeMode) {
    const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const guardedWrite = guarded(
      { title: "write one note", inputSchema: {}, annotations: RW },
      async ({ path, content, overwrite }: { path: string; content: string; overwrite?: boolean }) =>
        ok(await backend.writeNote(path, content, overwrite ?? true)),
      "obsidian_write_notes"
    ) as unknown as GuardedWrite;
    registerWriteNotesTool(origRegister, guardedWrite, {
      // Same resolution + read-only/allowlist check `guarded` applies at
      // dispatch, shared via guardedOpts — see resolveGuardedPath's doc
      // comment and tools-write-notes.ts for why this must run BEFORE compose.
      resolveTarget: (path) => resolveGuardedPath(path, guardedOpts),
      readExistingFrontmatter: (path) => {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter ?? undefined : undefined;
      },
      revOf: (path) => probe.rev(path),
      stringifyYaml,
      parseYaml,
      mintUid: (createdMs) => uuidv7(createdMs),
      formatTs: formatLocalTimestamp,
    });
  }

  if (opts.codeMode) {
    // Meta-tools register through origRegister directly: they must NOT be
    // guard-wrapped — obsidian_call_tool would otherwise be blocked wholesale
    // in read-only mode, blocking read tools too. The captured handlers carry
    // the guard — and the queue and journal — so enforcement happens per target
    // call. That also keeps the queue non-reentrant: obsidian_call_tool itself
    // never takes a queue slot, so its target can't wait on its own caller.
    // The capture patch is
    // deliberately LEFT INSTALLED: any post-build registration still lands in
    // the registry, guarded — the "every registerTool call is guarded" locked
    // invariant holds in both modes for the server's whole lifetime.
    registerCodeModeTools(server, registry, origRegister);
  }
  // Hand the captured registry to the caller AFTER every registrar above has
  // run, so a registry-only consumer (the dev tool-runner) sees the complete
  // guarded tool set of this build — including conditional registrations.
  opts.onRegistry?.(registry);
  return server;
}
