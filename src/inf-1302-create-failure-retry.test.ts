/**
 * INF-1302 AC validation: createTicket failure must fail the tick loud and
 * leave the signal retryable — no synthetic INF-EW-* registration, no dedup
 * suppression, no success summary.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { resetEngineWatchDedupForTest, getDedupTicket } from "./engine-watch/engine-watch.js";
import { triggerEngineWatchForTest, resetEngineWatchCronForTest } from "./cron/engine-watch-cron.js";
import { getEngineWatchState, resetEngineWatchStateForTest } from "./engine-watch-state.js";

describe("INF-1302: createTicket failure is retryable, not silently swallowed", () => {
  beforeEach(() => {
    process.env.LINEAR_SERVICE_CREDENTIAL = "tok-test";
    resetEngineWatchDedupForTest();
    resetEngineWatchCronForTest();
    resetEngineWatchStateForTest();
  });

  it("create failure throws, records fail, does not register synthetic dedup, does not mark success", async () => {
    const sig = {
      id: "sig-fail-1",
      class: "migrate-state-client-error",
      evidence: "[Proxy] migrate-state failed — same class recurs after INF-1288",
      source: "operational-event" as const,
      observedAt: "2026-08-07T04:04:00Z",
    };
    let calls = 0;
    await expect(
      triggerEngineWatchForTest({
        collectSignals: () => [sig],
        resolveOwner: async () => ({
          closestOwner: { id: "t-1288", identifier: "INF-1288", state: "Done", stateType: "completed" as const },
          activeFollowup: null,
        }),
        createTicket: async () => {
          calls += 1;
          throw new Error("Linear 429 transient");
        },
      }),
    ).rejects.toThrow(/createTicket failed|Linear 429/);
    expect(calls).toBe(1);
    expect(getDedupTicket(sig)).toBeUndefined();
    const st = getEngineWatchState();
    expect(st.lastOutcomeType).toBe("fail");
    expect(st.lastError).toMatch(/createTicket failed|Linear 429/);
  });

  it("after a failed tick, a retry with a successful create creates one real ticket and a subsequent tick reuses it (no spam)", async () => {
    const sig = {
      id: "sig-retry-1",
      class: "migrate-state-client-error",
      evidence: "[Proxy] migrate-state failed — retry after transient create failure",
      source: "operational-event" as const,
      observedAt: "2026-08-07T04:04:00Z",
    };
    const resolveOwner = async () => ({
      closestOwner: { id: "t-1288", identifier: "INF-1288", state: "Done", stateType: "completed" as const },
      activeFollowup: null,
    });

    // Tick 1: create fails -> throw, no dedup
    await expect(
      triggerEngineWatchForTest({
        collectSignals: () => [sig],
        resolveOwner,
        createTicket: async () => { throw new Error("Linear 503 transient"); },
      }),
    ).rejects.toThrow();
    expect(getDedupTicket(sig)).toBeUndefined();
    const stFail = getEngineWatchState();
    expect(stFail.lastOutcomeType).toBe("fail");

    // Tick 2: same signal, create succeeds -> one real ticket, success
    let createCount = 0;
    const realTicket = { id: "real-1", identifier: "INF-3101", state: "To Do", stateType: "unstarted" as const };
    const r2 = await triggerEngineWatchForTest({
      collectSignals: () => [{ ...sig, id: "sig-retry-1b" }],
      resolveOwner,
      createTicket: async () => { createCount += 1; return realTicket; },
    });
    expect(createCount).toBe(1);
    expect(r2.dispositionsList[0].kind).toBe("recurrence-with-followup");
    expect(r2.summary).toContain("INF-3101");
    expect(r2.summary).not.toMatch(/INF-EW-/);
    const st2 = getEngineWatchState();
    expect(st2.lastOutcomeType).toBe("success");
    expect(getDedupTicket({ ...sig, id: "sig-retry-1b" })).toBeDefined();

    // Tick 3: identical evidence -> reuses same ticket, no second creation
    const r3 = await triggerEngineWatchForTest({
      collectSignals: () => [{ ...sig, id: "sig-retry-1c" }],
      resolveOwner,
      createTicket: async () => { createCount += 1; return { id: "real-2", identifier: "INF-3102", state: "To Do", stateType: "unstarted" as const }; },
    });
    expect(createCount).toBe(1);
    expect(r3.summary).toContain("INF-3101");
    const f2 = r3.dispositionsList[0] as { followupTicket: { identifier: string } };
    expect(f2.followupTicket.identifier).toBe("INF-3101");
  });

  it("no-owner create failure is also retryable (no INF-EW-* phantom)", async () => {
    const sig = {
      id: "sig-noowner-fail",
      class: "unknown-connector-class",
      evidence: "novel connector error no prior owner — create fails",
      source: "operational-event" as const,
      observedAt: "2026-08-07T04:04:00Z",
    };
    await expect(
      triggerEngineWatchForTest({
        collectSignals: () => [sig],
        resolveOwner: async () => ({ closestOwner: null, activeFollowup: null }),
        createTicket: async () => { throw new Error("Linear network failure"); },
      }),
    ).rejects.toThrow();
    expect(getDedupTicket(sig)).toBeUndefined();
    expect(getEngineWatchState().lastOutcomeType).toBe("fail");
  });
});
