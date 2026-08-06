/**
 * INF-1286 — Unit tests for the first-action watchdog's core sweep logic:
 * trigger conditions (arm/breach), the escalation ladder (rung 1/2/3), and
 * negative cases where no action is taken.
 *
 * Complements first-action-watchdog-staleness.test.ts (AI-2009 follow-up),
 * which covers once-only-unreachable, on-breach cross-check, and mirror-store
 * revival semantics. This file covers the base trigger/escalation contract
 * those tests assume but don't themselves exercise end-to-end, plus the
 * exported pure helpers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  runFirstActionWatchdogSweep,
  resolveRerouteTarget,
  computePerStateDwellAggregates,
  redispatchViaWatchdog,
  type WatchdogTicket,
  type FirstActionWatchdogOptions,
  type WatchdogCapabilityPolicy,
} from "./first-action-watchdog.js";
import { resetFirstActionWatchdogStateForTest, getFirstActionLadder } from "./first-action-watchdog-state.js";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
import { StallReasonCode } from "./wake-observability/index.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const WORKFLOW_DEF_YAML = `
id: dev-impl
name: Dev Implementation
initial: write-tests
states:
  - id: write-tests
    owner_role: test-author
    first_action_deadline: 30m
  - id: intake
    owner_role: steward
`;

let tmpDir: string;
let workflowDefPath: string;

function ticket(overrides: Partial<WatchdogTicket> = {}): WatchdogTicket {
  return {
    ticket: "INF-1286-T",
    workflow: "dev-impl",
    state: "write-tests",
    delegate: "tdd",
    humanAssigned: false,
    labels: ["wf:dev-impl", "state:write-tests"],
    dispatchDeliveredAtMs: T0,
    dispatchUpdatedAt: new Date(T0).toISOString(),
    firstOwnerActionAtMs: null,
    ...overrides,
  };
}

function makeOpts(
  tickets: WatchdogTicket[],
  overrides: Partial<FirstActionWatchdogOptions> = {},
) {
  const redispatch = jest.fn(async (_d: unknown) => ({ admitted: true }));
  const escalateUnreachable = jest.fn(async (_d: unknown) => undefined);
  const reroute = jest.fn(async (_d: unknown) => undefined);
  const notify = jest.fn((_a: unknown) => undefined);
  const transition = jest.fn(async (_p: unknown) => undefined);
  const opts: FirstActionWatchdogOptions = {
    workflowDefPath,
    listTickets: async () => tickets,
    now: () => T0 + 45 * MINUTE, // past the 30m deadline
    defaultDeadlineMs: 30 * MINUTE,
    maxRungs: 3,
    notify,
    redispatch,
    escalateUnreachable,
    reroute,
    transition,
    ...overrides,
  };
  return { opts, spies: { redispatch, escalateUnreachable, notify, reroute, transition } };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-core-"));
  workflowDefPath = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(workflowDefPath, WORKFLOW_DEF_YAML, "utf8");
  resetFirstActionWatchdogStateForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Negative cases — no action when conditions aren't met
// ════════════════════════════════════════════════════════════════════════════

describe("negative cases — no escalation", () => {
  it("never arms or acts on a human-assigned ticket", async () => {
    const { opts, spies } = makeOpts([ticket({ humanAssigned: true })]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.armed).toBe(0);
    expect(result.humanExcluded).toBe(1);
    expect(result.breached).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(getFirstActionLadder("INF-1286-T")).toBeNull();
  });

  it("never arms or acts on a needs-human labeled ticket, even without humanAssigned", async () => {
    const { opts, spies } = makeOpts([
      ticket({ humanAssigned: false, labels: ["wf:dev-impl", "state:write-tests", "needs-human"] }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.armed).toBe(0);
    expect(result.humanExcluded).toBe(1);
    expect(spies.redispatch).not.toHaveBeenCalled();
  });

  it("arms but does not breach or escalate before the deadline", async () => {
    const { opts, spies } = makeOpts([ticket()], { now: () => T0 + 5 * MINUTE });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.armed).toBe(1);
    expect(result.breached).toBe(0);
    expect(result.redispatched).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("does not breach when the owner acted before the deadline", async () => {
    const { opts, spies } = makeOpts([
      ticket({ firstOwnerActionAtMs: T0 + 10 * MINUTE }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
  });

  it("never sets result.transitions — the ladder does not auto-transition workflow state", async () => {
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.transitions).toBe(0);
    expect(spies.transition).not.toHaveBeenCalled();
  });

  it("skips escalation entirely when the stall resolver reports ACTIVELY_PROCESSING", async () => {
    const { opts, spies } = makeOpts([
      ticket({ stallReason: { reason: StallReasonCode.ACTIVELY_PROCESSING } }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(1); // deadline technically breached...
    expect(result.redispatched).toBe(0); // ...but no rung fires
    expect(result.unreachable).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("listTickets failure is captured as a non-fatal error, not thrown", async () => {
    const { opts } = makeOpts([]);
    opts.listTickets = async () => {
      throw new Error("linear unreachable");
    };
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.errors).toHaveLength(1);
    expect(result.scanned).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Trigger conditions — arm + breach
// ════════════════════════════════════════════════════════════════════════════

describe("trigger conditions", () => {
  it("arms every non-excluded ticket scanned", async () => {
    const { opts } = makeOpts([
      ticket({ ticket: "A" }),
      ticket({ ticket: "B", humanAssigned: true }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.scanned).toBe(2);
    expect(result.armed).toBe(1);
    expect(result.humanExcluded).toBe(1);
  });

  it("uses the per-state deadline from the workflow def, not the default, when present", async () => {
    // write-tests has a 30m deadline in the fixture def; default is 90m here.
    const { opts, spies } = makeOpts([ticket()], {
      defaultDeadlineMs: 90 * MINUTE,
      now: () => T0 + 35 * MINUTE, // past the def's 30m, well within the 90m default
    });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(1);
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Escalation ladder — rung 1 (redispatch) → rung 2 (unreachable) → rung 3 (reroute)
// ════════════════════════════════════════════════════════════════════════════

describe("escalation ladder", () => {
  it("rung 1: breach with no prior rungs fires an automatic redispatch", async () => {
    const { opts, spies } = makeOpts([ticket()]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.breached).toBe(1);
    expect(result.redispatched).toBe(1);
    expect(result.unreachable).toBe(0);
    expect(spies.redispatch).toHaveBeenCalledWith({
      ticket: "INF-1286-T",
      state: "write-tests",
      agent: "tdd",
    });
    const ladder = getFirstActionLadder("INF-1286-T")!;
    expect(ladder.rungsFired).toBe(1);
    expect(ladder.unreachable).toBe(false);
  });

  it("rung 2: ladder exhaustion (priorRungs >= maxRungs) marks unreachable and alerts", async () => {
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.unreachable).toBe(1);
    expect(result.redispatched).toBe(0);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.escalateUnreachable).toHaveBeenCalledTimes(1);
    const alert = spies.notify.mock.calls[0][0] as { ticket: string; delegate: string; severity: string };
    expect(alert.ticket).toBe("INF-1286-T");
    expect(alert.delegate).toBe("tdd");
    expect(alert.severity).toBe("critical");
  });

  it("rung 3: on exhaustion, reroutes to a fallback body when the owner_role has an alternate", async () => {
    const capabilityPolicy: WatchdogCapabilityPolicy = {
      bodies: [
        { id: "tdd", fills_roles: ["test-author"] },
        { id: "tdd-backup", fills_roles: ["test-author"] },
      ],
      roles: [{ id: "test-author", exclusive: false }],
    };
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })], { capabilityPolicy });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.reroutes).toBe(1);
    expect(spies.reroute).toHaveBeenCalledWith({
      ticket: "INF-1286-T",
      fromAgent: "tdd",
      toAgent: "tdd-backup",
      role: "test-author",
    });
  });

  it("rung 3 does NOT fire for an exclusive/singleton role even with a candidate body", async () => {
    const capabilityPolicy: WatchdogCapabilityPolicy = {
      bodies: [
        { id: "tdd", fills_roles: ["test-author"] },
        { id: "tdd-backup", fills_roles: ["test-author"] },
      ],
      roles: [{ id: "test-author", exclusive: true }],
    };
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })], { capabilityPolicy });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.reroutes).toBe(0);
    expect(spies.reroute).not.toHaveBeenCalled();
  });

  it("rung count increments across successive breaches until exhaustion", async () => {
    let current = ticket();
    const { opts: opts1, spies: spies1 } = makeOpts([current]);
    await runFirstActionWatchdogSweep(opts1);
    expect(getFirstActionLadder("INF-1286-T")!.rungsFired).toBe(1);

    const { opts: opts2 } = makeOpts([current], { now: () => T0 + 50 * MINUTE });
    await runFirstActionWatchdogSweep(opts2);
    expect(getFirstActionLadder("INF-1286-T")!.rungsFired).toBe(2);
    expect(spies1.redispatch).toHaveBeenCalledTimes(1); // opts1's spy only saw rung 1
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Reason-code-aware escalation (INF-84) — stall reason overrides normal rung 1
// ════════════════════════════════════════════════════════════════════════════

describe("reason-code-aware escalation", () => {
  it("WAKE_TURN_FAILED skips redispatch and goes straight to a diagnostic unreachable", async () => {
    const { opts, spies } = makeOpts([
      ticket({
        stallReason: {
          reason: StallReasonCode.WAKE_TURN_FAILED,
          diagnostic: { failureClass: "context-overflow", resolvedModel: "sonnet", fallbackSkipped: false },
        } as never,
      }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.unreachable).toBe(1);
    const alert = spies.notify.mock.calls[0][0] as { title: string };
    expect(alert.title).toMatch(/wake failed|context-overflow/i);
    const ladder = getFirstActionLadder("INF-1286-T")!;
    expect(ladder.rungsFired).toBe(3); // ladder exhausted immediately
  });

  it("SESSION_DEAD skips redispatch and goes straight to unreachable", async () => {
    const { opts, spies } = makeOpts([
      ticket({ stallReason: { reason: StallReasonCode.SESSION_DEAD } }),
    ]);
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.unreachable).toBe(1);
    const alert = spies.notify.mock.calls[0][0] as { title: string };
    expect(alert.title).toMatch(/SESSION_DEAD/);
  });

  it("MODEL_DEGRADED reroutes directly, skipping redispatch, when an alternate body exists", async () => {
    const capabilityPolicy: WatchdogCapabilityPolicy = {
      bodies: [
        { id: "tdd", fills_roles: ["test-author"] },
        { id: "tdd-backup", fills_roles: ["test-author"] },
      ],
      roles: [{ id: "test-author", exclusive: false }],
    };
    const { opts, spies } = makeOpts([
      ticket({ stallReason: { reason: StallReasonCode.MODEL_DEGRADED } }),
    ], { capabilityPolicy });
    const result = await runFirstActionWatchdogSweep(opts);

    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(result.reroutes).toBe(1);
    expect(spies.reroute).toHaveBeenCalledWith(
      expect.objectContaining({ fromAgent: "tdd", toAgent: "tdd-backup" }),
    );
  });

  it("MODEL_DEGRADED falls back to normal redispatch when no alternate body exists", async () => {
    const { opts, spies } = makeOpts([
      ticket({ stallReason: { reason: StallReasonCode.MODEL_DEGRADED } }),
    ]); // no capabilityPolicy ⇒ resolveModelDegradedRole returns null
    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.redispatched).toBe(1);
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
    expect(spies.reroute).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Exported pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe("resolveRerouteTarget", () => {
  it("returns null when the role is exclusive/singleton", () => {
    const policy: WatchdogCapabilityPolicy = {
      bodies: [{ id: "a", fills_roles: ["r"] }, { id: "b", fills_roles: ["r"] }],
      roles: [{ id: "r", exclusive: true }],
    };
    expect(resolveRerouteTarget(policy, "r", "a")).toBeNull();
  });

  it("returns null when there is no alternate body for the role", () => {
    const policy: WatchdogCapabilityPolicy = {
      bodies: [{ id: "a", fills_roles: ["r"] }],
    };
    expect(resolveRerouteTarget(policy, "r", "a")).toBeNull();
  });

  it("returns an alternate body id when one exists and is not the current delegate", () => {
    const policy: WatchdogCapabilityPolicy = {
      bodies: [{ id: "a", fills_roles: ["r"] }, { id: "b", fills_roles: ["r"] }],
    };
    expect(resolveRerouteTarget(policy, "r", "a")).toBe("b");
  });

  it("returns null when policy is undefined", () => {
    expect(resolveRerouteTarget(undefined, "r", "a")).toBeNull();
  });
});

describe("computePerStateDwellAggregates", () => {
  it("aggregates dwell and idle time per state, measuring open rows to now", () => {
    const nowMs = T0 + 100 * MINUTE;
    const rows = [
      { state: "write-tests", enteredAtMs: T0, firstOwnerActionAtMs: T0 + 10 * MINUTE, exitedAtMs: T0 + 20 * MINUTE },
      { state: "write-tests", enteredAtMs: T0, firstOwnerActionAtMs: null, exitedAtMs: null },
    ];
    const [agg] = computePerStateDwellAggregates(rows, nowMs);

    expect(agg.state).toBe("write-tests");
    expect(agg.count).toBe(2);
    // row 1: dwell 20m, idle 10m. row 2: dwell 100m (open, to now), idle 100m (no action).
    expect(agg.totalDwellMs).toBe(20 * MINUTE + 100 * MINUTE);
    expect(agg.totalIdleMs).toBe(10 * MINUTE + 100 * MINUTE);
    expect(agg.maxDwellMs).toBe(100 * MINUTE);
  });

  it("returns an empty array for no rows", () => {
    expect(computePerStateDwellAggregates([], T0)).toEqual([]);
  });
});

describe("redispatchViaWatchdog", () => {
  let store: DispatchIdempotencyStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(tmpDir, "idempotency.db");
    store = new DispatchIdempotencyStore(dbPath);
  });

  it("admits a fresh wake even when an ordinary duplicate would be suppressed", () => {
    const dispatch = {
      ticketKey: "INF-1286-T",
      workflowState: "write-tests",
      agent: "tdd",
      updatedAt: new Date(T0).toISOString(),
    };
    // First checkAndRecord admits normally.
    store.checkAndRecord(dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt);
    // An ordinary duplicate with the SAME tuple would now be suppressed.
    const ordinaryDup = store.checkAndRecord(
      dispatch.ticketKey, dispatch.workflowState, dispatch.agent, dispatch.updatedAt,
    );
    expect(ordinaryDup.suppressed).toBe(true);

    // The watchdog's genuine re-dispatch bypasses that suppression.
    const result = redispatchViaWatchdog(store, dispatch);
    expect(result.admitted).toBe(true);
    expect(result.suppressed).toBe(false);
  });
});
