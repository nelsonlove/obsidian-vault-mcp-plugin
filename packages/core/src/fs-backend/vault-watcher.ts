import chokidar, { FSWatcher } from "chokidar";
import path from "node:path";
import { applyAddOrChange, applyUnlink } from "./index-store.js";

/**
 * Filesystem watcher → per-path debounced incremental reindex.
 *
 * Two writers touch the vault: this server's own write tools and the
 * `obsidian-sync` sidecar pulling iOS / desktop edits. Neither updates the
 * in-memory index directly. This watcher closes the gap by dispatching each
 * chokidar event to the matching incremental op in `index-store.ts`.
 *
 * v2 strategy (issue #23, this PR): per-path debounce + per-event mutations.
 * Each path has its own timer; events for the same path within the debounce
 * window coalesce to the latest one (latest event wins — fired against the
 * current disk state, so even unusual sequences like change→unlink land on
 * the right shape). Different paths don't block each other.
 *
 * Why latest-wins is enough: the incremental ops re-read the file from disk
 * (or apply the synchronous removal), so they always reflect the latest disk
 * state when they fire. We don't need to reason about whether a 'change'
 * came before an 'add' — the file's current contents settle the question.
 * The one exception is add→unlink within the window: applyUnlink no-ops if
 * the file was never in the index, so transient files leave no trace.
 *
 * Trade vs v1: v1 was a single global debounce + full rebuild on fire
 * (~3.5s end-to-end on 7200 notes). v2 is per-path debounce + per-file
 * incremental (~250ms end-to-end). The previous version also re-derived
 * `backlinks` from scratch each cycle, which incidentally cleaned up
 * dangling refs after a `delete_note`; v2 maintains that invariant
 * explicitly in `applyUnlink` (see `removeBacklinkEdges` + clearing the
 * inverse list). The equivalence-with-full-rebuild tests in
 * `src/__tests__/index-store.test.ts` lock that down.
 *
 * Implementation notes:
 *   - `ignoreInitial: true` so we don't double-trigger after the startup
 *     `buildIndex()`. The startup index is already authoritative.
 *   - Mirrors walkVault's ignore set (`.obsidian`, `.trash`, `.git`,
 *     `node_modules`) plus any dotfile/dotdir. chokidar's `ignored`
 *     callback filters at watch time; `shouldIgnore` defends inside the
 *     event handler too.
 *   - Only `.md` files matter.
 *   - `applyAddOrChange` is the single entry point for add OR change —
 *     it looks up `byPath` to decide which case it is. So even if events
 *     arrive in unusual orders the dispatcher stays simple.
 *
 * `obsidian_force_reindex` is kept as a synchronous escape hatch — useful
 * for tight read-after-write loops or recovering from a missed event.
 */

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export interface VaultWatcherOptions {
  /** Path to the vault root to watch (must be absolute). */
  vaultRoot: string;
  /** Per-path debounce window in ms. Each event for a path resets ITS timer;
   * different paths don't share a timer. Default 250. */
  debounceMs?: number;
  /** Test hook: called after each per-path mutation completes. Production
   * code logs to stderr instead. */
  onMutation?: (event: "add" | "change" | "unlink", relPath: string) => void;
}

export interface VaultWatcherHandle {
  /** Stop watching and release inotify/FSEvents watches. Idempotent. */
  stop(): Promise<void>;
}

type WatchEvent = "add" | "change" | "unlink";

export async function startVaultWatcher(opts: VaultWatcherOptions): Promise<VaultWatcherHandle> {
  const debounceMs = opts.debounceMs ?? 250;
  const root = opts.vaultRoot;

  // Per-path state: the last event seen for that path + its pending timer.
  // When the timer fires we apply the *latest* event, since the file's
  // current state on disk is the source of truth.
  const pathState = new Map<string, { event: WatchEvent; timer: NodeJS.Timeout }>();
  let stopped = false;

  function shouldIgnore(absPath: string): boolean {
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith("..")) return true;
    const parts = rel.split(path.sep);
    return parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith("."));
  }

  async function applyEvent(event: WatchEvent, absPath: string): Promise<void> {
    const rel = path.relative(root, absPath);
    try {
      if (event === "unlink") {
        await applyUnlink(absPath);
      } else {
        // 'add' and 'change' both route through applyAddOrChange — it looks
        // at byPath to decide which case it is, so the dispatch is symmetric.
        await applyAddOrChange(absPath);
      }
      if (opts.onMutation) {
        opts.onMutation(event, rel);
      } else {
        console.error(`watcher: ${event} ${rel}`);
      }
    } catch (e) {
      console.error(
        `watcher: ${event} ${rel} failed — ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  function scheduleMutation(event: WatchEvent, absPath: string): void {
    if (stopped) return;
    const prev = pathState.get(absPath);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const final = pathState.get(absPath)?.event ?? event;
      pathState.delete(absPath);
      void applyEvent(final, absPath);
    }, debounceMs);
    pathState.set(absPath, { event, timer });
  }

  function onEvent(event: WatchEvent, absPath: string) {
    if (shouldIgnore(absPath)) return;
    if (!absPath.toLowerCase().endsWith(".md")) return;
    scheduleMutation(event, absPath);
  }

  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p: string) => {
      const rel = path.relative(root, p);
      if (!rel) return false; // root itself
      if (rel.startsWith("..")) return true;
      const parts = rel.split(path.sep);
      return parts.some((part) => IGNORED_DIRS.has(part) || part.startsWith("."));
    },
  });

  watcher.on("add", (p) => onEvent("add", p));
  watcher.on("change", (p) => onEvent("change", p));
  watcher.on("unlink", (p) => onEvent("unlink", p));
  watcher.on("error", (err) => {
    console.error(`watcher: error — ${err instanceof Error ? err.message : String(err)}`);
  });

  await new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });
  console.error(`watcher: ready (per-path debounce ${debounceMs}ms, root ${root})`);

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of pathState.values()) {
        clearTimeout(entry.timer);
      }
      pathState.clear();
      await watcher.close();
    },
  };
}
