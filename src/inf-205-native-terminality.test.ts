/**
 * INF-205 — Native terminal-state classification is uniform across engine
 * subsystems.
 *
 * INF-203 made Linear's first-class `duplicate` state type terminal in the
 * type-aware paths, but several subsystems still classified terminality from
 * the `state:*` label alone. A child moved natively to Duplicate/Canceled
 * keeps its stale non-terminal label (native moves don't strip labels), so:
 *
 *   - barrier.ts never saw it as terminal → parent barrier deadlock;
 *   - rescue-sweep classified it dormant/malformed and "rescued" a closed ticket;
 *   - sla-sweep breach-alerted on a closed ticket;
 *   - delegation-reconciliation re-bootstrapped a closed ticket;
 *   - stuck-delegate-detector re-prompted the delegate of a closed ticket.
 *
 * Policy (INF-205 ask #1): natively-closed children — completed, canceled,
 * AND duplicate — satisfy a parent's N→1 barrier.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

import { TERMINAL_NATIVE_STATE_TYPES, isNativelyTerminal } from "./terminality.js";
import { isChildTerminal, evaluateBarrier } from "./barrier.js";
import { classifyTicket } from "./rescue-sweep.js";
import { runSlaSweep } from "./sla-sweep.js";
import {
  runDelegationReconciliationSweep,
  type DelegationReconciliationOptions,
} from "./delegation-reconciliation-sweep.js";

// ── terminality module ──────────────────────────────────────────────────────

describe("INF-205 — isNativelyTerminal", () => {
  it("treats completed, canceled, and duplicate as terminal", () => {
    expect(isNativelyTerminal("completed")).toBe(true);
    expect(isNativelyTerminal("canceled")).toBe(true);
    expect(isNativelyTerminal("duplicate")).toBe(true);
  });

  it("treats open native types and missing values as non-terminal", () => {
    expect(isNativelyTerminal("started")).toBe(false);
    expect(isNativelyTerminal("unstarted")).toBe(false);
    expect(isNativelyTerminal("backlog")).toBe(false);
    expect(isNativelyTerminal("triage")).toBe(false);
    expect(isNativelyTerminal(null)).toBe(false);
    expect(isNativelyTerminal(undefined)).toBe(false);
    expect(isNativelyTerminal("")).toBe(false);
  });

  it("matches stuck-delegate-detector's set exactly (completed/canceled/duplicate)", () => {
    expect([...TERMINAL_NATIVE_STATE_TYPES].sort()).toEqual(["canceled", "completed", "duplicate"]);
  });
});

// ── barrier.ts — isChildTerminal ────────────────────────────────────────────

describe("INF-205 — barrier isChildTerminal with native state type", () => {
  it("natively-duplicate child with a stale non-terminal label is terminal", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"], "duplicate")).toBe(true);
  });

  it("natively-canceled child with no labels at all is terminal", () => {
    expect(isChildTerminal([], "canceled")).toBe(true);
  });

  it("open native type still defers to the state:* label", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:done"], "started")).toBe(true);
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"], "started")).toBe(false);
  });

  it("remains backward-compatible when called without a native type", () => {
    expect(isChildTerminal(["wf:dev-impl", "state:done"])).toBe(true);
    expect(isChildTerminal(["wf:dev-impl", "state:implementation"])).toBe(false);
  });
});

// ── barrier.ts — evaluateBarrier ────────────────────────────────────────────

describe("INF-205 — evaluateBarrier counts natively-closed children as terminal", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockChildren(nodes: unknown[]): void {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: { issue: { children: { nodes } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof globalThis.fetch;
  }

  it("duplicate child with stale label + canceled label-less child + done child → allTerminal", async () => {
    mockChildren([
      {
        identifier: "AI-9001",
        state: { name: "Duplicate", type: "duplicate" },
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      },
      {
        identifier: "AI-9002",
        state: { name: "Canceled", type: "canceled" },
        labels: { nodes: [] },
      },
      {
        identifier: "AI-9003",
        state: { name: "In Progress", type: "started" },
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:done" }] },
      },
    ]);

    const result = await evaluateBarrier("AI-9000", "Bearer tok");
    expect(result.allTerminal).toBe(true);
    expect(result.terminalCount).toBe(3);
    expect(result.orphanedCount).toBe(0);
  });

  it("a natively-closed child that lost its state:* label is terminal, not orphaned", async () => {
    mockChildren([
      {
        identifier: "AI-9004",
        state: { name: "Duplicate", type: "duplicate" },
        labels: { nodes: [{ name: "wf:dev-impl" }] }, // wf:* survives, state:* stripped
      },
    ]);

    const result = await evaluateBarrier("AI-9000", "Bearer tok");
    expect(result.allTerminal).toBe(true);
    expect(result.orphanedCount).toBe(0);
    expect(result.children[0]?.isOrphaned).toBe(false);
    expect(result.children[0]?.isTerminal).toBe(true);
  });

  it("an open child with a stale-looking label still holds the barrier", async () => {
    mockChildren([
      {
        identifier: "AI-9005",
        state: { name: "In Progress", type: "started" },
        labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
      },
    ]);

    const result = await evaluateBarrier("AI-9000", "Bearer tok");
    expect(result.allTerminal).toBe(false);
  });
});

// ── rescue-sweep — classifyTicket ───────────────────────────────────────────

describe("INF-205 — rescue-sweep classifies natively-closed tickets as terminal", () => {
  const wfDef = {
    entry_state: "intake",
    states: [
      { id: "intake", owner_role: "steward" },
      { id: "implementation", owner_role: "dev" },
      { id: "done" },
    ],
  };
  const noBodies = (_role: string): string[] => [];

  it("natively-duplicate ticket with stale label and no delegate → terminal (was dormant)", () => {
    const result = classifyTicket(
      ["wf:dev-impl", "state:implementation"],
      null,
      wfDef,
      noBodies,
      "duplicate",
    );
    expect(result).toBe("terminal");
  });

  it("natively-canceled ticket with wf:* but no state:* label → terminal (was malformed)", () => {
    const result = classifyTicket(["wf:dev-impl"], null, wfDef, noBodies, "canceled");
    expect(result).toBe("terminal");
  });

  it("open native type keeps the label-derived classification", () => {
    expect(classifyTicket(["wf:dev-impl", "state:implementation"], null, wfDef, noBodies, "started")).toBe("dormant");
    expect(classifyTicket(["wf:dev-impl"], null, wfDef, noBodies, "started")).toBe("malformed");
  });
});

// ── sla-sweep — natively-closed tickets never breach ────────────────────────

describe("INF-205 — sla-sweep skips natively-closed tickets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-205-sla-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDefs(): string {
    const p = path.join(tmpDir, "wf-defs.yaml");
    fs.writeFileSync(
      p,
      [
        "id: dev-impl",
        "entry_state: intake",
        "states:",
        "  - id: intake",
        "  - id: implementation",
        "    sla: 72h",
        "  - id: done",
      ].join("\n"),
      "utf8",
    );
    return p;
  }

  function governedNode(id: string, identifier: string, nativeType: string, enteredAtMs: number) {
    return {
      id,
      identifier,
      team: { id: "team-1" },
      state: { type: nativeType },
      labels: {
        nodes: [
          { id: `lbl-wf-${id}`, name: "wf:dev-impl" },
          { id: `lbl-state-${id}`, name: "state:implementation" },
        ],
      },
      history: { nodes: [{ createdAt: new Date(enteredAtMs).toISOString() }] },
      parent: null,
    };
  }

  it("breaches only the open ticket when a natively-duplicate one is equally overdue", async () => {
    const entered = Date.now() - 80 * 60 * 60 * 1000; // 80h ago, SLA 72h
    const notify = jest.fn();
    const wakeAgent = jest.fn(async () => {});
    const fetchFn = jest.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                governedNode("uuid-open", "AI-9101", "started", entered),
                governedNode("uuid-dupe", "AI-9102", "duplicate", entered),
                governedNode("uuid-cancel", "AI-9103", "canceled", entered),
              ],
            },
          },
        }),
      )) as unknown as typeof globalThis.fetch;

    const result = await runSlaSweep({
      authToken: "lin_test_token",
      workflowDefPath: writeDefs(),
      fetchFn,
      notify,
      wakeAgent,
      breachStorePath: path.join(tmpDir, "breach.db"),
    });

    expect(result.scanned).toBe(3);
    expect(result.breachesDetected).toBe(1);
    const alerted = notify.mock.calls.map((c) => (c[0] as { ticket?: string }).ticket);
    expect(alerted).toEqual(["AI-9101"]);
  });
});

// ── delegation-reconciliation — natively-closed tickets are never healed ────

describe("INF-205 — delegation-reconciliation skips natively-closed tickets", () => {
  it("does not bootstrap a natively-canceled ticket with a dropped enrollment", async () => {
    // wf:* label, no state:* label, no delegate — the exact AC2 bootstrap
    // trigger — but the ticket is natively closed.
    const fetchFn = jest.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "uuid-closed",
                  identifier: "AI-9201",
                  updatedAt: new Date().toISOString(),
                  state: { type: "canceled" },
                  labels: { nodes: [{ id: "lbl-1", name: "wf:dev-impl" }] },
                  delegate: null,
                  team: { id: "team-1" },
                },
              ],
            },
          },
        }),
      )) as unknown as typeof globalThis.fetch;

    const alertBus = { notify: jest.fn() };
    const operationalEventStore = { record: jest.fn(), append: jest.fn() };

    const result = await runDelegationReconciliationSweep({
      authToken: "lin_test_token",
      fetchFn,
      alertBus,
      operationalEventStore,
      wakeFn: jest.fn(async () => {}),
    } as unknown as DelegationReconciliationOptions);

    expect(result.scanned).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.bootstrapHealed).toBe(0);
    expect(result.errors).toEqual([]);
    // Only the batch listing query — no re-fetch/bootstrap fan-out for the closed ticket.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
