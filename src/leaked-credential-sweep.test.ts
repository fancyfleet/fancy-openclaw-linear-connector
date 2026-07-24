/**
 * INF-529: unit tests for the leaked-credential reopen sweep (Layer 2).
 */

import { describe, it, expect } from "@jest/globals";
import {
  LeakedCredentialSweep,
  REOPEN_MARKER,
  type LinearSweepApi,
  type SweepIssue,
} from "./leaked-credential-sweep.js";

class FakeApi implements LinearSweepApi {
  reopened: string[] = [];
  comments: Array<{ id: string; body: string }> = [];
  constructor(private tickets: SweepIssue[], private opts: { failFetch?: boolean; failReopen?: Set<string> } = {}) {}
  async fetchClosedLeakedCredentialTickets(): Promise<SweepIssue[]> {
    if (this.opts.failFetch) throw new Error("fetch boom");
    return this.tickets;
  }
  async reopenIssue(issueId: string): Promise<boolean> {
    if (this.opts.failReopen?.has(issueId)) return false;
    this.reopened.push(issueId);
    return true;
  }
  async postComment(issueId: string, body: string): Promise<boolean> {
    this.comments.push({ id: issueId, body });
    return true;
  }
}

function issue(id: string, comments: string[] = []): SweepIssue {
  return { id, identifier: id.toUpperCase(), comments };
}

const CONFIG = { lookbackDays: 14, pollIntervalMs: 3_600_000, maxReopensPerCycle: 10 };

function sweep(api: LinearSweepApi, cfgOverrides: Partial<typeof CONFIG> = {}) {
  return new LeakedCredentialSweep({ linear: api, config: { ...CONFIG, ...cfgOverrides } });
}

describe("LeakedCredentialSweep.runCycle", () => {
  it("reopens a closed labelled ticket with no rotation artifact", async () => {
    const api = new FakeApi([issue("inf-1", ["closing as dup"])]);
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(1);
    expect(api.reopened).toEqual(["inf-1"]);
    expect(api.comments[0].body).toContain(REOPEN_MARKER);
  });

  it("skips a ticket that already carries a rotation confirmation", async () => {
    const api = new FakeApi([issue("inf-2", ["ROTATION-CONFIRMED: rotated and revoked in console"])]);
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(0);
    expect(r.skippedConfirmed).toBe(1);
    expect(api.reopened).toEqual([]);
  });

  it("accepts the structured marker as confirmation", async () => {
    const api = new FakeApi([issue("inf-3", ['done <!-- rotation-confirmed: {"credential":"K","revoked":true} -->'])]);
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(0);
    expect(r.skippedConfirmed).toBe(1);
  });

  it("is idempotent — does not re-reopen a ticket it already reopened", async () => {
    const api = new FakeApi([issue("inf-4", [`prior sweep ${REOPEN_MARKER}`, "human re-closed"])]);
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(0);
    expect(r.skippedAlreadyReopened).toBe(1);
    expect(api.reopened).toEqual([]);
  });

  it("honors the per-cycle reopen cap", async () => {
    const api = new FakeApi([issue("a"), issue("b"), issue("c")]);
    const r = await sweep(api, { maxReopensPerCycle: 2 }).runCycle();
    expect(r.reopened).toBe(2);
    expect(r.cappedSkipped).toBe(1);
  });

  it("records an error when a reopen does not succeed, without throwing", async () => {
    const api = new FakeApi([issue("inf-5")], { failReopen: new Set(["inf-5"]) });
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("INF-5");
  });

  it("returns an error result (never throws) when the fetch fails", async () => {
    const api = new FakeApi([], { failFetch: true });
    const r = await sweep(api).runCycle();
    expect(r.scanned).toBe(0);
    expect(r.errors.length).toBe(1);
  });

  it("processes a mixed batch correctly", async () => {
    const api = new FakeApi([
      issue("keep", ["ROTATION-CONFIRMED: revoked"]),
      issue("reopen1", ["dup"]),
      issue("already", [REOPEN_MARKER]),
      issue("reopen2", []),
    ]);
    const r = await sweep(api).runCycle();
    expect(r.reopened).toBe(2);
    expect(r.skippedConfirmed).toBe(1);
    expect(r.skippedAlreadyReopened).toBe(1);
    expect(api.reopened.sort()).toEqual(["reopen1", "reopen2"]);
  });
});
