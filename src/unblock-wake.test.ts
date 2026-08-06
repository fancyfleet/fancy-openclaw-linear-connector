/**
 * INF-794 / INF-1297 — Tests for the consolidated unblock-wake fanout.
 *
 * When a blocker reaches a terminal state, findUnblockWakeRoutesForTerminalIssue
 * fans out wake routes for the tickets it was blocking. INF-1297 added a guard:
 * a target that is STILL blocked by another open prerequisite must not be woken
 * (the terminal event cleared one blocker, but the target is not yet actionable).
 *
 * Dependencies (fetch, service credential, agent directory) are injected so the
 * fanout can be exercised directly without importing the heavy webhook module.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  findUnblockWakeRoutesForTerminalIssue,
  __resetUnblockWakeClaimsForTest,
} from "./unblock-wake.js";
import type { UnblockWakeDeps } from "./unblock-wake.js";
import type { LinearEvent } from "./webhook/schema.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function linearResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A terminal "Issue" event for blocker X-1. */
function terminalEvent(identifier = "X-1"): LinearEvent {
  return {
    type: "Issue",
    createdAt: "2026-08-06T20:00:00.000Z",
    data: {
      id: `id-${identifier}`,
      identifier,
      state: { name: "Done", type: "completed" },
      updatedAt: "2026-08-06T20:00:00.000Z",
    },
  } as unknown as LinearEvent;
}

interface BlockerRel {
  blockerId: string;
  blockerState: { name: string; type: string };
}

/**
 * Build the Linear response for the terminal ticket's `blocks` relations.
 * Each target gets a delegate and an inverseRelations graph describing what
 * currently blocks it (used by the remaining-blocker guard).
 */
function blockedTargetsResponse(
  blockerIdentifier: string,
  targets: Array<{
    identifier: string;
    delegateLinearId: string | null;
    blockedBy: BlockerRel[];
  }>,
): Response {
  return linearResponse({
    issue: {
      id: `id-${blockerIdentifier}`,
      identifier: blockerIdentifier,
      relations: {
        nodes: targets.map((t) => ({
          type: "blocks",
          issue: { id: `id-${blockerIdentifier}`, identifier: blockerIdentifier },
          relatedIssue: {
            id: `id-${t.identifier}`,
            identifier: t.identifier,
            title: `${t.identifier} title`,
            url: `https://linear.app/x/${t.identifier}`,
            priority: 1,
            priorityLabel: "High",
            createdAt: "2026-08-06T19:00:00.000Z",
            updatedAt: "2026-08-06T20:00:00.000Z",
            state: { id: "s1", name: "To Do", type: "unstarted" },
            team: { id: "team1", key: "INF" },
            labelIds: [],
            delegate: t.delegateLinearId ? { id: t.delegateLinearId, name: "Agent", app: true } : null,
            assignee: null,
            relations: { nodes: [] },
            inverseRelations: {
              nodes: t.blockedBy.map((b) => ({
                type: "blocks",
                issue: { id: `id-${b.blockerId}`, identifier: b.blockerId, state: b.blockerState },
                relatedIssue: { id: `id-${t.identifier}`, identifier: t.identifier, state: { name: "To Do", type: "unstarted" } },
              })),
            },
          },
        })),
      },
    },
  });
}

function makeDeps(fetchImpl: (typeof globalThis.fetch)): UnblockWakeDeps {
  return {
    fetchFn: fetchImpl,
    resolveToken: () => "test-token",
    agentMap: () => ({ "linear-agent-1": "grover" }),
    openclawName: (name) => name,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("findUnblockWakeRoutesForTerminalIssue — INF-1297 remaining-blocker guard", () => {
  let mockFetch: jest.MockedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
    __resetUnblockWakeClaimsForTest();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("wakes a target whose sole blocker went terminal", async () => {
    mockFetch.mockResolvedValueOnce(blockedTargetsResponse("X-1", [
      {
        identifier: "Y-1",
        delegateLinearId: "linear-agent-1",
        blockedBy: [
          // Only blocker is X-1, which is now Done (terminal) → not blocking.
          { blockerId: "X-1", blockerState: { name: "Done", type: "completed" } },
        ],
      },
    ]));

    const routes = await findUnblockWakeRoutesForTerminalIssue(terminalEvent("X-1"), makeDeps(mockFetch));
    expect(routes).toHaveLength(1);
    expect(routes[0].sessionKey).toContain("Y-1");
    expect(routes[0].agentId).toBe("grover");
    expect(routes[0].routingReason).toBe("delegate");
  });

  it("skips a target still blocked by another open prerequisite", async () => {
    mockFetch.mockResolvedValueOnce(blockedTargetsResponse("X-1", [
      {
        identifier: "Y-1",
        delegateLinearId: "linear-agent-1",
        blockedBy: [
          { blockerId: "X-1", blockerState: { name: "Done", type: "completed" } },
          // X-2 is still open → Y-1 remains blocked; must NOT be woken.
          { blockerId: "X-2", blockerState: { name: "Doing", type: "started" } },
        ],
      },
    ]));

    const routes = await findUnblockWakeRoutesForTerminalIssue(terminalEvent("X-1"), makeDeps(mockFetch));
    expect(routes).toHaveLength(0);
  });

  it("wakes only the newly-unblocked target when mixed", async () => {
    mockFetch.mockResolvedValueOnce(blockedTargetsResponse("X-1", [
      {
        identifier: "Y-1",
        delegateLinearId: "linear-agent-1",
        blockedBy: [
          { blockerId: "X-1", blockerState: { name: "Done", type: "completed" } },
        ],
      },
      {
        identifier: "Y-2",
        delegateLinearId: "linear-agent-1",
        blockedBy: [
          { blockerId: "X-1", blockerState: { name: "Done", type: "completed" } },
          { blockerId: "X-3", blockerState: { name: "To Do", type: "unstarted" } },
        ],
      },
    ]));

    const routes = await findUnblockWakeRoutesForTerminalIssue(terminalEvent("X-1"), makeDeps(mockFetch));
    expect(routes.map((r) => r.sessionKey)).toEqual([expect.stringContaining("Y-1")]);
  });

  it("returns no routes for a non-terminal event", async () => {
    const event = {
      type: "Issue",
      createdAt: "2026-08-06T20:00:00.000Z",
      data: { id: "id-X-1", identifier: "X-1", state: { name: "Doing", type: "started" } },
    } as unknown as LinearEvent;
    const routes = await findUnblockWakeRoutesForTerminalIssue(event, makeDeps(mockFetch));
    expect(routes).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
