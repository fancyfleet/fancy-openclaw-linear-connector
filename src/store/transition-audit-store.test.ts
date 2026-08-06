/**
 * INF-1277 AC1/AC4 — durable transition-audit persistence store.
 *
 * AC1: Persist each transition-audit record (ticket, intent, from→to, agent,
 *      status, code, detail, gateResults, label-mismatch flag, timestamp) to
 *      a durable store.
 * AC4: Records survive redeploys (not lost on restart).
 *
 * Module under test does not exist yet: src/store/transition-audit-store.ts
 * (naming/shape modeled on the established store convention in this repo —
 * see src/store/mutation-audit-store.ts and src/store/operational-event-store.ts,
 * both SQLite-backed for exactly the "survives restart" requirement AC4 states).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { TransitionAuditStore, type TransitionAuditPersistInput } from "./transition-audit-store.js";

function sampleInput(overrides: Partial<TransitionAuditPersistInput> = {}): TransitionAuditPersistInput {
  return {
    ticket: "INF-1263",
    intent: "continue-workflow",
    fromState: "implementation",
    toState: "code-review",
    agent: "charles",
    status: "failed",
    code: "atomic-mutation-failed",
    detail: "issueUpdate mutation returned success:false",
    gateResults: [
      { name: "phase-2-escalation-gate", passed: true, detail: null },
      { name: "b1-workflow-def-validation", passed: false, detail: "definition mismatch" },
    ],
    labelMismatch: false,
    ...overrides,
  };
}

describe("TransitionAuditStore (INF-1277 AC1)", () => {
  let dir: string;
  let dbPath: string;
  let store: TransitionAuditStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1277-tas-"));
    dbPath = path.join(dir, "transition-audit.db");
    store = new TransitionAuditStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists a record and round-trips every AC1-mandated field", () => {
    const input = sampleInput();
    store.record(input);

    const [record] = store.query({ ticket: "INF-1263" });
    expect(record).toBeDefined();
    expect(record.ticket).toBe("INF-1263");
    expect(record.intent).toBe("continue-workflow");
    expect(record.fromState).toBe("implementation");
    expect(record.toState).toBe("code-review");
    expect(record.agent).toBe("charles");
    expect(record.status).toBe("failed");
    expect(record.code).toBe("atomic-mutation-failed");
    expect(record.detail).toBe("issueUpdate mutation returned success:false");
    expect(record.gateResults).toEqual(input.gateResults);
    expect(record.labelMismatch).toBe(false);
    expect(typeof record.ts).toBe("string");
    expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
  });

  it("assigns a stable identifier so individual records can be referenced/updated", () => {
    const id = store.record(sampleInput());
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("persists a null label-mismatch flag when verification has not run yet", () => {
    store.record(sampleInput({ labelMismatch: null, ticket: "INF-9001" }));
    const [record] = store.query({ ticket: "INF-9001" });
    expect(record.labelMismatch).toBeNull();
  });

  it("persists a true label-mismatch flag distinctly from false/null", () => {
    store.record(sampleInput({ labelMismatch: true, ticket: "INF-9002" }));
    const [record] = store.query({ ticket: "INF-9002" });
    expect(record.labelMismatch).toBe(true);
  });

  it("round-trips gateResults for an empty array (no gates evaluated)", () => {
    store.record(sampleInput({ gateResults: [], ticket: "INF-9003" }));
    const [record] = store.query({ ticket: "INF-9003" });
    expect(record.gateResults).toEqual([]);
  });

  it("query filters by ticket", () => {
    store.record(sampleInput({ ticket: "INF-100" }));
    store.record(sampleInput({ ticket: "INF-200" }));

    const results = store.query({ ticket: "INF-100" });
    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe("INF-100");
  });

  it("query filters by status", () => {
    store.record(sampleInput({ ticket: "INF-300", status: "failed" }));
    store.record(sampleInput({ ticket: "INF-300", status: "applied", code: "ok" }));

    const failedOnly = store.query({ ticket: "INF-300", status: "failed" });
    expect(failedOnly).toHaveLength(1);
    expect(failedOnly[0].status).toBe("failed");
  });

  it("query filters by code", () => {
    store.record(sampleInput({ ticket: "INF-400", code: "atomic-mutation-failed" }));
    store.record(sampleInput({ ticket: "INF-400", code: "release-gate", status: "blocked" }));

    const results = store.query({ ticket: "INF-400", code: "release-gate" });
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("release-gate");
  });

  it("query filters by since/until time range", () => {
    store.record(sampleInput({ ticket: "INF-500", ts: "2026-01-01T00:00:00.000Z" }));
    store.record(sampleInput({ ticket: "INF-500", ts: "2026-06-01T00:00:00.000Z" }));
    store.record(sampleInput({ ticket: "INF-500", ts: "2026-12-01T00:00:00.000Z" }));

    const inRange = store.query({
      ticket: "INF-500",
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-07-01T00:00:00.000Z",
    });
    expect(inRange).toHaveLength(1);
    expect(inRange[0].ts).toBe("2026-06-01T00:00:00.000Z");
  });

  it("query respects a limit and returns most-recent records first", () => {
    store.record(sampleInput({ ticket: "INF-600", ts: "2026-01-01T00:00:00.000Z", code: "first" }));
    store.record(sampleInput({ ticket: "INF-600", ts: "2026-01-02T00:00:00.000Z", code: "second" }));
    store.record(sampleInput({ ticket: "INF-600", ts: "2026-01-03T00:00:00.000Z", code: "third" }));

    const limited = store.query({ ticket: "INF-600", limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].code).toBe("third");
    expect(limited[1].code).toBe("second");
  });

  it("query with no filters returns all records across tickets", () => {
    store.record(sampleInput({ ticket: "INF-700" }));
    store.record(sampleInput({ ticket: "INF-701" }));

    const all = store.query({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("AC4: records survive a process restart — reopening the same dbPath returns prior records", () => {
    store.record(sampleInput({ ticket: "INF-800", code: "survives-restart" }));
    store.close();

    const reopened = new TransitionAuditStore(dbPath);
    try {
      const results = reopened.query({ ticket: "INF-800" });
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe("survives-restart");
    } finally {
      reopened.close();
    }
  });

  it("supports many records without dropping any (durability under volume)", () => {
    for (let i = 0; i < 50; i++) {
      store.record(sampleInput({ ticket: "INF-900", code: `bulk-${i}` }));
    }
    const results = store.query({ ticket: "INF-900", limit: 100 });
    expect(results).toHaveLength(50);
  });
});
