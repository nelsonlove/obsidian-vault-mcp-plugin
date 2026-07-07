# Task 1 Report — Presence Monitor

**Status:** DONE  
**Commit range:** `4174639`..`16c909e` (branch `phase2a-presence-front`)

## Files created

- `packages/server/src/presence.ts` — `PresenceMonitor` implementation
- `packages/server/src/__tests__/presence.test.ts` — 5 TDD tests

## Build + test result

| Check | Result |
|-------|--------|
| `npm run build --workspace packages/server` | CLEAN (tsc, no errors) |
| presence.test.ts (5 tests) | 5/5 PASS |
| register-fs-tools.test.ts (16 tests) | 16/16 PASS |

## Implementation notes

- `probeNow()` uses `net.createConnection(socketPath)` with a 250 ms `setTimeout` guard. Any `error` event (ENOENT / ECONNREFUSED / ENOTSOCK) or timeout resolves `false`; an immediate `connect` event resolves `true` and destroys the socket.
- `start()` fires an immediate `poll()` (async, fire-and-forget), then schedules a `setInterval(pollMs ?? 5000)` loop. Both the cached flag and emitted events (`"up"` / `"down"`) are updated only on state transitions.
- `fs.watch` is wrapped in try/catch and its `error` event is swallowed — macOS APFS can silently miss rename events or throw on setup. The interval poll is the contract; `fs.watch` is an acceleration hint only.
- `stop()` clears the interval and closes the watcher. Calling it multiple times is safe (null-guarded).

## fs.watch caveat

On macOS APFS, `fs.watch` on a directory sometimes fires for unrelated events and can miss `rename` events for socket files. The implementation handles this by: (a) filtering on `filename === path.basename(socketPath)`, (b) treating any error as a no-op, and (c) relying on the `setInterval` poll as the reliable fallback. No test failures attributable to `fs.watch` behavior were observed.

## Zombie-socket guard verification

Test 2 explicitly simulates a zombie: the server is closed (leaving the socket file on macOS), the socket file is unlinked, then a plain regular file is written at the same path. `probeNow()` returns `false` (ENOTSOCK). For the common ECONNREFUSED case (server closed, socket file still present as a socket), any of ECONNREFUSED / ENOTSOCK / ENOENT resolve to `false` — all error codes are handled uniformly.
