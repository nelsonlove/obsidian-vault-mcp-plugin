# WP8 cutover runbook — legacy acceptance → admission

This is the one human-confirmed step in Gate 1. You (Nelson) click it; agents cannot.

## What the cutover does

One click in Settings → Governor → "Authority migration". After it:

- Standing authority is the **admission chain only**. Accept, adopt-baseline, and auto-accept are disabled — their writers **refuse** (typed error), and their controls show a retirement notice.
- The legacy baselines and acceptance log stay **readable** (continuity + audit). Nothing is deleted.
- Legacy records are already imported as `legacy-import` **evidence** (governance/legacy-evidence.jsonl). A silent-advance baseline never becomes an acceptance — only the records that were real Accept clicks say so.
- To put a legacy-accepted note into the NEW standing: ordinary path (proposal → verify → your Admit click), one decision at a time. There is no bulk door.

## Preconditions — do these first

1. **Fresh backup commit.** Confirm the `obsidian-backup` repo has a commit newer than your last vault change. It covers `.obsidian/plugins/governor/` — the claims, baselines, acceptance log, evidence, and the cutover flag itself.
2. **Know what the backup does NOT cover (issue #337).** The **standing chain** lives at `~/.claude/governor/history/` — outside the vault, outside every backup. So do the proposal snapshots. If that disk data is lost after cutover, every admitted subject silently reads as "ungoverned" (a CRITICAL banner in the review pane now catches this state). Decide #337 (back up / relocate the chain) before or soon after cutover; until then, "backed up" is **not complete**.
3. **Run "Import legacy evidence"** (same settings section) and read the numbers in the notice. The confirm dialog shows them again. Import is idempotent — running it twice adds nothing.

## The click

"Cut over…" → confirm dialog (shows the import report and this warning) → done. The flag write IS the cutover.

**Fail direction:** if anything fails mid-flow, the flag is not written and **legacy is still authoritative** — never both, never neither. A corrupt flag file fails the other way (legacy writes refuse) and the status line says CORRUPT; repair or re-run.

## Rollback

"Roll back cutover…" in the same section. Human-confirmed, flag write only, needs nothing from the disabled machinery. Legacy becomes authoritative again; admissions already in the chain stay recorded.

## Verify after cutover

- Settings status line says "Cutover: DONE".
- The review pane shows the retirement notice instead of Adopt baseline / auto-accept.
- An agent write still lands as a proposal; your Admit still works.
- The review pane shows **no** "STANDING HEALTH CRITICAL" banner.
