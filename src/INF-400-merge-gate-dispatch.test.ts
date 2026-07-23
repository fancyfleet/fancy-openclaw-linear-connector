/**
 * INF-400 — Merge-gate outcome comments do not dispatch the next role.
 *
 * Root cause: when Hanzo's merge gate posts an outcome comment ("Merge gate
 * held" / passed / failed) on a PR-stage ticket, the connector routes the
 * comment back to the ticket's delegate (Hanzo, the comment author) where the
 * comment-fed suppression drops it. A comment never changes state/delegate, and
 * only a state/delegate change drives next-role dispatch — so the gate outcome
 * strands the ticket until a manual stall sweep re-wakes it (INF-358, INF-342
 * both sat ~7h).
 *
 * AC1 — the merge-gate outcome (pass / held / fail:reason) posted as a ticket
 *       comment is parsed into a STRUCTURED signal, not consumed as free text.
 * AC2 — on a gate outcome the dispatcher automatically wakes the correct role:
 *         held      → code-review role (Charles)
 *         fail      → implementer (prior-implementer, e.g. Igor)
 *         pass      → advance toward merge/deploy per the workflow def
 *       A non-gate comment must NOT trigger a spurious dispatch.
 *
 * @jest-environment node
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  parseMergeGateOutcome,
  mergeGateDispatchTarget,
  maybeDispatchMergeGateOutcome,
  type MergeGateDispatchDeps,
} from "./merge-gate-dispatch.js";
import type { LinearCommentCreatedEvent } from "./webhook/schema.js";

// ── The real gate comment Hanzo posted on INF-358 (verbatim, 2026-07-22) ──────
const HELD_COMMENT = `Merge gate held.

I opened PR https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/437 from \`feature/INF-358-task-routing-assign-reroute\` to \`main\`.

Automated gate result: PASS via \`check-gate.sh fancyfleet/fancy-openclaw-linear-connector 437\` — base is \`main\`, no new CI failures, and the \`Build & Test\` failure is present on \`main\` as a baseline failure.

Manual gate result: BLOCKED — no Charles code-review sign-off is present in Linear or on the PR.`;

const PASS_COMMENT = `Merge gate passed.

I opened PR https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/438 to \`main\`.

Automated gate result: PASS via \`check-gate.sh fancyfleet/fancy-openclaw-linear-connector 438\`.
Manual gate result: PASS — Charles approved on the PR.`;

const FAIL_COMMENT = `Merge gate failed: CI red on \`Build & Test\` (not a baseline failure).

Automated gate result: FAIL via \`check-gate.sh fancyfleet/fancy-openclaw-linear-connector 439\` — new CI failures introduced by this branch.`;

// A genuine, unrelated comment (Ai's verification note on INF-342) — must not parse.
const NON_GATE_COMMENT = `Fix verified. Implementation correctly replaces static startup token capture with per-tick lazy resolution using the resolveAiLinearAuthToken helper, preventing cron auth death from token-refresh revocation. Regression tests passed.`;

function commentEvent(body: string, actorName = "Hanzo (Repo Manager)"): LinearCommentCreatedEvent {
  return {
    type: "Comment",
    action: "create",
    actor: { id: "hanzo-user-id", name: actorName },
    createdAt: "2026-07-22T22:49:21.214Z",
    data: {
      id: "comment-uuid",
      body,
      issueId: "issue-uuid-358",
      issueIdentifier: "INF-358",
      issueTitle: "Connector defect",
      url: "https://linear.app/fancymatt/issue/INF-358#comment-uuid",
      createdAt: "2026-07-22T22:49:21.214Z",
      updatedAt: "2026-07-22T22:49:21.214Z",
    },
    raw: {},
  };
}

// ── AC1: structured parse ─────────────────────────────────────────────────────
describe("INF-400 AC1 — parseMergeGateOutcome (structured signal)", () => {
  it("parses a held gate comment, capturing PR number/url", () => {
    const sig = parseMergeGateOutcome(HELD_COMMENT);
    expect(sig).not.toBeNull();
    expect(sig!.outcome).toBe("held");
    expect(sig!.prNumber).toBe("437");
    expect(sig!.prUrl).toContain("/pull/437");
  });

  it("parses a passed gate comment", () => {
    const sig = parseMergeGateOutcome(PASS_COMMENT);
    expect(sig?.outcome).toBe("pass");
    expect(sig?.prNumber).toBe("438");
  });

  it("parses a failed gate comment and captures the reason", () => {
    const sig = parseMergeGateOutcome(FAIL_COMMENT);
    expect(sig?.outcome).toBe("fail");
    expect(sig?.reason?.toLowerCase()).toContain("ci red");
  });

  it("returns null for a non-gate comment (no spurious signal)", () => {
    expect(parseMergeGateOutcome(NON_GATE_COMMENT)).toBeNull();
  });

  it("does not match prose that merely mentions the phrase mid-sentence", () => {
    expect(
      parseMergeGateOutcome("Last week the merge gate held us up for hours, worth noting."),
    ).toBeNull();
  });
});

// ── AC2: outcome → role mapping ───────────────────────────────────────────────
describe("INF-400 AC2 — mergeGateDispatchTarget (role mapping)", () => {
  it("held → wake the code-review role", () => {
    expect(mergeGateDispatchTarget({ outcome: "held" })).toEqual({ kind: "wake-role", role: "code-review" });
  });
  it("fail → wake the implementer", () => {
    expect(mergeGateDispatchTarget({ outcome: "fail" })).toEqual({ kind: "wake-implementer" });
  });
  it("pass → advance per the workflow def", () => {
    expect(mergeGateDispatchTarget({ outcome: "pass" })).toEqual({ kind: "advance" });
  });
});

// ── AC2: end-to-end dispatch decision (injected deps, hermetic) ───────────────
describe("INF-400 AC2 — maybeDispatchMergeGateOutcome wakes the correct role", () => {
  function makeDeps(overrides: Partial<MergeGateDispatchDeps> = {}): {
    deps: MergeGateDispatchDeps;
    deliver: jest.Mock;
  } {
    const deliver = jest.fn(async () => ({ delivered: true }));
    const deps: MergeGateDispatchDeps = {
      resolveBodiesForRole: async (role: string) =>
        role === "code-review" ? ["charles"] : role === "dev" ? ["igor"] : [],
      getImplementer: async () => "igor",
      deliverWake: deliver as unknown as MergeGateDispatchDeps["deliverWake"],
      ...overrides,
    };
    return { deps, deliver };
  }

  it("held → wakes code-review body (Charles)", async () => {
    const { deps, deliver } = makeDeps();
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(HELD_COMMENT),
      { issueUuid: "issue-uuid-358", issueIdentifier: "INF-358", currentDelegateAgent: "hanzo" },
      deps,
    );
    expect(res?.handled).toBe(true);
    expect(res?.outcome).toBe("held");
    expect(res?.targetAgent).toBe("charles");
    expect(res?.delivered).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const arg = deliver.mock.calls[0][0] as { agentId: string };
    expect(arg.agentId).toBe("charles");
  });

  it("fail → wakes the prior implementer (Igor)", async () => {
    const { deps, deliver } = makeDeps();
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(FAIL_COMMENT),
      { issueUuid: "issue-uuid-439", issueIdentifier: "INF-439", currentDelegateAgent: "hanzo" },
      deps,
    );
    expect(res?.outcome).toBe("fail");
    expect(res?.targetAgent).toBe("igor");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("fail → falls back to the singleton dev role when no prior implementer recorded", async () => {
    const { deps, deliver } = makeDeps({ getImplementer: async () => null });
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(FAIL_COMMENT),
      { issueUuid: "x", issueIdentifier: "INF-439", currentDelegateAgent: "hanzo" },
      deps,
    );
    expect(res?.targetAgent).toBe("igor");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("pass → advances by waking the current delegate (merge/deploy owner)", async () => {
    const { deps, deliver } = makeDeps();
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(PASS_COMMENT),
      { issueUuid: "issue-uuid-438", issueIdentifier: "INF-438", currentDelegateAgent: "hanzo" },
      deps,
    );
    expect(res?.outcome).toBe("pass");
    expect(res?.targetRole).toBe("advance");
    expect(res?.targetAgent).toBe("hanzo");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("non-gate comment → returns null and dispatches nothing", async () => {
    const { deps, deliver } = makeDeps();
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(NON_GATE_COMMENT),
      { issueUuid: "x", issueIdentifier: "INF-342", currentDelegateAgent: "ai" },
      deps,
    );
    expect(res).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("gate phrasing from a non-gate author is ignored when an author guard is supplied", async () => {
    const { deps, deliver } = makeDeps({ isMergeGateAuthor: () => false });
    const res = await maybeDispatchMergeGateOutcome(
      commentEvent(HELD_COMMENT, "Some Human"),
      { issueUuid: "issue-uuid-358", issueIdentifier: "INF-358", currentDelegateAgent: "hanzo" },
      deps,
    );
    expect(res).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("non-Comment events are ignored", async () => {
    const { deps, deliver } = makeDeps();
    const res = await maybeDispatchMergeGateOutcome(
      { type: "Issue", action: "update", actor: { id: "x", name: "y" }, createdAt: "", data: {} as never, raw: {} } as never,
      { issueUuid: "x", issueIdentifier: "INF-1", currentDelegateAgent: null },
      deps,
    );
    expect(res).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });
});
