// LEGACY EVIDENCE IMPORT — WP8, D04/D06.
//
// The legacy acceptance system (baseline blobs + acceptance-log.jsonl +
// pending-index.json) becomes EVIDENCE in the new system, never authority.
// D04's line, taken literally: a baseline that was never a human Accept must
// not become one — on the real vault most baselines are silent advances, and
// importing them as acceptances would fabricate 192 human decisions nobody
// made. So every imported record is an explicit `legacy-import` evidence
// record carrying its source file and the legacy timestamp, and NOTHING
// else: no gestureRef, no verification records, no predicates, no admission
// claim, no standing movement. Those fields do not exist on the record type,
// which is the strongest way to not fabricate them.
//
// Continuity is the baseline store's job, not this module's: the predecessor
// stays readable (read-only after cutover), so legacy-accepted subjects keep
// their local settled state until something changes them. Re-acceptance into
// NEW standing is selective and human: the ordinary proposal → verification
// → gesture → admission path, one decision at a time — no bulk door exists
// here, and none may be added (a migration bootstrap cannot remain a
// permanent mass-silence capability).
//
// Idempotent by identity: every record derives a deterministic importKey
// from its own content (never from importedAt), and the evidence store
// refuses duplicates by key — run the import twice, get the same store.

import { contentHash } from "../hash.js";
import type { Baseline } from "../baseline-store.js";

export interface LegacyImportRecordV1 {
  v: 1;
  record: "legacy-import";
  kind: "legacy-baseline" | "legacy-acceptance-event" | "legacy-pending-index";
  /** Deterministic identity for idempotent import — a function of the payload, never of importedAt. */
  importKey: string;
  /** Where this evidence came from, so an auditor can walk back to the legacy surface. */
  source: { file: string; line?: number };
  /** When THIS import ran (the legacy record's own timestamp lives in the payload). */
  importedAt: number;
  payload: Record<string, unknown>;
  // Deliberately ABSENT, pinned by tests: gestureRef, verification,
  // predicates, claimId, expectedStanding, coveredNotes — an import record
  // that could carry authority fields would be an admission by a quieter
  // door.
}

export interface LegacyImportSurfaces {
  /** Baseline records from the legacy store (content EXCLUDED — the blob store remains the read-only carrier; evidence records carry the hash). */
  baselines: readonly Baseline[];
  /** Raw acceptance-log.jsonl lines, in file order. */
  acceptanceLogLines: readonly string[];
  /** Raw pending-index.json text, or null when absent. */
  pendingIndexRaw: string | null;
  /** Source file names for the audit trail. */
  sources: { baselinesDir: string; acceptanceLog: string; pendingIndex: string };
}

export interface LegacyImportReport {
  baselines: number;
  /** Acceptance-log records by their legacy discriminant — the D04 split made visible: humanAccepts is the ONLY class that was ever a click. */
  acceptanceEvents: { total: number; humanAccepts: number; silentAdvances: number; autoAccepts: number; reverts: number; rekeys: number; dispositions: number; unknown: number };
  pendingIndex: boolean;
  /** Lines that did not parse as JSON — imported anyway as raw evidence, counted here so nothing silently drops. */
  unparseableLines: number;
  totalRecords: number;
}

export interface LegacyImportPlan {
  records: LegacyImportRecordV1[];
  report: LegacyImportReport;
}

function keyOf(kind: string, payload: Record<string, unknown>, line?: number): string {
  // For acceptance-log records the SOURCE LINE is part of identity: two
  // byte-identical log lines (a crash-retry duplicate append, two identical
  // raw lines) are two legacy records, and a payload-only key would plan two
  // and store one — silently dropping evidence inside a single first run
  // (review finding, demonstrated). Baselines and the pending index are
  // path-/file-keyed and carry no line.
  return contentHash(`${kind}\n${line ?? ""}\n${JSON.stringify(payload)}`);
}

function classifyLogRecord(rec: Record<string, unknown>): keyof LegacyImportReport["acceptanceEvents"] | "total" {
  const tag = (rec.action ?? rec.event ?? "") as string;
  if (tag === "accept") return "humanAccepts";
  if (tag === "silent-advance") return "silentAdvances";
  if (tag === "auto-accept" || tag === "class-auto-accept") return "autoAccepts";
  if (tag === "revert") return "reverts";
  if (tag === "baseline-rekey") return "rekeys";
  if (tag === "request-changes" || tag === "withdraw-request") return "dispositions";
  return "unknown";
}

/**
 * Plan the import: every legacy surface restated as `legacy-import` evidence.
 * Pure — reads nothing, writes nothing; the caller resolves the surfaces and
 * applies the plan through the evidence store.
 */
