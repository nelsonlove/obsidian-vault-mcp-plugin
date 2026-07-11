/**
 * Presence monitor for the Obsidian plugin Unix socket.
 *
 * Detects whether the plugin is reachable by actually attempting a TCP
 * connect (not just checking whether the socket file exists).  A stale
 * `.sock` file left by a crashed Obsidian process returns ECONNREFUSED /
 * ENOTSOCK → the probe resolves `false`, guarding against zombie sockets.
 *
 * Public surface:
 *   createPresenceMonitor({ socketPath, pollMs? })
 *     → { isLive, start, stop, on, probeNow }
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

// ── Public interface ──────────────────────────────────────────────────────────

export interface PresenceMonitor {
  /** Returns the last cached liveness state.  Starts `false` until the first probe resolves. */
  isLive(): boolean;
  /** Begin monitoring: fires an immediate probe, then polls every `pollMs` milliseconds.
   *  Also attempts `fs.watch` on the socket's parent directory for faster detection. */
  start(): void;
  /** Stop monitoring.  Clears the interval and closes the watcher.  Idempotent. */
  stop(): void;
  /** Register a listener for `"up"` (socket became reachable) or `"down"` (no longer reachable). */
  on(ev: "up" | "down", cb: () => void): void;
  /** Actively probe the socket.  Resolves `true` iff a connection succeeds within 250 ms. */
  probeNow(): Promise<boolean>;
  /**
   * TEST SEAM — run exactly one internal poll cycle (probe + state-update + emit)
   * and resolve when it completes.  Bypasses the interval timer and fs.watch so
   * tests can trigger a controlled number of probes without timing uncertainty.
   * @internal — only for use in __tests__/
   */
  _pollForTest(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPresenceMonitor(opts: {
  socketPath: string;
  pollMs?: number;
}): PresenceMonitor {
  const { socketPath, pollMs = 5000 } = opts;
  const emitter = new EventEmitter();

  let cached = false;
  let consecutiveConnectFailures = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;
  // Set by stop(). A poll() already awaiting probeNow() when stop() is called
  // must not mutate state or emit once it resolves — otherwise a slow probe
  // (common under CI load) can fire a "down" after teardown. Reset by start().
  let stopped = false;

  // ── Core probe ──────────────────────────────────────────────────────────────

  function probeNow(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (result: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const socket = net.createConnection(socketPath);

      // 250 ms hard timeout — guards against hung sockets that accept() too slowly
      const timeout = setTimeout(() => {
        socket.destroy();
        done(false);
      }, 250);

      socket.on("connect", () => {
        clearTimeout(timeout);
        socket.destroy();
        done(true);
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        done(false);
      });
    });
  }

  // ── Internal poll ───────────────────────────────────────────────────────────

  async function poll(): Promise<void> {
    const live = await probeNow();
    // Teardown guard: if stop() ran while this probe was in flight, drop the
    // result. probeNow() is the only await in poll(), so a single check here
    // fully protects the synchronous state-update/emit block below.
    if (stopped) return;
    if (live) {
      // Success: flip to live immediately, reset the failure counter.
      consecutiveConnectFailures = 0;
      if (!cached) {
        cached = true;
        emitter.emit("up");
      }
    } else {
      // Failure: distinguish a definitive socket-gone close from a transient
      // connect failure (timeout / zombie / momentary load spike).
      //
      // If the socket FILE is gone, Obsidian definitely unloaded the plugin →
      // emit "down" on the very first failed probe (keep clean-close failover fast).
      //
      // If the file still exists but the connect failed, it could be a transient
      // timeout under load → require 2 consecutive failures before emitting "down".
      const socketFileExists = fs.existsSync(socketPath);
      if (!socketFileExists) {
        // Definitive: socket removed → immediate "down".
        consecutiveConnectFailures = 0;
        if (cached) {
          cached = false;
          emitter.emit("down");
        }
      } else {
        // Ambiguous: connect failed but file is still present.
        consecutiveConnectFailures++;
        if (consecutiveConnectFailures >= 2 && cached) {
          cached = false;
          emitter.emit("down");
        }
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  function start(): void {
    // Idempotent: if already started, do nothing
    if (timer !== null) return;

    // Clear a prior stop() so a restarted monitor can emit again.
    stopped = false;

    // Immediate probe so callers don't wait a full poll interval on startup
    void poll();

    // Interval-based polling — the reliable fallback on all platforms.
    // unref() so the poll timer never keeps the process (or `node --test`) alive
    // on its own; the HTTP listener owns process lifetime in production.
    timer = setInterval(() => void poll(), pollMs);
    timer.unref();

    // Best-effort fs.watch to trigger faster detection on .sock create/delete.
    // macOS APFS can throw or miss rename events — the interval is the contract.
    const dir = path.dirname(socketPath);
    const sockName = path.basename(socketPath);
    try {
      watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        // Trigger a probe whenever the socket file appears or disappears
        if (!filename || filename === sockName) {
          void poll();
        }
      });
      watcher.on("error", () => {
        // Suppress fs.watch errors; interval polling handles all cases
      });
    } catch {
      // fs.watch is unavailable or the directory doesn't exist yet.
      // The interval poll is sufficient — continue silently.
    }
  }

  function stop(): void {
    // Mark stopped first so any in-flight poll() drops its result on resolve.
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (watcher !== null) {
      watcher.close();
      watcher = null;
    }
  }

  // ── Public surface ──────────────────────────────────────────────────────────

  return {
    isLive: () => cached,
    start,
    stop,
    on: (ev: "up" | "down", cb: () => void): void => {
      emitter.on(ev, cb);
    },
    probeNow,
    _pollForTest: poll,
  };
}
