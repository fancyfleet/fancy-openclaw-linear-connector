import { describe, it, expect, beforeEach } from "@jest/globals";
import { resetEngineWatchDedupForTest } from "./engine-watch/engine-watch.js";
import { triggerEngineWatchForTest, resetEngineWatchCronForTest } from "./cron/engine-watch-cron.js";
import { resetEngineWatchStateForTest } from "./engine-watch-state.js";

describe("INF-1302 AC4: cross-tick duplicate prevention (two ticks, one ticket)", () => {
  beforeEach(() => {
    process.env.LINEAR_SERVICE_CREDENTIAL = "tok-test";
    resetEngineWatchDedupForTest();
    resetEngineWatchCronForTest();
    resetEngineWatchStateForTest();
  });

  it("terminal owner + identical evidence across two ticks creates exactly one ticket (no spam)", async () => {
    const sig = {
      id: "sig-repro-1",
      class: "migrate-state-client-error",
      evidence: "[Proxy] migrate-state failed: old client still prints success=true but server rejected transition; delegate repair needed (INF-1277 after INF-1288)",
      source: "operational-event" as const,
      observedAt: "2026-08-07T04:04:00Z",
    };
    let createCount = 0;
    const createTicket = async () => {
      createCount += 1;
      return { id: `new-${createCount}`, identifier: `INF-NEW-${createCount}`, state: "To Do", stateType: "unstarted" as const };
    };
    const resolveOwner = async () => ({
      closestOwner: { id: "issue-1288", identifier: "INF-1288", state: "Done", stateType: "completed" as const },
      activeFollowup: null,
    });

    const r1 = await triggerEngineWatchForTest({ collectSignals: () => [sig], resolveOwner, createTicket });
    expect(r1.dispositionsList[0].kind).toBe("recurrence-with-followup");
    expect(createCount).toBe(1);

    const r2 = await triggerEngineWatchForTest({ collectSignals: () => [{ ...sig, id: "sig-repro-2" }], resolveOwner, createTicket });
    expect(r2.dispositionsList[0].kind).toBe("recurrence-with-followup");
    // The AC4 invariant: second tick must not create — summary still references the first follow-up
    expect(createCount).toBe(1);
    // And both ticks reference the same follow-up identifier
    const f1 = r1.dispositionsList[0] as { followupTicket: { identifier: string } };
    const f2 = r2.dispositionsList[0] as { followupTicket: { identifier: string } };
    expect(f1.followupTicket.identifier).toBe(f2.followupTicket.identifier);
    expect(r2.summary).toContain(f1.followupTicket.identifier);
  });

  it("no-owner + identical evidence across two ticks creates exactly one ticket", async () => {
    const sig = {
      id: "sig-noowner-1",
      class: "unknown-connector-class",
      evidence: "novel connector error no prior owner — same evidence twice",
      source: "operational-event" as const,
      observedAt: "2026-08-07T04:04:00Z",
    };
    let createCount = 0;
    const createTicket = async () => {
      createCount += 1;
      return { id: `new-${createCount}`, identifier: `INF-NEW-${createCount}`, state: "To Do", stateType: "unstarted" as const };
    };
    const resolveOwner = async () => ({ closestOwner: null, activeFollowup: null });

    const r1 = await triggerEngineWatchForTest({ collectSignals: () => [sig], resolveOwner, createTicket });
    expect(r1.dispositionsList[0].kind).toBe("new-fix-ticket");
    expect(createCount).toBe(1);

    const r2 = await triggerEngineWatchForTest({ collectSignals: () => [{ ...sig, id: "sig-noowner-2" }], resolveOwner, createTicket });
    expect(r2.dispositionsList[0].kind).toBe("new-fix-ticket");
    expect(createCount).toBe(1);
    const c1 = r1.dispositionsList[0] as { createdTicket: { identifier: string } };
    const c2 = r2.dispositionsList[0] as { createdTicket: { identifier: string } };
    expect(c1.createdTicket.identifier).toBe(c2.createdTicket.identifier);
  });
});
