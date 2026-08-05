/**
 * INF-1239 — AC-capture warning comment storm regression tests.
 *
 * Root cause: `autoAcceptCommitmentOnActivity` re-runs accept-time AC capture
 * on every qualifying Comment/AgentSessionEvent from a known agent, with no
 * check for whether the activity is genuine work evidence or a connector-
 * authored notice. The AC-capture warning comment it posts on a blocked
 * accept is itself a Comment event authored by a known agent identity, so it
 * re-enters this same function — a self-sustaining loop. Live on INF-1204
 * this produced 250 duplicate comments in 3.5 minutes and hit Linear's
 * 2000-comment cap, bricking the ticket.
 *
 * Same defect class as AI-2044 (router.ts's "[Connector]" body-mention guard):
 * a connector-authored notice must never be treated as an activity signal
 * that triggers further connector-side reaction.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadAgents } from "../agents.js";
import { AC_CAPTURE_WARNING_PREFIX } from "../workflow-gate.js";
import { autoAcceptCommitmentOnActivity } from "./index.js";
import type { LinearEvent } from "./schema.js";

function commentEvent(actorId: string, data: Record<string, unknown>): LinearEvent {
  return {
    type: "Comment",
    action: "create",
    actor: { id: actorId, name: "astrid" },
    createdAt: "2026-08-05T12:00:00.000Z",
    data,
    raw: {},
  } as unknown as LinearEvent;
}

describe("INF-1239: autoAcceptCommitmentOnActivity self-notice guard", () => {
  let tmpDir: string;
  let origAgentsFile: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let fetchCallCount: number;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origAgentsFile = process.env.AGENTS_FILE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1239-storm-test-"));
    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "astrid",
            linearUserId: "astrid-linear-id",
            openclawAgent: "astrid",
            clientId: "c",
            clientSecret: "s",
            accessToken: "astrid-token",
            refreshToken: "r",
          },
        ],
      }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    fetchCallCount = 0;
    // Any Linear API call proves applyStateTransition (or its callees) were
    // reached — the guard under test must prevent that call entirely for a
    // self-authored notice. autoAcceptCommitmentOnActivity wraps the whole
    // attempt in try/catch, so throwing here is safe for the test.
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error("unexpected Linear API call in INF-1239 guard test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origAgentsFile !== undefined) process.env.AGENTS_FILE = origAgentsFile;
    else delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not attempt accept when the comment is the connector's own AC-capture warning", async () => {
    const ev = commentEvent("astrid-linear-id", {
      id: "c1",
      issueId: "issue-storm-1",
      body: `${AC_CAPTURE_WARNING_PREFIX} The AC of record was not captured at accept time.`,
    });

    await autoAcceptCommitmentOnActivity(ev);

    expect(fetchCallCount).toBe(0);
  });

  it("still attempts accept for a genuine agent-authored comment (non-regression)", async () => {
    const ev = commentEvent("astrid-linear-id", {
      id: "c2",
      issueId: "issue-storm-2",
      body: "Working on this now.",
    });

    await autoAcceptCommitmentOnActivity(ev);

    expect(fetchCallCount).toBeGreaterThan(0);
  });

  it("INF-1239 AC3: a loop of repeated self-notice re-entries never attempts accept", async () => {
    for (let i = 0; i < 10; i++) {
      const ev = commentEvent("astrid-linear-id", {
        id: `c-loop-${i}`,
        issueId: "issue-storm-3",
        body: `${AC_CAPTURE_WARNING_PREFIX} The AC of record was not captured at accept time.`,
      });
      await autoAcceptCommitmentOnActivity(ev);
    }

    expect(fetchCallCount).toBe(0);
  });
});
