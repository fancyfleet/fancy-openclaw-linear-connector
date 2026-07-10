/**
 * First-action watchdog — stale-mirror hardening (AI-2009 follow-up).
 *
 * Root cause (diagnosed 2026-07-09, Matrix session with Matt): the watchdog's
 * data plane is the enrolled-tickets mirror, and mirror rows for tickets that
 * reached Done OUTSIDE a governed proxy verb (human closed in Linear UI,
 * deleted ticket, wf: label removed) stay non-terminal forever. The watchdog
 * then armed ladders on those phantom rows, exhausted them, and re-fired the
 * "delegate X unreachable" alert every sweep — e.g. AI-1870: delegate astrid
 * "unreachable after 8 rung(s)" on a ticket she actioned within one minute,
 * three days after it was Done.
 *
 * Contract hardened here:
 *   1. Once-only rung 2 — an exhausted ladder alerts exactly once per
 *      dispatch; later sweeps are silent (no notify, no history growth).
 *   2. On-breach cross-check — opts.crossCheck(t) returning "stale" drops the
 *      ladder without firing any rung and counts result.staleCleared;
 *      "unknown" fails open to normal ladder behavior.
 *   3. Alert copy carries rungsFired (real rungs, ≤ maxRungs) — not
 *      history.length, which also logs the exhaustion entry.
 *   4. Fresh dispatch (different delivery time) re-arms a clean ladder even
 *      when the prior ladder was exhausted/unreachable.
 *
 * Store contract (enrolled-tickets mirror):
 *   5. enroll() on an existing LIVE row is a noop (no resurrection side
 *      effects); on a TERMINAL row it performs a full revival (state,
 *      delegate, entered_state_at all brought forward) — never a blind
 *      terminal=0 un-flag that leaves stale state behind.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  runFirstActionWatchdogSweep,
  type WatchdogTicket,
  type FirstActionWatchdogOptions,
} from "./first-action-watchdog.js";
import {
  getFirstActionWatchdogState,
  resetFirstActionWatchdogStateForTest,
} from "./first-action-watchdog-state.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const WORKFLOW_DEF_YAML = `
id: dev-impl
name: Dev Implementation
initial: write-tests
states:
  - id: write-tests
    owner_role: test-author
    first_action_deadline: 45m
  - id: intake
    owner_role: steward
`;

let tmpDir: string;
let workflowDefPath: string;

function ticket(overrides: Partial<WatchdogTicket> = {}): WatchdogTicket {
  return {
    ticket: "AI-1870",
    workflow: "dev-impl",
    state: "intake",
    delegate: "astrid",
    humanAssigned: false,
    labels: ["wf:dev-impl", "state:intake"],
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
  const notify = jest.fn((_a: unknown) => undefined);
  const opts: FirstActionWatchdogOptions = {
    workflowDefPath,
    listTickets: async () => tickets,
    now: () => T0 + 60 * MINUTE,
    defaultDeadlineMs: 30 * MINUTE,
    maxRungs: 3,
    notify,
    redispatch,
    escalateUnreachable,
    ...overrides,
  };
  return { opts, spies: { redispatch, escalateUnreachable, notify } };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-staleness-"));
  workflowDefPath = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(workflowDefPath, WORKFLOW_DEF_YAML, "utf8");
  resetFirstActionWatchdogStateForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Once-only rung 2 — no alert spam from an exhausted ladder
// ════════════════════════════════════════════════════════════════════════════

describe("once-only unreachable", () => {
  it("alerts exactly once; subsequent sweeps are silent with no history growth", async () => {
    const t = ticket({ rungsFired: 3 }); // ladder already exhausted
    const { opts, spies } = makeOpts([t]);

    const first = await runFirstActionWatchdogSweep(opts);
    expect(first.unreachable).toBe(1);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    const historyAfterFirst = getFirstActionWatchdogState().ladders.find(
      (l) => l.ticket === "AI-1870",
    )!.history.length;

    // Data plane no longer reports rungsFired (persisted ladder is the source).
    const later = ticket();
    const { opts: opts2, spies: spies2 } = makeOpts([later], {
      now: () => T0 + 90 * MINUTE,
    });
    const second = await runFirstActionWatchdogSweep(opts2);
    const third = await runFirstActionWatchdogSweep(opts2);

    expect(second.unreachable).toBe(0);
    expect(third.unreachable).toBe(0);
    expect(spies2.notify).not.toHaveBeenCalled();
    expect(spies2.escalateUnreachable).not.toHaveBeenCalled();
    const ladder = getFirstActionWatchdogState().ladders.find(
      (l) => l.ticket === "AI-1870",
    )!;
    expect(ladder.unreachable).toBe(true);
    expect(ladder.history.length).toBe(historyAfterFirst); // no per-sweep growth
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. On-breach cross-check — stale mirror rows heal-and-drop, never alert
// ════════════════════════════════════════════════════════════════════════════

describe("on-breach cross-check", () => {
  it("'stale' drops the ladder, fires no rung, no alert, counts staleCleared", async () => {
    const crossCheck = jest.fn(async () => "stale" as const);
    const { opts, spies } = makeOpts([ticket()], { crossCheck });

    const result = await runFirstActionWatchdogSweep(opts);

    expect(crossCheck).toHaveBeenCalledTimes(1);
    expect(result.staleCleared).toBe(1);
    expect(result.redispatched).toBe(0);
    expect(result.unreachable).toBe(0);
    expect(spies.redispatch).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
    expect(
      getFirstActionWatchdogState().ladders.find((l) => l.ticket === "AI-1870"),
    ).toBeUndefined();
  });

  it("'stale' silences an ALREADY-exhausted ladder (the AI-1870 spam shape)", async () => {
    const { opts } = makeOpts([ticket({ rungsFired: 3 })]);
    await runFirstActionWatchdogSweep(opts); // exhaust: unreachable + 1 alert

    const crossCheck = jest.fn(async () => "stale" as const);
    const { opts: opts2, spies } = makeOpts([ticket({ rungsFired: 3 })], {
      crossCheck,
      now: () => T0 + 90 * MINUTE,
    });
    const result = await runFirstActionWatchdogSweep(opts2);

    expect(result.staleCleared).toBe(1);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(
      getFirstActionWatchdogState().ladders.find((l) => l.ticket === "AI-1870"),
    ).toBeUndefined();
  });

  it("'unknown' fails open — the ladder climbs exactly as without a cross-check", async () => {
    const crossCheck = jest.fn(async () => "unknown" as const);
    const { opts, spies } = makeOpts([ticket()], { crossCheck });

    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.staleCleared).toBe(0);
    expect(result.redispatched).toBe(1); // rung 1 fired normally
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
  });

  it("a crossCheck that THROWS fails open (treated as 'unknown')", async () => {
    const crossCheck = jest.fn(async () => {
      throw new Error("linear down");
    });
    const { opts, spies } = makeOpts([ticket()], { crossCheck: crossCheck as never });

    const result = await runFirstActionWatchdogSweep(opts);

    expect(result.errors).toHaveLength(0);
    expect(result.redispatched).toBe(1);
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
  });

  it("is NOT invoked for unbreached tickets — Linear reads stay proportional to stalls", async () => {
    const crossCheck = jest.fn(async () => "live" as const);
    const { opts } = makeOpts([ticket()], {
      crossCheck,
      now: () => T0 + 10 * MINUTE, // within deadline
    });

    await runFirstActionWatchdogSweep(opts);

    expect(crossCheck).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Alert copy — rungsFired, not history.length
// ════════════════════════════════════════════════════════════════════════════

describe("unreachable alert payload", () => {
  it("carries rungsFired = real rungs (≤ maxRungs), independent of history length", async () => {
    const { opts, spies } = makeOpts([ticket({ rungsFired: 3 })]);
    await runFirstActionWatchdogSweep(opts);

    expect(spies.notify).toHaveBeenCalledTimes(1);
    const alert = spies.notify.mock.calls[0][0] as { rungsFired: number };
    expect(alert.rungsFired).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Fresh dispatch re-arms a clean ladder
// ════════════════════════════════════════════════════════════════════════════

describe("fresh dispatch reset", () => {
  it("a new delivery time resets rungs/unreachable from a prior exhausted ladder", async () => {
    const { opts } = makeOpts([ticket({ rungsFired: 3 })]);
    await runFirstActionWatchdogSweep(opts); // exhausted + unreachable

    const t2Delivered = T0 + 120 * MINUTE; // genuine re-dispatch, new delivery
    const fresh = ticket({
      dispatchDeliveredAtMs: t2Delivered,
      dispatchUpdatedAt: new Date(t2Delivered).toISOString(),
    });
    const { opts: opts2, spies } = makeOpts([fresh], {
      now: () => t2Delivered + 60 * MINUTE, // past the fresh deadline
    });
    const result = await runFirstActionWatchdogSweep(opts2);

    // Fresh ladder: rung 1 redispatch — NOT swallowed by the old unreachable.
    expect(result.redispatched).toBe(1);
    expect(result.unreachable).toBe(0);
    expect(spies.redispatch).toHaveBeenCalledTimes(1);
    const ladder = getFirstActionWatchdogState().ladders.find(
      (l) => l.ticket === "AI-1870",
    )!;
    expect(ladder.unreachable).toBe(false);
    expect(ladder.rungsFired).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Mirror store — enroll() revival semantics
// ════════════════════════════════════════════════════════════════════════════

describe("enrolled-tickets mirror enroll()", () => {
  let store: EnrolledTicketsStore;

  beforeEach(() => {
    store = new EnrolledTicketsStore(path.join(tmpDir, "enrolled.db"));
  });

  afterEach(() => {
    store.close();
  });

  it("re-enroll of a LIVE row is a pure noop — state and timestamps untouched", () => {
    store.enroll({ ticketId: "AI-1", workflow: "dev-impl", state: "intake", delegate: "astrid" });
    const before = store.getByTicketId("AI-1")!;

    store.enroll({ ticketId: "AI-1", workflow: "dev-impl", state: "doing", delegate: "igor" });
    const after = store.getByTicketId("AI-1")!;

    expect(after.state).toBe("intake");
    expect(after.delegate).toBe("astrid");
    expect(after.entered_state_at).toBe(before.entered_state_at);
    expect(after.terminal).toBe(0);
  });

  it("re-enroll of a TERMINAL row is a FULL revival — no stale-state resurrection", () => {
    store.enroll({ ticketId: "AI-2", workflow: "dev-impl", state: "intake", delegate: "astrid" });
    const original = store.getByTicketId("AI-2")!;
    store.markTerminal("AI-2", "completed");

    store.enroll({ ticketId: "AI-2", workflow: "dev-sprint", state: "scope", delegate: "igor" });
    const revived = store.getByTicketId("AI-2")!;

    expect(revived.terminal).toBe(0);
    expect(revived.workflow).toBe("dev-sprint");
    expect(revived.state).toBe("scope"); // NOT the stale pre-terminal "intake"
    expect(revived.delegate).toBe("igor");
    expect(revived.last_event_kind).toBe("revived");
    expect(revived.entered_state_at).not.toBe(original.entered_state_at);
  });

  it("terminal rows stay terminal when nobody re-enrolls them", () => {
    store.enroll({ ticketId: "AI-3", workflow: "dev-impl", state: "intake", delegate: "astrid" });
    store.markTerminal("AI-3", "completed");
    expect(store.getByTicketId("AI-3")!.terminal).toBe(1);
  });
});
