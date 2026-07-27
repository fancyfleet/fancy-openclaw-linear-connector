/**
 * INF-900: dev-sprint arm barrier must not count escaped arms as satisfied.
 *
 * Ticket intent:
 * - An escaped sprint-arm child does not satisfy the arm barrier/dedup slot.
 * - Re-running the arm fanout must create a replacement child for that same arm.
 * - The replacement LIF child must be minted with LIF-owned workflow/state labels,
 *   never inherited INF-team or xfn workflow labels.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import {
  dedupeSpawnSpec,
  executeFanout,
  extractSpecFindings,
  type ExistingChild,
  type FanoutConfig,
} from "./fanout.js";

type GraphQLCall = {
  query: string;
  variables: Record<string, unknown>;
};

const LIF_TEAM_ID = "team-lif";
const INF_TEAM_ID = "team-inf";

const UX_ARM_SPEC = [
  "## Structured",
  "- **[wf:sprint-arm-ux] UX arm -- replacement for escaped UX shaping**: Define the LIF resident gallery recovery UX.",
].join("\n");

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function uxFinding() {
  const findings = extractSpecFindings(UX_ARM_SPEC, "structured");
  expect(findings).toHaveLength(1);
  expect(findings[0].child_workflow).toBe("wf:sprint-arm-ux");
  expect(findings[0].id).toBeDefined();
  return findings[0];
}

function escapedUxChildForSameArm(): ExistingChild {
  const finding = uxFinding();
  return {
    identifier: "LIF-326",
    title: finding.title,
    specEntryId: finding.id!,
    childWorkflow: "wf:sprint-arm-ux",
    state: "escape",
  };
}

function makeLinearFetch(): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in INF-900 test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    calls.push(parsed);
    const query = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (query.includes("IssueTeamParent")) {
      return json({
        data: {
          issue: {
            id: "lif-327-internal",
            identifier: "LIF-327",
            title: "LifeOS sprint arm replacement",
            description: UX_ARM_SPEC,
            team: { id: LIF_TEAM_ID, key: "LIF" },
            parent: null,
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return json({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "lbl-lif-wf-sprint-arm-ux", name: "wf:sprint-arm-ux", team: { id: LIF_TEAM_ID } },
                { id: "lbl-lif-state-doing", name: "state:doing", team: { id: LIF_TEAM_ID } },
                { id: "lbl-inf-wf-sprint-arm-ux", name: "wf:sprint-arm-ux", team: { id: INF_TEAM_ID } },
                { id: "lbl-inf-state-doing", name: "state:doing", team: { id: INF_TEAM_ID } },
                { id: "lbl-inf-xfn-workflow", name: "xfn:workflow", team: { id: INF_TEAM_ID } },
              ],
            },
          },
        },
      });
    }

    if (query.includes("issueCreate")) {
      const input = vars.input as { labelIds?: string[] };
      const labelIds = input.labelIds ?? [];
      if (labelIds.some((id) => id.startsWith("lbl-inf-"))) {
        return json({
          errors: [{ message: "labelIds contains a label that does not belong to the LIF team" }],
          data: { issueCreate: null },
        });
      }
      return json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "lif-900-child-internal", identifier: "LIF-900" },
          },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    throw new Error(`unexpected GraphQL in INF-900 test: ${query.slice(0, 100)}`);
  };

  return { fetch: fetchMock, calls };
}

describe("INF-900 escaped sprint-arm child replacement", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("INF-900: dedupe does not count escaped sprint-arm child as satisfying the arm slot", () => {
    const finding = uxFinding();

    const result = dedupeSpawnSpec(
      [finding],
      [escapedUxChildForSameArm()],
      "wf:sprint-arm-scope",
    );

    expect(result.toSpawn.map((f) => f.id)).toContain(finding.id);
  });

  it("INF-900: re-running LIF-327 arm fanout creates a LIF-safe replacement for the escaped UX arm", async () => {
    const { fetch, calls } = makeLinearFetch();
    globalThis.fetch = fetch;
    const finding = uxFinding();

    const result = await executeFanout(
      "LIF-327",
      "Bearer test-token",
      {
        spec_source: "structured",
        child_workflow: "wf:sprint-arm-scope",
        initial_delegate: "astrid",
      } as FanoutConfig,
      {
        skipPreview: true,
        findingsOverride: [finding],
        existingChildren: [escapedUxChildForSameArm()],
        lookupEntryState: async () => "state:doing",
      },
    );

    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toEqual(["LIF-900"]);

    const create = calls.find((call) => call.query.includes("issueCreate"));
    expect(create).toBeDefined();
    const input = create!.variables.input as Record<string, unknown>;
    expect(input.teamId).toBe(LIF_TEAM_ID);
    expect(input.parentId).toBe("lif-327-internal");
    expect(input.labelIds).toEqual(
      expect.arrayContaining(["lbl-lif-wf-sprint-arm-ux", "lbl-lif-state-doing"]),
    );
    expect(input.labelIds).not.toEqual(
      expect.arrayContaining(["lbl-inf-wf-sprint-arm-ux", "lbl-inf-state-doing", "lbl-inf-xfn-workflow"]),
    );
  });
});
