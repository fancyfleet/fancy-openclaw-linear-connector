/**
 * INF-604 — reconciliation-wake scheduler must not fire on trashed/archived
 * governed tickets.
 *
 * A ticket deleted via proxy `issueDelete` is soft-deleted (trashed): the Linear
 * `issue(id:)` node query still resolves it THROUGH the archive with its
 * `wf:*` / `state:*` labels frozen at deletion time. The first-action watchdog's
 * on-breach cross-check keys on exactly that read. Before this fix it only
 * healed a HARD delete (`issue == null`); a trashed governed ticket (evidence:
 * LSO-8) therefore read as live and drew a rung-1 reconciliation wake at its
 * steward every breach, forever.
 *
 * Two layers of coverage:
 *   (1) the pure classifier `classifyCrossCheckIssue` recognises trashed/archived
 *       issues as stale — including the exact LSO-8 shape (frozen wf:/state:
 *       labels, non-terminal native state);
 *   (2) end-to-end: a breached trashed `wf:dev-sprint` ticket drives ZERO wakes
 *       through the sweep and is dropped from the persisted mirror (AC1–AC3).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  classifyCrossCheckIssue,
  fetchCrossCheckIssueWithFallback,
  type CrossCheckIssue,
} from "./first-action-crosscheck.js";
import {
  runFirstActionWatchdogSweep,
  type WatchdogTicket,
  type FirstActionWatchdogOptions,
  type CrossCheckVerdict,
} from "./first-action-watchdog.js";
import { resetFirstActionWatchdogStateForTest } from "./first-action-watchdog-state.js";
import { EnrolledTicketsStore } from "./store/enrolled-tickets-store.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

// ════════════════════════════════════════════════════════════════════════════
// 1. Pure classifier — trashed/archived detection (the INF-604 gap)
// ════════════════════════════════════════════════════════════════════════════

describe("classifyCrossCheckIssue — INF-604 trashed/archived detection", () => {
  // The exact LSO-8 shape: a trashed dev-sprint ticket whose wf:/state: labels
  // and native state are frozen at deletion — indistinguishable from live by
  // labels alone. This is the case that regressed and drew endless wakes.
  const lso8Trashed: CrossCheckIssue = {
    trashed: true,
    archivedAt: "2026-07-24T20:49:00.000Z",
    state: { type: "started" },
    labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:ac-definition" }] },
  };

  it("classifies a trashed governed ticket as stale/trashed (NOT live)", () => {
    expect(classifyCrossCheckIssue(lso8Trashed, "ac-definition")).toEqual({
      verdict: "stale",
      heal: "trashed",
    });
  });

  it("classifies archivedAt-set (no explicit trashed flag) as stale/trashed", () => {
    const archived: CrossCheckIssue = {
      archivedAt: "2026-07-24T20:49:00.000Z",
      state: { type: "started" },
      labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:ac-definition" }] },
    };
    expect(classifyCrossCheckIssue(archived, "ac-definition")).toEqual({
      verdict: "stale",
      heal: "trashed",
    });
  });

  it("trashed takes precedence over a would-be-live wf ticket", () => {
    // Same labels/state that would classify "live" if not trashed.
    const live: CrossCheckIssue = {
      state: { type: "started" },
      labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:ac-definition" }] },
    };
    expect(classifyCrossCheckIssue(live, "ac-definition")).toEqual({ verdict: "live" });
    // Flip only the trash flag → stale.
    expect(classifyCrossCheckIssue({ ...live, trashed: true }, "ac-definition")).toEqual({
      verdict: "stale",
      heal: "trashed",
    });
  });

  // ── Existing branches must be preserved exactly (no behaviour drift) ────────

  it("null issue → stale/deleted (hard delete, unchanged)", () => {
    expect(classifyCrossCheckIssue(null, "intake")).toEqual({ verdict: "stale", heal: "deleted" });
  });

  it("natively completed/canceled or state:done → stale/terminal", () => {
    expect(
      classifyCrossCheckIssue({ state: { type: "completed" }, labels: { nodes: [] } }, "x"),
    ).toEqual({ verdict: "stale", heal: "terminal" });
    expect(
      classifyCrossCheckIssue({ state: { type: "canceled" }, labels: { nodes: [] } }, "x"),
    ).toEqual({ verdict: "stale", heal: "terminal" });
    expect(
      classifyCrossCheckIssue(
        { state: { type: "started" }, labels: { nodes: [{ name: "state:done" }] } },
        "x",
      ),
    ).toEqual({ verdict: "stale", heal: "terminal" });
  });

  it("no wf:* label → stale/demoted", () => {
    expect(
      classifyCrossCheckIssue(
        { state: { type: "started" }, labels: { nodes: [{ name: "state:intake" }] } },
        "intake",
      ),
    ).toEqual({ verdict: "stale", heal: "demoted" });
  });

  it("state label drift → stale/state-drift carrying authoritative state", () => {
    expect(
      classifyCrossCheckIssue(
        {
          state: { type: "started" },
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:review" }] },
        },
        "intake",
      ),
    ).toEqual({ verdict: "stale", heal: "state-drift", toState: "review" });
  });

  it("a genuinely-live governed ticket matching its mirror state → live", () => {
    expect(
      classifyCrossCheckIssue(
        {
          state: { type: "started" },
          labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
        },
        "intake",
      ),
    ).toEqual({ verdict: "live" });
  });
});

describe("fetchCrossCheckIssueWithFallback — INF-604 archived auth fallback", () => {
  it("tries the steward/delegate token after a 401/missing-data response", async () => {
    const fetchFn = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        json: async () => ({ errors: [{ message: "Linear API returned 401" }] }),
        status: 401,
      } as Response)
      .mockResolvedValueOnce({
        json: async () => ({
          data: {
            issue: {
              trashed: true,
              archivedAt: "2026-07-24T20:49:00.000Z",
              state: { type: "started" },
              labels: {
                nodes: [{ name: "wf:dev-sprint" }, { name: "state:ac-definition" }],
              },
            },
          },
        }),
        status: 200,
      } as Response);

    const fetched = await fetchCrossCheckIssueWithFallback({
      fetchFn,
      linearApiUrl: "https://linear.example/graphql",
      ticket: "LSO-8",
      tokenCandidates: [
        { source: "ai", token: "ai-token" },
        { source: "steward:astrid", token: "astrid-token" },
      ],
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer ai-token",
    });
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer astrid-token",
    });
    expect(fetched).toMatchObject({ status: "ok", source: "steward:astrid" });
    if (fetched.status !== "ok") throw new Error("expected cross-check fetch to succeed");
    expect(classifyCrossCheckIssue(fetched.issue, "ac-definition")).toEqual({
      verdict: "stale",
      heal: "trashed",
    });
  });

  it("returns unknown after all token candidates fail instead of marking stale", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue({
      json: async () => ({ errors: [{ message: "Linear API returned 401" }] }),
      status: 401,
    } as Response);

    await expect(
      fetchCrossCheckIssueWithFallback({
        fetchFn,
        linearApiUrl: "https://linear.example/graphql",
        ticket: "OTHER-1",
        tokenCandidates: [{ source: "ai", token: "ai-token" }],
      }),
    ).resolves.toMatchObject({ status: "unknown" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. End-to-end — a trashed wf:dev-sprint ticket produces ZERO wakes (AC1–AC3)
// ════════════════════════════════════════════════════════════════════════════

describe("first-action watchdog — trashed governed ticket drives zero wakes", () => {
  let tmpDir: string;
  let workflowDefPath: string;
  let store: EnrolledTicketsStore;

  const WORKFLOW_DEF_YAML = `
id: dev-sprint
name: Dev Sprint
initial: ac-definition
states:
  - id: ac-definition
    owner_role: steward
    first_action_deadline: 30m
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-604-"));
    workflowDefPath = path.join(tmpDir, "dev-sprint.yaml");
    fs.writeFileSync(workflowDefPath, WORKFLOW_DEF_YAML, "utf8");
    store = new EnrolledTicketsStore(path.join(tmpDir, "enrolled.db"));
    resetFirstActionWatchdogStateForTest();
  });

  afterEach(() => {
    store.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("breached trashed ticket: 0 redispatches, healed to terminal, dropped from worklist", async () => {
    // Mirror row is enrolled and non-terminal — exactly the orphan LSO-8 left.
    store.enroll({
      ticketId: "LSO-8",
      workflow: "dev-sprint",
      state: "ac-definition",
      delegate: "astrid",
    });

    const trashedIssue: CrossCheckIssue = {
      trashed: true,
      archivedAt: "2026-07-24T20:49:00.000Z",
      state: { type: "started" },
      labels: { nodes: [{ name: "wf:dev-sprint" }, { name: "state:ac-definition" }] },
    };

    const redispatch = jest.fn(async (_d: unknown) => ({ admitted: true }));
    const notify = jest.fn((_a: unknown) => undefined);

    // Cross-check wired through the REAL classifier + REAL mirror — the same
    // decision path index.ts uses, minus the Linear fetch (trashedIssue stands
    // in for what `issue(id:)` returns for a soft-deleted ticket).
    const crossCheck = async (t: WatchdogTicket): Promise<CrossCheckVerdict> => {
      const action = classifyCrossCheckIssue(trashedIssue, t.state);
      if (action.verdict === "live") return "live";
      if (action.heal === "trashed") {
        store.markTerminal(t.ticket, "watchdog-crosscheck-trashed");
      }
      return "stale";
    };

    const ticket: WatchdogTicket = {
      ticket: "LSO-8",
      workflow: "dev-sprint",
      state: "ac-definition",
      delegate: "astrid",
      humanAssigned: false,
      labels: ["wf:dev-sprint", "state:ac-definition"],
      dispatchDeliveredAtMs: T0,
      dispatchUpdatedAt: new Date(T0).toISOString(),
      firstOwnerActionAtMs: null,
    };

    const opts: FirstActionWatchdogOptions = {
      workflowDefPath,
      listTickets: async () => [ticket],
      now: () => T0 + 60 * MINUTE, // well past the 30m deadline → breached
      defaultDeadlineMs: 30 * MINUTE,
      maxRungs: 3,
      redispatch,
      notify,
      crossCheck,
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // AC3: zero reconciliation wakes.
    expect(redispatch).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(result.breached).toBe(1);
    expect(result.staleCleared).toBe(1);

    // AC2: dropped from the persisted wake schedule (mirror row terminal).
    const row = store.getByTicketId("LSO-8");
    expect(row?.terminal).toBe(1);

    // AC1: excluded from the next sweep's worklist (terminal rows are filtered).
    const live = store.getAll().filter((r) => r.terminal !== 1 && r.state && r.state !== "done");
    expect(live.some((r) => r.ticket_id === "LSO-8")).toBe(false);
  });
});
