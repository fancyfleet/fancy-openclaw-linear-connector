/**
 * INF-1042 — Department-engine Engineering solicit fanout must not mint
 * Design-scoped wf:task children for Engineering-role recipients.
 *
 * AC map:
 *   - Engineering solicitations shaped like ENG-18..22 (RN, web, backend,
 *     test-bar, owned-resource) either mint on a non-Design Engineering entry
 *     path with a concrete delegate/native state, or refuse before issueCreate.
 *   - Engineering solicitations never become wf:task + null-delegate/Backlog
 *     xfn stubs that trip the requester-only task intake guard.
 *   - Existing non-code Design/media wf:task solicit behavior remains unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { executeFanout, type FanoutResult } from "./fanout.js";
import { reloadAgents } from "./agents.js";
import type { FanoutConfig } from "./workflow-gate.js";

type GraphqlCall = { query: string; variables: Record<string, any> };

const ENGINEERING_SOLICIT_FANOUT: FanoutConfig = {
  spec_source: "solicitations",
  child_workflow: "wf:task",
  barrier: "all-responded",
} as FanoutConfig;

const NON_CODE_DESIGN_SOLICIT_FANOUT: FanoutConfig = {
  spec_source: "solicitations",
  child_workflow: "wf:task",
  barrier: "all-responded",
} as FanoutConfig;

const ENGINEERING_SOLICITATIONS = [
  "## Solicitations",
  "- **RN Engineering solicitation — Noah**: Recipient: noah; role: react-native; ENG-18 shape. Confirm mobile impact and recovery notes.",
  "- **Web Engineering solicitation — Sage**: Recipient: sage; role: web; ENG-19 shape. Confirm frontend surface and recovery notes.",
  "- **Backend Engineering solicitation — Igor**: Recipient: igor; role: backend; ENG-20 shape. Confirm connector implementation path and recovery notes.",
  "- **Test-bar Engineering solicitation — tdd**: Recipient: tdd; role: test-author; ENG-21 shape. Confirm regression-test scope and recovery notes.",
  "- **Owned-resource Engineering solicitation — Igor**: Recipient: igor; role: owned-resource; ENG-22 shape. Confirm owned-infra artifact and recovery notes.",
].join("\n");

const DESIGN_MEDIA_SOLICITATIONS = [
  "## Solicitations",
  "- **Design visual direction request — Laren**: Ask Design for a non-code visual direction response.",
  "- **Media thumbnail request — Mika**: Ask Media for a non-code thumbnail response.",
].join("\n");

const AGENTS = [
  { name: "noah", linearUserId: "user-noah" },
  { name: "sage", linearUserId: "user-sage" },
  { name: "igor", linearUserId: "user-igor" },
  { name: "tdd", linearUserId: "user-tdd" },
  { name: "laren", linearUserId: "user-laren" },
  { name: "mika", linearUserId: "user-mika" },
];

const TEAM_LABELS = [
  { id: "label-wf-task", name: "wf:task" },
  { id: "label-wf-dev-impl", name: "wf:dev-impl" },
  { id: "label-wf-engineering-solicit", name: "wf:engineering-solicit" },
  { id: "label-wf-dept-engine-solicit", name: "wf:dept-engine-solicit" },
  { id: "label-state-intake", name: "state:intake" },
  { id: "label-state-todo", name: "state:todo" },
  { id: "label-state-doing", name: "state:doing" },
  { id: "label-state-write-tests", name: "state:write-tests" },
];

const NATIVE_STATE_BY_WORKFLOW: Record<string, string> = {
  "wf:task": "native-backlog",
  "wf:dev-impl": "native-todo",
  "wf:engineering-solicit": "native-todo",
  "wf:dept-engine-solicit": "native-todo",
};

function jsonResp(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(description: string, calls: GraphqlCall[]): typeof globalThis.fetch {
  let childCount = 0;

  return (async (_url, init) => {
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, any>;
    };
    const query = parsed.query ?? "";
    calls.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("IssueTeamParent")) {
      return jsonResp({
        issue: {
          id: "parent-internal-eng-5",
          identifier: "ENG-5",
          title: "ENG-5 department engine solicitation cycle",
          description,
          team: { id: "team-eng" },
          parent: null,
        },
      });
    }

    if (query.includes("FanoutChildren") || (query.includes("children") && !query.includes("issueCreate"))) {
      return jsonResp({ issue: { children: { nodes: [] } } });
    }

    if (query.includes("TeamLabels")) {
      return jsonResp({ team: { labels: { nodes: TEAM_LABELS } } });
    }

    if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
      const name = String(parsed.variables?.name ?? "unknown");
      return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-created-${name}` } } });
    }

    if (query.includes("issueCreate")) {
      childCount++;
      return jsonResp({
        issueCreate: {
          success: true,
          issue: { id: `child-${childCount}`, identifier: `ENG-${17 + childCount}` },
        },
      });
    }

    if (query.includes("commentCreate")) {
      return jsonResp({ commentCreate: { success: true, comment: { id: "comment-id" } } });
    }

    throw new Error(`unexpected GraphQL query in INF-1042 test: ${query.slice(0, 120)}`);
  }) as typeof globalThis.fetch;
}

function createInputs(calls: GraphqlCall[]): Array<Record<string, any>> {
  return calls
    .filter((call) => call.query.includes("issueCreate"))
    .map((call) => call.variables.input as Record<string, any>);
}

function labelNamesFor(input: Record<string, any>): string[] {
  const ids = new Set(input.labelIds as string[]);
  return TEAM_LABELS.filter((label) => ids.has(label.id)).map((label) => label.name);
}

function assertEngineeringSolicitOutcome(result: FanoutResult, calls: GraphqlCall[]): void {
  const creates = createInputs(calls);
  const refusalText = result.errors.map((error) => error.message).join(" ");

  if (result.refused || result.created === 0) {
    expect(creates).toHaveLength(0);
    expect(refusalText).toMatch(/engineering|solicit|ENG-18|ENG-19|ENG-20|ENG-21|ENG-22|recovery/i);
    return;
  }

  expect(creates).toHaveLength(5);
  expect(result.childIdentifiers).toEqual(["ENG-18", "ENG-19", "ENG-20", "ENG-21", "ENG-22"]);

  const expectedDelegateIds = ["user-noah", "user-sage", "user-igor", "user-tdd", "user-igor"];

  creates.forEach((input, index) => {
    const labels = labelNamesFor(input);
    expect(labels).not.toContain("wf:task");
    expect(labels.some((label) => /^wf:(dev-impl|engineering-solicit|dept-engine-solicit)$/.test(label))).toBe(true);
    expect(input.delegateId).toBe(expectedDelegateIds[index]);
    expect(input.stateId).toBeDefined();
    expect(input.stateId).not.toBe("native-backlog");
  });
}

describe("INF-1042 Engineering solicit fanout", () => {
  const originalFetch = globalThis.fetch;
  const originalAgentsFile = process.env.AGENTS_FILE;
  let tmpDir: string;
  let calls: GraphqlCall[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1042-agents-"));
    fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({ agents: AGENTS }), "utf8");
    process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
    reloadAgents();
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentsFile === undefined) delete process.env.AGENTS_FILE;
    else process.env.AGENTS_FILE = originalAgentsFile;
    reloadAgents();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AC1/AC2: ENG-18..22 Engineering-role solicitations are not minted as Design-scoped wf:task null-delegate stubs", async () => {
    globalThis.fetch = makeFetch(ENGINEERING_SOLICITATIONS, calls);

    const result = await executeFanout("ENG-5", "Bearer token", ENGINEERING_SOLICIT_FANOUT, {
      skipPreview: true,
      lookupEntryState: async (workflowLabel) => (
        workflowLabel === "wf:dev-impl" ? "state:todo" :
        workflowLabel === "wf:engineering-solicit" ? "state:todo" :
        workflowLabel === "wf:dept-engine-solicit" ? "state:todo" :
        workflowLabel === "wf:task" ? "state:intake" :
        undefined
      ),
      lookupEntryStateId: async (workflowLabel) => NATIVE_STATE_BY_WORKFLOW[workflowLabel] ?? null,
    });

    assertEngineeringSolicitOutcome(result, calls);
  });

  it("AC3: RN, web, backend, test-bar, and owned-resource Engineering solicitations cannot become Backlog/null-delegate xfn stubs", async () => {
    globalThis.fetch = makeFetch(ENGINEERING_SOLICITATIONS, calls);

    const result = await executeFanout("ENG-5", "Bearer token", ENGINEERING_SOLICIT_FANOUT, {
      skipPreview: true,
      lookupEntryState: async (workflowLabel) => (
        workflowLabel === "wf:task" ? "state:intake" : "state:todo"
      ),
      lookupEntryStateId: async (workflowLabel) => NATIVE_STATE_BY_WORKFLOW[workflowLabel] ?? null,
    });

    assertEngineeringSolicitOutcome(result, calls);
  });

  it("AC4: non-code Design/media solicitations still mint ordinary wf:task children unchanged", async () => {
    globalThis.fetch = makeFetch(DESIGN_MEDIA_SOLICITATIONS, calls);

    const result = await executeFanout("DSN-5", "Bearer token", NON_CODE_DESIGN_SOLICIT_FANOUT, {
      skipPreview: true,
      lookupEntryState: async (workflowLabel) => (workflowLabel === "wf:task" ? "state:intake" : undefined),
      lookupEntryStateId: async (workflowLabel) => NATIVE_STATE_BY_WORKFLOW[workflowLabel] ?? null,
    });

    expect(result.refused).toBe(false);
    expect(result.created).toBe(2);

    const creates = createInputs(calls);
    expect(creates).toHaveLength(2);
    for (const input of creates) {
      expect(labelNamesFor(input)).toEqual(expect.arrayContaining(["wf:task", "state:intake"]));
      expect(input.delegateId).toBeUndefined();
      expect(input.stateId).toBe("native-backlog");
    }
  });
});
