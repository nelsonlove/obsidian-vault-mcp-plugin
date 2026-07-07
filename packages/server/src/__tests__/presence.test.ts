/**
 * TDD tests for PresenceMonitor (packages/server/src/presence.ts).
 *
 * Tests the connect-probe zombie-socket guard and event-based monitoring:
 *   1. A live net.Server on a temp .sock → probeNow() is true; isLive() is true after start().
 *   2. Close that server, write a regular file to simulate a zombie socket → probeNow() is false.
 *   3. Non-existent socket path → probeNow() is false (no throw).
 *   4. on("down") fires when a live socket is closed while monitoring (short pollMs).
 *   5. stop() is idempotent and stops emitting events.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPresenceMonitor } from "../presence.js";
import type { PresenceMonitor } from "../presence.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpSock(): string {
  return path.join(
    os.tmpdir(),
    `presence-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

/**
 * Start a net.Server on a Unix socket and resolve when it is ready.
 */
function startServer(sockPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(sockPath, () => resolve(server));
  });
}

/**
 * Close a net.Server and resolve when it is fully shut down.
 */
function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

/**
 * Wait for a specific monitor event with a timeout (default 2 s).
 */
function waitForEvent(
  monitor: PresenceMonitor,
  ev: "up" | "down",
  timeoutMs = 2000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for "${ev}" event after ${timeoutMs}ms`)),
      timeoutMs,
    );
    monitor.on(ev, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PresenceMonitor", () => {
  /**
   * 1. Live socket: probeNow() returns true; isLive() is true after start().
   */
  test("probeNow returns true for a live socket; isLive is true after start()", async () => {
    const sockPath = makeTmpSock();
    const server = await startServer(sockPath);

    try {
      const monitor = createPresenceMonitor({ socketPath: sockPath, pollMs: 5000 });

      // probeNow must resolve true immediately for a live server
      assert.equal(
        await monitor.probeNow(),
        true,
        "probeNow() should return true when a server is listening",
      );

      // Register 'up' listener BEFORE start() so the immediate probe's event is captured
      const upEvent = waitForEvent(monitor, "up", 1500);
      monitor.start();
      await upEvent;

      assert.equal(monitor.isLive(), true, "isLive() should be true after 'up' event");
    } finally {
      // monitor.stop() may not have been called yet on early failures
      const m = createPresenceMonitor({ socketPath: sockPath });
      m.stop(); // no-op for freshly created monitor
      await closeServer(server);
      fs.rmSync(sockPath, { force: true });
    }
  });

  /**
   * 2. Zombie socket: server closed + regular file written at socket path →
   *    probeNow() is false (connect-probe rejects non-listening paths).
   */
  test("probeNow returns false for a zombie socket file", async () => {
    const sockPath = makeTmpSock();
    const server = await startServer(sockPath);
    await closeServer(server);

    // Simulate a zombie: remove any leftover socket file (macOS leaves it),
    // then plant a plain regular file at the same path (ENOTSOCK or ECONNREFUSED
    // either way causes the probe to resolve false).
    try {
      fs.unlinkSync(sockPath);
    } catch {
      // may have already been cleaned up
    }
    fs.writeFileSync(sockPath, "");

    try {
      const monitor = createPresenceMonitor({ socketPath: sockPath });
      assert.equal(
        await monitor.probeNow(),
        false,
        "probeNow() should return false for a zombie (non-listening) socket path",
      );
    } finally {
      fs.rmSync(sockPath, { force: true });
    }
  });

  /**
   * 3. Non-existent socket path → probeNow() resolves false without throwing.
   */
  test("probeNow returns false for a non-existent socket path (no throw)", async () => {
    const sockPath = makeTmpSock(); // does NOT exist on disk
    const monitor = createPresenceMonitor({ socketPath: sockPath });

    let result: boolean | undefined;
    let threw = false;
    try {
      result = await monitor.probeNow();
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "probeNow() must not throw for non-existent path");
    assert.equal(result, false, "probeNow() must return false for non-existent path");
  });

  /**
   * 4. on("down") fires when a live socket is closed while the monitor is running.
   *    Uses a short pollMs (50 ms) so the interval detects the change quickly.
   *
   *    Note: on macOS, Node.js does NOT delete the socket file when the server closes,
   *    so the "down" event requires 2 consecutive failed probes (≈ 2 × pollMs ≈ 100 ms),
   *    still comfortably within the 2 000 ms waitForEvent timeout.
   */
  test('on("down") fires when a live socket is closed while monitoring', async () => {
    const sockPath = makeTmpSock();
    const server = await startServer(sockPath);

    const monitor = createPresenceMonitor({ socketPath: sockPath, pollMs: 50 });

    try {
      // Wait for the initial 'up' event from the immediate probe on start()
      const upEvent = waitForEvent(monitor, "up", 1500);
      monitor.start();
      await upEvent;
      assert.equal(monitor.isLive(), true, "isLive() should be true after initial 'up'");

      // Subscribe to 'down' before closing the server so we don't miss it
      const downEvent = waitForEvent(monitor, "down", 2000);
      await closeServer(server);
      // Two consecutive polls (≤ 2 × 50 ms) should detect the closed socket
      await downEvent;

      assert.equal(monitor.isLive(), false, "isLive() should be false after 'down' event");
    } finally {
      monitor.stop();
      fs.rmSync(sockPath, { force: true });
    }
  });

  /**
   * 6. Debounce: a single spurious connect-failure while the socket FILE exists
   *    does NOT emit "down"; two consecutive failures do.
   *
   *    Uses _pollForTest() to invoke exactly one poll cycle per phase, bypassing
   *    the interval timer and fs.watch entirely.  This avoids macOS FSEvents
   *    coalescing (where a recent writeFileSync can be delivered as a spurious
   *    event to a newly-created fs.watch, triggering an unintended second probe).
   *
   *    The zombie file (regular file at the socket path) makes fs.existsSync()
   *    return true so the debounce path is exercised, regardless of whether macOS
   *    keeps or removes the socket file after server.close().
   */
  test("single connect-failure while socket file exists does NOT emit 'down'; two consecutive do", async () => {
    const sockPath = makeTmpSock();
    const monitor = createPresenceMonitor({ socketPath: sockPath, pollMs: 60_000 });
    let downCount = 0;
    monitor.on("down", () => { downCount++; });

    try {
      // Phase 1: advance the monitor to cached=true ("up") via one explicit poll.
      const server = await startServer(sockPath);
      await monitor._pollForTest(); // probeNow=true → cached=true, emit "up"
      assert.equal(monitor.isLive(), true, "pre-condition: monitor is live");
      assert.equal(downCount, 0, "pre-condition: no 'down' emitted yet");

      // Plant a zombie: close the server and replace the socket with a plain
      // regular file so fs.existsSync(sockPath)=true but net.connect() fails
      // (ENOTSOCK) — the "ambiguous transient failure" path in poll().
      await closeServer(server);
      try { fs.unlinkSync(sockPath); } catch { /* may already be gone */ }
      fs.writeFileSync(sockPath, "zombie");

      // Phase 2: first failure probe — file exists, connect fails →
      // consecutiveConnectFailures becomes 1 → must NOT emit "down" yet.
      await monitor._pollForTest();
      assert.equal(downCount, 0, "single connect-failure must not emit 'down'");
      assert.equal(monitor.isLive(), true, "isLive() must still be true after 1 failure");

      // Phase 3: second consecutive failure probe →
      // consecutiveConnectFailures becomes 2 → must emit "down".
      await monitor._pollForTest();
      assert.equal(downCount, 1, "two consecutive connect-failures must emit 'down' exactly once");
      assert.equal(monitor.isLive(), false, "isLive() must be false after 'down'");
    } finally {
      monitor.stop();
      fs.rmSync(sockPath, { force: true });
    }
  });

  /**
   * 7. Fast path: deleting the socket file emits "down" on the very first failed probe.
   *
   *    When fs.existsSync(socketPath) returns false, Obsidian definitively unloaded
   *    the plugin — no debounce needed.  "down" must fire immediately (first probe).
   *    Uses _pollForTest() for the same reason as test 6 (no fs.watch interference).
   */
  test("deleting the socket file emits 'down' on the first probe", async () => {
    const sockPath = makeTmpSock();
    const server = await startServer(sockPath);
    const monitor = createPresenceMonitor({ socketPath: sockPath, pollMs: 60_000 });
    let downCount = 0;
    monitor.on("down", () => { downCount++; });

    try {
      // Get to "up" state via one explicit poll.
      await monitor._pollForTest(); // probeNow=true → cached=true, emit "up"
      assert.equal(monitor.isLive(), true, "pre-condition: monitor is live");

      // Close the server AND explicitly delete the socket file.
      await closeServer(server);
      fs.rmSync(sockPath, { force: true });

      // First probe: fs.existsSync returns false → immediate "down" (no debounce).
      await monitor._pollForTest();
      assert.equal(downCount, 1, "socket file gone → 'down' must fire on the first probe");
      assert.equal(monitor.isLive(), false, "isLive() must be false after 'down'");
    } finally {
      monitor.stop();
      fs.rmSync(sockPath, { force: true });
    }
  });

  /**
   * 5. stop() is idempotent and stops emitting events.
   *    Calling stop() twice must not throw; after stop(), no further events fire.
   */
  test("stop() is idempotent and prevents further events from firing", async () => {
    const sockPath = makeTmpSock();
    const server = await startServer(sockPath);
    const monitor = createPresenceMonitor({ socketPath: sockPath, pollMs: 50 });

    try {
      // Wait for initial 'up' to confirm monitor is running
      const upEvent = waitForEvent(monitor, "up", 1500);
      monitor.start();
      await upEvent;

      // Stop the monitor — all internal timers/watchers should be cleared
      monitor.stop();
      monitor.stop(); // second call must not throw or double-free

      // Register a listener AFTER stop — it must never fire
      let eventFiredAfterStop = false;
      monitor.on("down", () => {
        eventFiredAfterStop = true;
      });

      // Close the server — without the interval running, no 'down' should fire
      await closeServer(server);

      // Wait long enough to catch any leaked interval tick (3 × pollMs is generous)
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      assert.equal(
        eventFiredAfterStop,
        false,
        "No events should fire after stop() — interval must be cleared",
      );
    } finally {
      // Ensure stop is called even on failure (idempotent, so safe)
      monitor.stop();
      fs.rmSync(sockPath, { force: true });
    }
  });
});
