/**
 * INF-529: unit tests for the leaked-credential reopen sweep (Layer 2).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  LeakedCredentialSweep,
  REOPEN_MARKER,
  type LinearSweepApi,
  type SweepIssue,
} from "./leaked-credential-sweep.js";
import { getRegisteredCrons, resetCronRegistryForTest } from "./cron/registry.js";
import * as cronRegistry from "./cron/registry.js";
import { registerLeakedCredentialSweepCron } from "./cron/leaked-credential-sweep-cron.js";

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

type CronOutcomeEntry = {
  name: string;
  lastRunAt: string | null;
  lastOutcome: "success" | "fail" | null;
  lastError: string | null;
  failureStreak: number;
};

function getOutcomeEntryForTest(name: string): CronOutcomeEntry {
  // INF-1263 AC1/AC4/AC7 contract: credential-sweep failures must be visible
  // in the real cron registry as lastOutcome="fail", lastError=<message>, and
  // failureStreak>=1. A captured SweepCycleResult.errors count alone is not
  // observable at ac-validate.
  const entry = getRegisteredCrons().find((cron) => cron.name === name) as CronOutcomeEntry | undefined;
  expect(entry).toBeDefined();
  expect(entry).toEqual(expect.objectContaining({
    lastOutcome: expect.anything(),
    failureStreak: expect.any(Number),
  }));
  expect(entry).toHaveProperty("lastError");
  return entry!;
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

describe("INF-1263 leaked-credential sweep cron reliability", () => {
  beforeEach(() => {
    resetCronRegistryForTest();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    resetCronRegistryForTest();
    jest.restoreAllMocks();
  });

  test("AC3/AC5: start() queues a first run immediately instead of waiting for the interval", async () => {
    const api = new FakeApi([]);
    const firstRun = jest.fn();
    const s = sweep(api, { pollIntervalMs: 24 * 60 * 60 * 1000 });

    s.start(firstRun);

    expect(firstRun).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(firstRun).toHaveBeenCalledTimes(1);
    s.stop();
  });

  test("AC4/AC5: registrar startup kick marks leaked-credential-sweep as run after bootstrap", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);

    const s = registerLeakedCredentialSweepCron({
      enabled: true,
      linearToken: "test-linear-token",
      pollIntervalMs: 24 * 60 * 60 * 1000,
    });

    expect(s).not.toBeNull();
    const armed = getRegisteredCrons().find((cron) => cron.name === "leaked-credential-sweep");
    expect(armed).toBeDefined();
    expect(armed!.lastRunAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const ran = getRegisteredCrons().find((cron) => cron.name === "leaked-credential-sweep");
    expect(ran!.lastRunAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(ran!.lastRunAt as string))).toBe(false);
    s?.stop();
  });

  test("AC1/AC4/AC7: registrar records the fetch failure message in cron outcome state", async () => {
    const markFailure = (cronRegistry as unknown as {
      markCronRunFailure?: (name: string, error: unknown, now?: Date) => void;
    }).markCronRunFailure;
    expect(markFailure).toEqual(expect.any(Function));

    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("credential fetch exploded"));

    const s = registerLeakedCredentialSweepCron({
      enabled: true,
      linearToken: "test-linear-token",
      pollIntervalMs: 24 * 60 * 60 * 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getOutcomeEntryForTest("leaked-credential-sweep")).toEqual(expect.objectContaining({
      lastOutcome: "fail",
      lastError: expect.stringContaining("credential fetch exploded"),
      failureStreak: 1,
    }));
    s?.stop();
  });
});
