/**
 * INF-469: duplicate-title guard for wf:dev-sprint children.
 *
 * INF-439 and INF-468 both minted as "🔒 Connector 2026-07-23 Sprint" — identical
 * title, indistinguishable on Matt's active-sprint dashboard. The sprint title is
 * steward-authored free text (extractSpecFindings takes the `## sprint` bullet
 * verbatim), so the engine must refuse malformed or duplicate sprint titles on
 * the minting path.
 *
 * AC: a `wf:dev-sprint` fan-out refuses (created=0, no issueCreate call, an error
 * recorded) unless the extracted title includes a leading icon, `Cycle <N>`, and a
 * theme. It also refuses duplicate titles and reused sprint icons under the same
 * parent.
 */

import { it, expect, describe, beforeEach, afterEach } from "@jest/globals";
import { executeFanout } from "./fanout.js";
import type { FanoutConfig } from "./workflow-gate.js";

const WF_SPRINT: FanoutConfig = { spec_source: "sprint", child_workflow: "wf:dev-sprint" };

/** Build a `## sprint` spec body carrying exactly one bullet (max_findings: 1 in prod). */
function sprintSpecFrom(title: string): string {
  return `## sprint\n- **${title}**: theme and scope for this cycle`;
}

describe("INF-469 — duplicate sprint-title guard", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeFetch(
    parentDescription: string,
    existing: Array<{ identifier: string; title: string; childWorkflow: string }>,
  ): typeof globalThis.fetch {
    let createdCount = 0;
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      fetchCalls.push({ url, body: parsed });
      const query = parsed.query ?? "";

      if (query.includes("IssueTeamParent")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "parent-internal-uuid",
                title: "Sprint Spawner Parent",
                description: parentDescription,
                team: { id: "team-uuid" },
                parent: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("FanoutChildren")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                children: {
                  nodes: existing.map((c, i) => ({
                    identifier: c.identifier,
                    title: c.title,
                    description: [
                      "Parent: INF-196",
                      `<!-- ai-1994:spec-entry-id: prior-cycle-${i} -->`,
                      `<!-- inf-32:child-workflow: ${c.childWorkflow} -->`,
                    ].join("\n"),
                    state: { name: "Done" },
                    labels: { nodes: [{ name: c.childWorkflow }, { name: "state:done" }] },
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("TeamLabels")) {
        return new Response(
          JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: "lbl-wf-dev-sprint", name: "wf:dev-sprint" },
                    { id: "lbl-state-todo", name: "state:todo" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("issueLabelCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return new Response(
          JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("issueCreate")) {
        createdCount++;
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: `child-uuid-${createdCount}`, identifier: `INF-${500 + createdCount}` },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (query.includes("commentCreate")) {
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-uuid" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  it("refuses to mint a wf:dev-sprint child whose title duplicates an existing sibling (INF-439/INF-468 pattern)", async () => {
    const title = "🚀 Connector Cycle 7 — Deployment & Runtime Integrity";
    globalThis.fetch = makeFetch(sprintSpecFrom(title), [
      { identifier: "INF-439", title, childWorkflow: "wf:dev-sprint" },
    ]);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(0);
    expect(result.errors.some((e) => e.message.includes("duplicates existing sibling INF-439"))).toBe(true);
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("matches the collision case-insensitively and ignoring surrounding whitespace", async () => {
    globalThis.fetch = makeFetch(sprintSpecFrom("  🚀 CONNECTOR CYCLE 7 — deployment & runtime integrity  "), [
      { identifier: "INF-439", title: "🚀 Connector Cycle 7 — Deployment & Runtime Integrity", childWorkflow: "wf:dev-sprint" },
    ]);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(0);
  });

  it("refuses a fresh sprint title without cycle number and theme", async () => {
    globalThis.fetch = makeFetch(sprintSpecFrom("🔒 Connector 2026-07-23 Sprint"), []);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(0);
    expect(result.errors.some((e) => e.message.includes("must include a unique leading icon"))).toBe(true);
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("refuses a valid-shaped sprint title that reuses a prior sprint icon", async () => {
    globalThis.fetch = makeFetch(sprintSpecFrom("🔒 Connector Cycle 7 — Deployment & Runtime Integrity"), [
      { identifier: "INF-439", title: "🔒 Connector Cycle 6 — Cron Liveness", childWorkflow: "wf:dev-sprint" },
    ]);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(0);
    expect(result.errors.some((e) => e.message.includes("reuses icon"))).toBe(true);
  });

  it("mints normally when the title is unique (cycle-differentiated)", async () => {
    globalThis.fetch = makeFetch(sprintSpecFrom("🚀 Connector Cycle 7 — Deployment & Runtime Integrity"), [
      { identifier: "INF-439", title: "🔒 Connector 2026-07-23 Sprint", childWorkflow: "wf:dev-sprint" },
    ]);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(1);
    const createCalls = fetchCalls.filter((c) => String(c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(1);
  });

  it("does NOT refuse a title collision against a sibling minted by a DIFFERENT child_workflow", async () => {
    const title = "🚀 Connector Cycle 7 — Deployment & Runtime Integrity";
    globalThis.fetch = makeFetch(sprintSpecFrom(title), [
      { identifier: "INF-999", title, childWorkflow: "wf:sprint-scoping" },
    ]);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(1);
  });

  it("mints normally against a fresh parent when the title has icon, cycle number, and theme", async () => {
    globalThis.fetch = makeFetch(sprintSpecFrom("🚀 Connector Cycle 7 — Deployment & Runtime Integrity"), []);

    const result = await executeFanout("INF-196", "Bearer tok", WF_SPRINT, { skipPreview: true } as never);

    expect(result.created).toBe(1);
  });
});
