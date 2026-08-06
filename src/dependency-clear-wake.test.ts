/**
 * INF-1297 — Tests for dependency-clear wake.
 *
 * Verifies that when a ticket reaches terminal state, tickets it was blocking
 * are correctly identified as newly unblocked (or still blocked by other
 * prerequisites).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { findNewlyUnblockedTickets } from "./dependency-clear-wake.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function linearResponse(data: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ data }),
  };
}

function makeBlocksRelation(blockerId: string, blockerState: { name: string; type: string }, blockedId: string, blockedState: { name: string; type: string }) {
  return {
    type: "blocks",
    issue: { id: blockerId, identifier: blockerId, state: blockerState },
    relatedIssue: { id: blockedId, identifier: blockedId, state: blockedState },
  };
}

describe("findNewlyUnblockedTickets", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns empty when terminal ticket blocks nothing", async () => {
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: { nodes: [] },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([]);
    expect(result.stillBlocked).toEqual([]);
    expect(result.errors).toBe(0);
  });

  it("identifies newly unblocked ticket when sole blocker goes terminal", async () => {
    // X-1 blocks Y-1. X-1 is now Done. Y-1 has no other blockers.
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: {
          nodes: [{
            type: "blocks",
            relatedIssue: {
              id: "y1",
              identifier: "Y-1",
              state: { name: "To Do", type: "unstarted" },
              delegate: { id: "agent1", name: "Agent One" },
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] },
              relations: { nodes: [] },
              inverseRelations: {
                nodes: [
                  // Y-1 is blocked by X-1 (now terminal)
                  makeBlocksRelation("X-1", { name: "Done", type: "completed" }, "Y-1", { name: "To Do", type: "unstarted" }),
                ],
              },
            },
          }],
        },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([{
      identifier: "Y-1",
      delegateId: "agent1",
      delegateName: "Agent One",
    }]);
    expect(result.stillBlocked).toEqual([]);
  });

  it("keeps ticket blocked when another blocker is still open", async () => {
    // X-1 blocks Y-1. X-1 is now Done. But Y-1 is also blocked by X-2 (still open).
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: {
          nodes: [{
            type: "blocks",
            relatedIssue: {
              id: "y1",
              identifier: "Y-1",
              state: { name: "To Do", type: "unstarted" },
              delegate: { id: "agent1", name: "Agent One" },
              labels: { nodes: [] },
              relations: { nodes: [] },
              inverseRelations: {
                nodes: [
                  makeBlocksRelation("X-1", { name: "Done", type: "completed" }, "Y-1", { name: "To Do", type: "unstarted" }),
                  makeBlocksRelation("X-2", { name: "Doing", type: "started" }, "Y-1", { name: "To Do", type: "unstarted" }),
                ],
              },
            },
          }],
        },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([]);
    expect(result.stillBlocked).toEqual(["Y-1"]);
  });

  it("skips already-terminal blocked tickets", async () => {
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: {
          nodes: [{
            type: "blocks",
            relatedIssue: {
              id: "y1",
              identifier: "Y-1",
              state: { name: "Done", type: "completed" },
              delegate: null,
              labels: { nodes: [] },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          }],
        },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([]);
  });

  it("reports no-delegate for unblocked tickets without a delegate", async () => {
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: {
          nodes: [{
            type: "blocks",
            relatedIssue: {
              id: "y1",
              identifier: "Y-1",
              state: { name: "To Do", type: "unstarted" },
              delegate: null,
              labels: { nodes: [] },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          }],
        },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([]);
    expect(result.noDelegate).toEqual(["Y-1"]);
  });

  it("handles API errors gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.errors).toBe(1);
    expect(result.unblocked).toEqual([]);
  });

  it("ignores non-blocks relations", async () => {
    mockFetch.mockResolvedValueOnce(linearResponse({
      issue: {
        relations: {
          nodes: [{
            type: "related",
            relatedIssue: {
              id: "y1",
              identifier: "Y-1",
              state: { name: "To Do", type: "unstarted" },
              delegate: { id: "agent1", name: "Agent One" },
              labels: { nodes: [] },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          }],
        },
      },
    }));

    const result = await findNewlyUnblockedTickets("X-1", "token");
    expect(result.unblocked).toEqual([]);
  });
});
