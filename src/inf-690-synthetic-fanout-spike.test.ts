/**
 * INF-690 — Spike: minimum synthetic fixture-workflow shape for the engine-tier
 * harness.
 *
 * GOAL (time-boxed, throwaway proof): stand up a purely synthetic
 * workflow/role/agent inside the connector test harness and prove the engine
 * can host a *fan-out* — a parent spawning N children — without depending on
 * ANY production sprint, workflow, or agent name (no `sprint`, `dev-impl`,
 * `sprint-arm-*`, `igor`, `astrid`, ...).
 *
 * WHY THIS IS THE OPEN QUESTION: `executeFanout` is already fully config-driven
 * (its only structural requirement is `child_workflow` matching /^wf:.+/). But
 * every *existing* fan-out test in the suite (`fanout.test.ts`,
 * `inf-359-dev-sprint-*`, `ai-2524-dev-sprint-*`, `inf-528-*`) drives it against
 * the canonical PRODUCTION fixtures (`wf:dev-impl`, ux-audit, sprint). The
 * INF-520 synthetic parent fixture *declares* a `fanout:` block but nothing
 * drives `executeFanout` against a synthetic def end-to-end. This spike closes
 * that gap: it is the executable proof that S1 (harness reframe) can build on.
 *
 * The FORBIDDEN_PRODUCTION_TERMS guard below fails the spike loudly if any
 * production name leaks into the fixture shape — that is the "clean synthetic
 * hosting" property the parent ticket needs proven.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { executeFanout, type FanoutConfig, type Finding } from "./fanout.js";

// The whole point: the fan-out must be hostable with names that appear nowhere
// in production config. If any of these ever match the fixture material, the
// spike has NOT proven synthetic hosting.
const FORBIDDEN_PRODUCTION_TERMS = [
  /\bsprint\b/i,
  /\bdev-impl\b/i,
  /\bsprint-arm\b/i,
  /\bux-audit\b/i,
  /\bigor\b/i,
  /\bastrid\b/i,
  /\bsigne\b/i,
  /\blaren\b/i,
];

// ── The MINIMUM synthetic fixture-workflow shape a fan-out needs ────────────
//
// This is the deliverable: the smallest set of synthetic primitives that lets
// the engine host a fan-out. Everything here is invented; none of it references
// production config.
const SYNTHETIC = {
  // 1. A child workflow label. MUST be a `wf:*` label (engine hard-refuses
  //    anything else up front). This is the ONLY structural constraint the
  //    engine places on the fan-out config.
  childWorkflowLabel: "wf:synthetic-child",
  // 2. A spec-source section name. Arbitrary — the engine parses a Markdown
  //    section titled exactly this from the parent description.
  specSource: "synthetic entries",
  // 3. The parent's team label set the engine resolves child labels against.
  //    A `wf:<child>` label + a `state:<entry>` label suffice.
  teamLabels: [
    { id: "syn-wf-child", name: "wf:synthetic-child" },
    { id: "syn-state-queued", name: "state:queued" },
  ],
} as const;

const SYNTHETIC_CONFIG: FanoutConfig = {
  spec_source: SYNTHETIC.specSource,
  child_workflow: SYNTHETIC.childWorkflowLabel,
};

// A parent description carrying a synthetic spec section with three entries.
// Titles are deliberately generic so `applyDevSprintArmInference` cannot infer
// a production arm workflow (no "scope arm" / "spike arm" / "impl arm" prefixes).
const SYNTHETIC_PARENT_DESCRIPTION = [
  "# Synthetic parent",
  "",
  "## synthetic entries",
  "- **widget alpha**: first synthetic unit of work",
  "- **widget beta**: second synthetic unit of work",
  "- **widget gamma**: third synthetic unit of work",
  "",
].join("\n");

interface FetchCall {
  body: { query?: string; variables?: Record<string, unknown> };
}

/**
 * Self-contained Linear-API fetch mock for a purely synthetic parent. Mirrors
 * the query-dispatch shape of `fanout.test.ts`'s `makeFanoutFetch`, but every
 * value is synthetic.
 */
