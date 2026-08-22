// MIGRATION WIRING — WP8's shell around the pure migration kernel.
//
// Owns the two persisted surfaces the kernel defines ports for — the legacy
// evidence store (governance/legacy-evidence.jsonl, in-vault, backed up) and
// the cutover state (governance/cutover.json, in-vault, backed up) — and the
// SYNC guard the BaselineStore consults on every legacy write.
//
// The cutover flow re-runs the import in the same act: the import is
// idempotent by importKey, so this costs nothing on a re-run, and it
// guarantees the evidence the human's confirmation covered is current at the
// moment authority moves — no staleness window between "what the report
// said" and "what was actually imported".
//
// Corrupt-state direction (documented, deliberate): an ABSENT cutover file
// means the cutover never ran — legacy authoritative, the stated
// half-landed fail direction. An UNPARSEABLE cutover file is ambiguous, and
// the two mistakes are not symmetric: wrongly re-enabling legacy silently
// runs two standing writers, wrongly disabling it refuses loudly with a
// typed error a human can act on. So corruption fails toward FEWER writers:
// isCutOver() reports true and the state surfaces `corrupt` for the status
// surface to display.

import { planLegacyImport, createLegacyEvidenceStore, type LegacyImportReport, type LegacyEvidenceStore } from "../kernel/governance/migration/legacy-import.js";
import { performCutover, rollbackCutover, CutoverRefusedError, CUTOVER_DEFAULT, type CutoverStateV1, type CutoverStore } from "../kernel/governance/migration/cutover.js";
import type { Baseline } from "../kernel/governance/baseline-store.js";

export interface MigrationIo {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface MigrationDeps {
  io: MigrationIo;
  paths: {
    govDir: string;
    acceptanceLog: string;
    pendingIndex: string;
    baselinesDir: string;
    legacyEvidence: string;
    cutoverState: string;
  };
  /** The loaded legacy baseline store's records (content stays there; the import carries hashes). */
  baselines: () => readonly Baseline[];
  now: () => number;
}

export interface MigrationStatus {
  cutOver: boolean;
  corrupt: boolean;
  state: CutoverStateV1;
  evidenceRecords: number;
}

export interface Migration {
  /** Read the persisted cutover state into memory. Call once at wire-up; the guard reads the cached value synchronously. */
  loadState(): Promise<void>;
  /** SYNC — the BaselineStore's writeAllowed guard consults this on every legacy write. */
  isCutOver(): boolean;
  status(): Promise<MigrationStatus>;
  /** Import every legacy surface as evidence. Idempotent: a re-run appends nothing. */
  importLegacyEvidence(): Promise<{ report: LegacyImportReport; appended: number; skippedExisting: number }>;
  /** The single human-confirmed cutover. Re-runs the import (idempotent), then flips authority. */
  cutOver(gestureRef: string): Promise<CutoverStateV1>;
  /** Human-confirmed rollback — legacy authoritative again. Needs nothing from the disabled machinery. */
  rollback(gestureRef: string): Promise<CutoverStateV1>;
}

export function buildMigration(deps: MigrationDeps): Migration {
  let cached: CutoverStateV1 = CUTOVER_DEFAULT;
  let corrupt = false;

  const evidence: LegacyEvidenceStore = createLegacyEvidenceStore({
    appendLine: async (line) => {
      if (!(await deps.io.exists(deps.paths.govDir))) await deps.io.mkdir(deps.paths.govDir);
      if (await deps.io.exists(deps.paths.legacyEvidence)) await deps.io.append(deps.paths.legacyEvidence, line + "\n");
      else await deps.io.write(deps.paths.legacyEvidence, line + "\n");
    },
    readLines: async () => {
      if (!(await deps.io.exists(deps.paths.legacyEvidence))) return [];
      return (await deps.io.read(deps.paths.legacyEvidence)).split("\n").filter(Boolean);
    },
  });

  const cutoverStore: CutoverStore = {
    async read() {
      // The exists probe rides INSIDE the try: an adapter that throws on the
      // probe (iCloud stall, unmounted dir) is the same ambiguity as an
      // unparseable file, and it must fail toward FEWER writers — the first
      // draft let an exists-throw escape, which left the vault permanently
      // reading not-cut-over: two standing writers, silently (review
      // finding). Absence is the only state that means "never cut over".
      try {
        if (!(await deps.io.exists(deps.paths.cutoverState))) {
          corrupt = false;
          return CUTOVER_DEFAULT;
        }
        const parsed = JSON.parse(await deps.io.read(deps.paths.cutoverState)) as CutoverStateV1;
        if (parsed && parsed.v === 1 && typeof parsed.cutOver === "boolean") {
          corrupt = false;
          return parsed;
        }
      } catch {
        /* fall through to the corrupt branch */
      }
      corrupt = true;
      // Ambiguity fails toward fewer writers (see header): report cut-over so
      // the legacy guard refuses; the human sees `corrupt` on the status
      // surface and repairs or re-runs the flow.
      return { ...CUTOVER_DEFAULT, cutOver: true };
    },
    async write(state) {
      if (!(await deps.io.exists(deps.paths.govDir))) await deps.io.mkdir(deps.paths.govDir);
      await deps.io.write(deps.paths.cutoverState, JSON.stringify(state, null, 2));
      corrupt = false;
    },
  };

  async function runImport() {
    const logLines = (await deps.io.exists(deps.paths.acceptanceLog)) ? (await deps.io.read(deps.paths.acceptanceLog)).split("\n") : [];
    const pendingRaw = (await deps.io.exists(deps.paths.pendingIndex)) ? await deps.io.read(deps.paths.pendingIndex) : null;
    const plan = planLegacyImport(
      {
        baselines: deps.baselines(),
        acceptanceLogLines: logLines,
        pendingIndexRaw: pendingRaw,
        sources: { baselinesDir: deps.paths.baselinesDir, acceptanceLog: deps.paths.acceptanceLog, pendingIndex: deps.paths.pendingIndex },
      },
      deps.now()
    );
    const { appended, skippedExisting } = await evidence.importRecords(plan.records);
    return { report: plan.report, appended, skippedExisting };
  }

  return {
    async loadState() {
      cached = await cutoverStore.read();
    },
    isCutOver() {
      return cached.cutOver || corrupt;
    },
    async status() {
      cached = await cutoverStore.read();
      return { cutOver: cached.cutOver, corrupt, state: cached, evidenceRecords: await evidence.count() };
    },
    importLegacyEvidence: runImport,
    async cutOver(gestureRef) {
      const { report } = await runImport();
      const next = await performCutover(cutoverStore, gestureRef, report, deps.now());
      cached = next;
      return next;
    },
    async rollback(gestureRef) {
      // A corrupt flag file is repaired by a human looking at it, never
      // laundered by a rollback: the corrupt read reports cutOver:true so
      // the guard refuses writes, and rolling THAT back would overwrite
      // whatever the unparseable file recorded — possibly a genuine cutover
      // with its confirmed report — with a state claiming none ever ran
      // (review finding).
      await cutoverStore.read();
      if (corrupt) {
        throw new CutoverRefusedError(
          "state_corrupt",
          `the cutover state file (${deps.paths.cutoverState}) is unreadable — repair or remove it by hand before rolling back; refusing to overwrite what it may record`
        );
      }
      const next = await rollbackCutover(cutoverStore, gestureRef, deps.now());
      cached = next;
      return next;
    },
  };
}