export function planLegacyImport(surfaces: LegacyImportSurfaces, importedAt: number): LegacyImportPlan {
  const records: LegacyImportRecordV1[] = [];
  const counts = { total: 0, humanAccepts: 0, silentAdvances: 0, autoAccepts: 0, reverts: 0, rekeys: 0, dispositions: 0, unknown: 0 };
  let unparseable = 0;

  for (const b of surfaces.baselines) {
    // The blob CONTENT stays in the baseline store (still readable, still the
    // continuity carrier) — the evidence record carries the hash, so no note
    // bodies are duplicated into a second store.
    const payload: Record<string, unknown> = { path: b.path, hash: b.hash, acceptedAt: b.acceptedAt, acceptedBy: b.acceptedBy };
    records.push({
      v: 1,
      record: "legacy-import",
      kind: "legacy-baseline",
      importKey: keyOf("legacy-baseline", payload),
      source: { file: surfaces.sources.baselinesDir },
      importedAt,
      payload,
    });
  }

  surfaces.acceptanceLogLines.forEach((line, i) => {
    if (line.trim() === "") return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      payload = parsed;
      counts.total++;
      counts[classifyLogRecord(parsed) as Exclude<keyof typeof counts, "total">]++;
    } catch {
      // An unparseable line is still evidence — imported raw, never dropped
      // (the history browser's own rule: the audit must not silently lose a
      // record it does not recognize).
      payload = { raw: line };
      unparseable++;
    }
    records.push({
      v: 1,
      record: "legacy-import",
      kind: "legacy-acceptance-event",
      importKey: keyOf("legacy-acceptance-event", payload, i + 1),
      source: { file: surfaces.sources.acceptanceLog, line: i + 1 },
      importedAt,
      payload,
    });
  });

  if (surfaces.pendingIndexRaw !== null) {
    let payload: Record<string, unknown>;
    try {
      payload = { index: JSON.parse(surfaces.pendingIndexRaw) as unknown };
    } catch {
      payload = { raw: surfaces.pendingIndexRaw };
    }
    records.push({
      v: 1,
      record: "legacy-import",
      kind: "legacy-pending-index",
      importKey: keyOf("legacy-pending-index", payload),
      source: { file: surfaces.sources.pendingIndex },
      importedAt,
      payload,
    });
  }

  return {
    records,
    report: {
      baselines: surfaces.baselines.length,
      acceptanceEvents: {
        total: counts.total,
        humanAccepts: counts.humanAccepts,
        silentAdvances: counts.silentAdvances,
        autoAccepts: counts.autoAccepts,
        reverts: counts.reverts,
        rekeys: counts.rekeys,
        dispositions: counts.dispositions,
        unknown: counts.unknown,
      },
      pendingIndex: surfaces.pendingIndexRaw !== null,
      unparseableLines: unparseable,
      totalRecords: records.length,
    },
  };
}

// ── The evidence store ───────────────────────────────────────────────────────

export interface LegacyEvidenceIo {
  appendLine(line: string): Promise<void>;
  readLines(): Promise<string[]>;
}

export interface LegacyEvidenceStore {
  /** Append records not already present (by importKey). Returns what happened — a re-run appends nothing. */
  importRecords(records: readonly LegacyImportRecordV1[]): Promise<{ appended: number; skippedExisting: number }>;
  all(): Promise<LegacyImportRecordV1[]>;
  count(): Promise<number>;
}

export function createLegacyEvidenceStore(io: LegacyEvidenceIo): LegacyEvidenceStore {
  // Imports SERIALIZE: importRecords snapshots the existing keys and then
  // appends across awaits, so two overlapping runs (a double-click, or the
  // cutover's internal re-import racing a manual one) would each see the
  // pre-state and both append everything — a permanent double-store the
  // dedupe can never undo (review finding, demonstrated). Same chain shape
  // as the admission service.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  async function existingKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const line of await io.readLines()) {
      if (line.trim() === "") continue;
      try {
        const rec = JSON.parse(line) as LegacyImportRecordV1;
        if (rec.record === "legacy-import" && typeof rec.importKey === "string") keys.add(rec.importKey);
      } catch {
        /* a corrupt store line dedupes nothing; the append below stays additive */
      }
    }
    return keys;
  }

  return {
    importRecords(records) {
      return serialized(async () => {
      const keys = await existingKeys();
      let appended = 0;
      let skippedExisting = 0;
      for (const rec of records) {
        if (keys.has(rec.importKey)) {
          skippedExisting++;
          continue;
        }
        await io.appendLine(JSON.stringify(rec));
        keys.add(rec.importKey);
        appended++;
      }
      return { appended, skippedExisting };
      });
    },
    async all() {
      const out: LegacyImportRecordV1[] = [];
      for (const line of await io.readLines()) {
        if (line.trim() === "") continue;
        try {
          const rec = JSON.parse(line) as LegacyImportRecordV1;
          if (rec.record === "legacy-import") out.push(rec);
        } catch {
          /* skip corrupt line */
        }
      }
      return out;
    },
    async count() {
      return (await this.all()).length;
    },
  };
}