function makeSyntheticFanoutFetch(calls: FetchCall[]): typeof globalThis.fetch {
  let createdCount = 0;
  const parentInternalId = "synthetic-parent-internal-uuid";
  return (async (url: unknown, init: unknown) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const bodyText = typeof (init as { body?: unknown })?.body === "string"
      ? (init as { body: string }).body
      : "{}";
    const parsed = JSON.parse(bodyText) as FetchCall["body"];
    calls.push({ body: parsed });
    const query = parsed.query ?? "";

    if (query.includes("IssueTeamParent")) {
      return jsonResponse({
        issue: {
          id: parentInternalId,
          title: "Synthetic parent",
          description: SYNTHETIC_PARENT_DESCRIPTION,
          team: { id: "team-synthetic" },
          parent: null,
        },
      });
    }
    if (query.includes("issue(id: $id) { id }") && !query.includes("team") && !query.includes("labels")) {
      return jsonResponse({ issue: { id: parentInternalId } });
    }
    if (query.includes("TeamLabels")) {
      return jsonResponse({ team: { labels: { nodes: SYNTHETIC.teamLabels } } });
    }
    if (query.includes("issueLabelCreate")) {
      const name = String((parsed.variables ?? {}).name ?? "");
      return jsonResponse({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("issueCreate")) {
      createdCount += 1;
      return jsonResponse({
        issueCreate: {
          success: true,
          issue: { id: `synthetic-child-uuid-${createdCount}`, identifier: `SYN-${600 + createdCount}` },
        },
      });
    }
    if (query.includes("commentCreate")) {
      return jsonResponse({ commentCreate: { success: true, comment: { id: "synthetic-comment-uuid" } } });
    }
    if (query.includes("issueUpdate")) {
      return jsonResponse({ issueUpdate: { success: true } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 120)}`);
  }) as typeof globalThis.fetch;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("INF-690 spike: engine hosts a synthetic fan-out with zero production names", () => {
  let savedFetch: typeof globalThis.fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = makeSyntheticFanoutFetch(calls);
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("the synthetic fixture shape contains no production workflow/agent names", () => {
    const material = JSON.stringify({ SYNTHETIC, SYNTHETIC_CONFIG, SYNTHETIC_PARENT_DESCRIPTION });
    for (const forbidden of FORBIDDEN_PRODUCTION_TERMS) {
      expect(material).not.toMatch(forbidden);
    }
  });

  it("spawns one synthetic child per spec entry, each carrying the synthetic child-workflow label", async () => {
    const result = await executeFanout("SYN-690", "Bearer synthetic-token", SYNTHETIC_CONFIG, {
      skipPreview: true,
    });

    // The engine hosted the fan-out end-to-end from synthetic defs alone.
    expect(result.refused).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.created).toBe(3);
    expect(result.childIdentifiers).toEqual(["SYN-601", "SYN-602", "SYN-603"]);

    // Each child was minted with the SYNTHETIC child-workflow label and parented
    // to the synthetic parent — no production label leaked in.
    const createCalls = calls.filter((c) => (c.body.query ?? "").includes("issueCreate"));
    expect(createCalls).toHaveLength(3);
    for (const call of createCalls) {
      const input = (call.body.variables as Record<string, unknown>).input as Record<string, unknown>;
      expect(input.labelIds).toContain("syn-wf-child");
      expect(input.parentId).toBe("synthetic-parent-internal-uuid");
    }
  });

  it("proves the fan-out is genuinely spec-driven: entry count changes child count", async () => {
    const overrideFindings: Finding[] = [
      { title: "solo synthetic unit" },
    ];
    const result = await executeFanout("SYN-690", "Bearer synthetic-token", SYNTHETIC_CONFIG, {
      skipPreview: true,
      findingsOverride: overrideFindings,
    });

    expect(result.refused).toBe(false);
    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toEqual(["SYN-601"]);
  });
});
