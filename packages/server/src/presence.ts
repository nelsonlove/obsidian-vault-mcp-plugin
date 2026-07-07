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
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createPresenceMonitor(opts: {
  socketPath: string;
  pollMs?: number;
}): PresenceMonitor {
  const { socketPath, pollMs = 5000 } = opts;
  const emitter = new EventEmitter();

  let cached = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;

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
    if (live !== cached) {
      cached = live;
      emitter.emit(live ? "up" : "down");
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  function start(): void {
    // Idempotent: if already started, do nothing
    if (timer !== null) return;

    // Immediate probe so callers don't wait a full poll interval on startup
    void poll();

    // Interval-based polling — the reliable fallback on all platforms
    timer = setInterval(() => void poll(), pollMs);

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
  };
}
