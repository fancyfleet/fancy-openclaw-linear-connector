/**
 * INF-696 / S3: post-fanout child dispatch and ack verification.
 *
 * AC mapping:
 * - AC3.1: every child is verified from three independent facts:
 *   delegate present, dispatch record exists with dispatchId + resolved
 *   sessionKey, and gateway ack status is accepted or queued. A record without
 *   ack remains pending, reusing INF-316 semantics.
 * - AC3.2: steward-facing "delegates verified" refuses unless AC3.1 holds for
 *   every open child. The INF-670 fixture is reproduced as 5 children with 2
 *   null-delegate/no-dispatch orphans that must be named.
 * - AC3.3: verification is exhaustive over the created batch: N created child
 *   identifiers produce N result rows, and a created-then-lost child is surfaced
 *   as a missing result.
 *
 * - AC3.4: production fan-out completion wiring passes the liveness dispatch
 *   store from createApp through proxy into workflow-gate, and workflow-gate
 *   verifies before recording an awaiting fan-out outcome.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { DispatchRecordStore } from "./liveness-channel/dispatch-record-store.js";

interface FanoutChildFixture {
  identifier: string;
  delegateAgentId: string | null;
}

let tmpDir: string;
let dispatchStore: DispatchRecordStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-696-"));
  dispatchStore = new DispatchRecordStore(path.join(tmpDir, "liveness-dispatches.db"));
});

afterEach(() => {
  dispatchStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function child(identifier: string, delegateAgentId: string | null): FanoutChildFixture {
  return { identifier, delegateAgentId };
}

function seedDispatch(
  identifier: string,
  agentId: string,
  ackStatus?: "accepted" | "queued",
) {
  const record = dispatchStore.recordDispatch({
    agentId,
    ticketId: identifier,
    sessionKey: `linear-${identifier}`,
  });

  if (ackStatus) {
    dispatchStore.recordAck(record.dispatchId, {
      delivered: true,
      target_identity: agentId,
      status: ackStatus,
    });
  }

  return record;
}

async function loadVerifier(): Promise<{
  verifyPostFanoutChildDispatches: (input: unknown) => {
    allVerified: boolean;
    expectedCount?: number;
    resultCount?: number;
    missingResultIdentifiers?: string[];
    notVerifiedIdentifiers: string[];
    results: unknown[];
  };
  verifyStewardFanoutDelegates: (input: unknown) => {
    allDelegatesVerified: boolean;
    refused: boolean;
    summary: string;
    orphanIdentifiers: string[];
    notVerifiedIdentifiers: string[];
    results: unknown[];
  };
}> {
  return import("./post-fanout-child-verification.js");
}

describe("INF-696 AC3.1: child verification requires delegate, dispatch record, and accepted/queued ack", () => {
  it("marks delegate-present/no-record and record-without-ack children not verified while preserving pending status", async () => {
    const { verifyPostFanoutChildDispatches } = await loadVerifier();
    const accepted = seedDispatch("INF-696-A", "igor", "accepted");
    seedDispatch("INF-696-C", "felix");

    const result = verifyPostFanoutChildDispatches({
      parentIdentifier: "INF-670",
      createdChildIdentifiers: ["INF-696-A", "INF-696-B", "INF-696-C"],
      openChildren: [
        child("INF-696-A", "igor"),
        child("INF-696-B", "sage"),
        child("INF-696-C", "felix"),
      ],
      dispatchStore,
    });

    expect(result.allVerified).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({
        identifier: "INF-696-A",
        delegateAgentId: "igor",
        verified: true,
        dispatchId: accepted.dispatchId,
        sessionKey: "linear-INF-696-A",
        ackStatus: "accepted",
      }),
      expect.objectContaining({
        identifier: "INF-696-B",
        delegateAgentId: "sage",
        verified: false,
        status: "no-dispatch-record",
        dispatchId: null,
        sessionKey: null,
        ackStatus: null,
      }),
      expect.objectContaining({
        identifier: "INF-696-C",
        delegateAgentId: "felix",
        verified: false,
        status: "pending",
        ackStatus: "pending",
      }),
    ]);
    expect(result.notVerifiedIdentifiers).toEqual(["INF-696-B", "INF-696-C"]);
  });

  it("accepts queued gateway acks as verified dispatch acknowledgments", async () => {
    const { verifyPostFanoutChildDispatches } = await loadVerifier();
    const queued = seedDispatch("INF-696-Q", "noah", "queued");

    const result = verifyPostFanoutChildDispatches({
      parentIdentifier: "INF-670",
      createdChildIdentifiers: ["INF-696-Q"],
      openChildren: [child("INF-696-Q", "noah")],
      dispatchStore,
    });

    expect(result.allVerified).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        identifier: "INF-696-Q",
        verified: true,
        dispatchId: queued.dispatchId,
        sessionKey: "linear-INF-696-Q",
        ackStatus: "queued",
      }),
    ]);
  });
});

describe("INF-696 AC3.2: steward delegates-verified check refuses INF-670 false positives", () => {
  it("reproduces INF-670: 5 children, 2 null-delegate/no-dispatch orphans named, not all verified", async () => {
    const { verifyStewardFanoutDelegates } = await loadVerifier();
    seedDispatch("INF-670-1", "igor", "accepted");
    seedDispatch("INF-670-2", "sage", "queued");
    seedDispatch("INF-670-3", "felix", "accepted");

    const result = verifyStewardFanoutDelegates({
      parentIdentifier: "INF-670",
      expectedChildIdentifiers: ["INF-670-1", "INF-670-2", "INF-670-3", "INF-670-4", "INF-670-5"],
      openChildren: [
        child("INF-670-1", "igor"),
        child("INF-670-2", "sage"),
        child("INF-670-3", "felix"),
        child("INF-670-4", null),
        child("INF-670-5", null),
      ],
      dispatchStore,
    });

    expect(result.allDelegatesVerified).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.summary).toMatch(/not-all-verified/i);
    expect(result.orphanIdentifiers).toEqual(["INF-670-4", "INF-670-5"]);
    expect(result.notVerifiedIdentifiers).toEqual(["INF-670-4", "INF-670-5"]);
    expect(result.results).toHaveLength(5);
  });
});

describe("INF-696 AC3.3: verification is exhaustive over every created child", () => {
  it("returns one verification result per created child and flags a created-then-lost child as missing", async () => {
    const { verifyPostFanoutChildDispatches } = await loadVerifier();
    seedDispatch("INF-696-EX-1", "igor", "accepted");
    seedDispatch("INF-696-EX-2", "sage", "accepted");

    const result = verifyPostFanoutChildDispatches({
      parentIdentifier: "INF-670",
      createdChildIdentifiers: ["INF-696-EX-1", "INF-696-EX-2", "INF-696-EX-3"],
      openChildren: [
        child("INF-696-EX-1", "igor"),
        child("INF-696-EX-2", "sage"),
      ],
      dispatchStore,
    });

    expect(result.expectedCount).toBe(3);
    expect(result.resultCount).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.missingResultIdentifiers).toEqual(["INF-696-EX-3"]);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        identifier: "INF-696-EX-3",
        verified: false,
        status: "missing-child-result",
        delegateAgentId: null,
        dispatchId: null,
        sessionKey: null,
        ackStatus: null,
      }),
    );
    expect(result.allVerified).toBe(false);
  });
});

describe("INF-696 AC3.4: production fan-out completion path is wired to the verifier", () => {
  it("passes the liveness store from createApp through proxy into workflow-gate", () => {
    const indexTs = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    const proxyTs = fs.readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");

    expect(indexTs).toContain("postFanoutDispatchStore: livenessDispatchStore");
    expect(indexTs).toContain("livenessDispatchStore.recordDispatch({");
    expect(indexTs).toContain("livenessDispatchStore.recordAck(livenessRecord.dispatchId");
    expect(proxyTs).toContain("postFanoutDispatchStore?: DispatchRecordStore");
    expect(proxyTs).toContain("postFanoutDispatchStore: deps?.postFanoutDispatchStore");
  });

  it("runs steward fan-out delegate verification before recording a clean awaiting outcome", () => {
    const workflowGateTs = fs.readFileSync(path.join(process.cwd(), "src/workflow-gate.ts"), "utf8");
    const verifierCall = workflowGateTs.indexOf("verifyStewardFanoutDelegates({");
    const refusedOutcome = workflowGateTs.indexOf('outcome: "failed" as const', verifierCall);
    const deriveOutcome = workflowGateTs.indexOf("deriveFanoutBarrierOutcome(fanoutResult)", verifierCall);
    const recordOutcome = workflowGateTs.indexOf("recordFanoutOutcome(issueId", verifierCall);

    expect(verifierCall).toBeGreaterThanOrEqual(0);
    expect(refusedOutcome).toBeGreaterThan(verifierCall);
    expect(deriveOutcome).toBeGreaterThan(refusedOutcome);
    expect(recordOutcome).toBeGreaterThan(deriveOutcome);
  });
});
