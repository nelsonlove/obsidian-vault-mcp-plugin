/**
 * TDD tests for createLiveProxy (packages/server/src/live-proxy.ts).
 *
 * Uses stub transports (NOT real StreamableHTTPServerTransport / StdioClientTransport)
 * via the _registerSessionForTest seam to exercise the session-lifecycle machinery
 * without spawning bridge.mjs or making real HTTP requests.
 *
 * Assertions:
 *   1. _registerSessionForTest → sessionCount() === 1, pendingCount() === 0.
 *   2. teardownAll() → sessionCount() === 0; stub backend.close() was called.
 *   3. maxSessions: 1 → 2nd initialize request rejected with 503; no new backend spawned;
 *      sessionCount + pendingCount stays ≤ 1.
 *   4. notifyAll({...}) calls http.send() on the live session (spy it); also
 *      must not throw when there are zero sessions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createLiveProxy } from "../live-proxy.js";

// ── Stub transports ────────────────────────────────────────────────────────────

/** Minimal backend stub — satisfies BackendTransportLike without spawning a process. */
function makeStubBackend() {
  return {
    closeCalled: false,
    startCalled: false,
    sendHistory: [] as JSONRPCMessage[],
    async start() {
      this.startCalled = true;
    },
    async close() {
      this.closeCalled = true;
    },
    async send(msg: JSONRPCMessage) {
      this.sendHistory.push(msg);
    },
    onmessage: undefined as ((msg: JSONRPCMessage) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((err: Error) => void) | undefined,
  };
}

/** Minimal HTTP-side stub — satisfies HttpTransportLike without real Express HTTP. */
function makeStubHttp() {
  return {
    closeCalled: false,
    sessionId: undefined as string | undefined,
    sendHistory: [] as JSONRPCMessage[],
    async start() {},
    async close() {
      this.closeCalled = true;
    },
    async send(msg: JSONRPCMessage) {
      this.sendHistory.push(msg);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async handleRequest(_req: any, _res: any, _body?: unknown) {},
    onmessage: undefined as ((msg: JSONRPCMessage) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
}

// ── Minimal req / res stubs for guard-path testing ────────────────────────────

interface ResStub {
  _status: number;
  _body: unknown;
  headersSent: boolean;
  status(n: number): this;
  json(body: unknown): this;
}

function makeReqStub(opts: { sessionId?: string; body?: unknown } = {}): Request {
  return {
    header(name: string): string | undefined {
      if (name.toLowerCase() === "mcp-session-id") return opts.sessionId;
      return undefined;
    },
    body: opts.body ?? null,
    method: "POST",
  } as unknown as Request;
}

function makeResStub(): ResStub {
  const r: ResStub = {
    _status: 0,
    _body: undefined,
    headersSent: false,
    status(n: number) {
      this._status = n;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return r;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("createLiveProxy", () => {
  // ── 1. Register → sessionCount ───────────────────────────────────────────────

  test("_registerSessionForTest → sessionCount() === 1, pendingCount() === 0", () => {
    const live = createLiveProxy({ bridgePath: "/dev/null", maxSessions: 32 });
    live.stop(); // stop reaper so the interval doesn't keep the process alive

    assert.equal(live.sessionCount(), 0, "starts empty");
    assert.equal(live.pendingCount(), 0, "starts with zero pending");

    live._registerSessionForTest("test-sid-1", makeStubHttp(), makeStubBackend());

    assert.equal(live.sessionCount(), 1, "one session registered");
    assert.equal(live.pendingCount(), 0, "none pending (test seam registers directly)");

    live.teardownAll();
  });

  // ── 2. teardownAll → sessionCount 0, backend closed ─────────────────────────

  test("teardownAll() clears sessions and calls backend.close()", () => {
    const live = createLiveProxy({ bridgePath: "/dev/null", maxSessions: 32 });
    live.stop();

    const stubBackend = makeStubBackend();
    const stubHttp = makeStubHttp();
    live._registerSessionForTest("test-sid-2", stubHttp, stubBackend);

    assert.equal(live.sessionCount(), 1, "pre-condition: one session registered");

    live.teardownAll();

    assert.equal(live.sessionCount(), 0, "sessionCount must be 0 after teardownAll()");
    assert.equal(stubBackend.closeCalled, true, "backend.close() must be called");
  });

  // ── 3. maxSessions guard ────────────────────────────────────────────────────

  test("maxSessions: 1 → 2nd initialize rejected (503), no new backend spawned", async () => {
    let backendCreateCount = 0;
    const live = createLiveProxy({
      bridgePath: "/dev/null",
      maxSessions: 1,
      makeBackend: () => {
        backendCreateCount++;
        // Return a stub that satisfies BackendTransportLike
        return makeStubBackend() as ReturnType<typeof makeStubBackend>;
      },
    });
    live.stop();

    // Fill the one allowed slot directly via the test seam
    live._registerSessionForTest("test-sid-3", makeStubHttp(), makeStubBackend());
    assert.equal(live.sessionCount(), 1, "pre-condition: slot filled");

    // Try to initialize a second session — should be blocked
    const req = makeReqStub({
      body: { method: "initialize", jsonrpc: "2.0", id: 1 },
    });
    const res = makeResStub();
    await live.handle(req, res as unknown as Response);

    assert.equal(res._status, 503, "must respond 503 when maxSessions is full");
    assert.equal(backendCreateCount, 0, "no new backend should be spawned when at capacity");
    assert.ok(
      live.sessionCount() + live.pendingCount() <= 1,
      "registered + pending must stay ≤ maxSessions after rejection",
    );

    live.teardownAll();
  });

  // ── 4. notifyAll ────────────────────────────────────────────────────────────

  test("notifyAll({...}) calls http.send() on live session; no-throw with zero sessions", () => {
    const live = createLiveProxy({ bridgePath: "/dev/null", maxSessions: 32 });
    live.stop();

    // Zero sessions: notifyAll must not throw
    assert.doesNotThrow(
      () => live.notifyAll({ method: "$/ping" }),
      "notifyAll with no sessions must not throw",
    );

    // One session: notifyAll must call send
    const stubHttp = makeStubHttp();
    live._registerSessionForTest("test-sid-4", stubHttp, makeStubBackend());

    const msg = { jsonrpc: "2.0" as const, method: "$/notification", params: {} };
    live.notifyAll(msg);

    assert.equal(stubHttp.sendHistory.length, 1, "http.send() must be called once");
    assert.deepEqual(stubHttp.sendHistory[0], msg, "must forward the message verbatim");

    live.teardownAll();
  });
});
