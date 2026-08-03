/**
 * INF-1172 — dev-sprint ac-definition can adopt named existing impl tickets.
 *
 * AC map:
 *  - AC1: a governed `adopt` edge/spec directive from ac-definition enrolls
 *         named existing tickets as implementation children by setting parent
 *         and barrier-tracking, without minting duplicates.
 *  - AC2: after adoption, the normal continue/barrier/converge walk uses those
 *         adopted children; no manual re-parent or steward-to-terminal path is
 *         required.
 *  - AC3: INF-1159 regression — mid-workflow existing tickets in review,
 *         routing, and doing states are adopted with zero duplicates and the
 *         parent converges once they terminate.
 *  - AC4: INF-453 regression guard — cancel/abandon still terminate as
 *         cancelled, not done, and remain distinct from adopt/converge.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { executeFanout, type Finding, type FanoutResult } from "./fanout.js";
import { checkWorkflowRules, resetWorkflowCache, type FanoutConfig, type WorkflowDef, type WorkflowTransition } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const DEV_SPRINT_PATH = path.join(REGISTERED_DEFS_DIR, "dev-sprint.yaml");

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const ASTRID_UUID = "astrid-linear-uuid";

function loadDevSprint(): WorkflowDef {
  return yamlLoad(fs.readFileSync(DEV_SPRINT_PATH, "utf8")) as WorkflowDef;
}

function transition(def: WorkflowDef, stateId: string, command: string): WorkflowTransition {
  const state = def.states.find((s) => s.id === stateId);
  expect(state).toBeDefined();
  const found = state?.transitions?.find((t) => t.command === command);
  expect(found).toBeDefined();
  return found!;
}

type AdoptFinding = Finding & {
  adopt_identifier: string;
};

type FetchCall = {
  operation: string;
  variables: Record<string, unknown>;
  input?: Record<string, unknown>;
};

type ExistingTicket = {
  identifier: string;
  internalId: string;
  title: string;
  labels: string[];
  nativeState?: string;
};

const ADOPT_CONFIG = {
  spec_source: "findings",
  child_workflow: "wf:dev-impl",
  adopt_existing: true,
  initial_delegate: "astrid",
} as FanoutConfig & { adopt_existing: true };

function adoptFinding(ticket: ExistingTicket): AdoptFinding {
  return {
    title: ticket.title,
    description: `adopt: ${ticket.identifier}`,
    classification: "declared-standalone",
    adopt_identifier: ticket.identifier,
  } as AdoptFinding;
}

function doneImplChild(identifier: string) {
  return { identifier, labels: ["wf:dev-impl", "state:done"] };
}

function liveImplChild(identifier: string, state: string) {
  return { identifier, labels: ["wf:dev-impl", `state:${state}`] };
}

function makeConvergeFetch(
  parentLabels: string[],
  children: Array<{ identifier: string; labels: string[] }>,
): typeof globalThis.fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const body = String(init?.body ?? "");
    if (body.includes("ParentChildren")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: children.map((child) => ({
                  identifier: child.identifier,
                  labels: { nodes: child.labels.map((name) => ({ name })) },
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            identifier: "INF-1172",
            labels: { nodes: parentLabels.map((name) => ({ name })) },
            delegate: { id: ASTRID_UUID },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
}

function makeAdoptFetch(existingTickets: ExistingTicket[]) {
  const calls: FetchCall[] = [];
  const byIdentifier = new Map(existingTickets.map((ticket) => [ticket.identifier, ticket]));

  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const variables = body.variables ?? {};
    const input = variables.input as Record<string, unknown> | undefined;
    const operation =
      query.includes("IssueTeamParent") ? "IssueTeamParent"
      : query.includes("FanoutChildren") ? "FanoutChildren"
      : query.includes("TeamLabels") ? "TeamLabels"
      : query.includes("issueCreate") ? "issueCreate"
      : query.includes("issueUpdate") ? "issueUpdate"
      : query.includes("IssueByIdentifier") ? "IssueByIdentifier"
      : query.includes("commentCreate") ? "commentCreate"
      : query.includes("AgentUsers") ? "AgentUsers"
      : "unknown";
    calls.push({ operation, variables, input });

    if (operation === "IssueTeamParent") {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "parent-internal-id",
              title: "INF-1172 Sprint",
              description: "## Findings\n- **Adopt existing impl work**: adopt: INF-1159-A",
              team: { id: "team-id" },
              parent: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "FanoutChildren") {
      return new Response(
        JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "TeamLabels") {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "wf-dev-impl-label", name: "wf:dev-impl", team: { id: "team-id" } },
                  { id: "state-todo-label", name: "state:todo", team: { id: "team-id" } },
                  { id: "state-write-tests-label", name: "state:write-tests", team: { id: "team-id" } },
                  { id: "state-implementation-label", name: "state:implementation", team: { id: "team-id" } },
                  { id: "state-code-review-label", name: "state:code-review", team: { id: "team-id" } },
                  { id: "state-routing-label", name: "state:routing", team: { id: "team-id" } },
                  { id: "state-done-label", name: "state:done", team: { id: "team-id" } },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "IssueByIdentifier") {
      const identifier = String(variables.identifier ?? variables.id ?? "");
      const ticket = byIdentifier.get(identifier);
      return new Response(
        JSON.stringify({
          data: {
            issue: ticket
              ? {
                  id: ticket.internalId,
                  identifier: ticket.identifier,
                  title: ticket.title,
                  state: { name: ticket.nativeState ?? "Doing" },
                  labels: { nodes: ticket.labels.map((name) => ({ name })) },
                  parent: null,
                  team: { id: "team-id" },
                }
              : null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "issueUpdate") {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (operation === "issueCreate") {
      return new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: { id: "duplicate-internal-id", identifier: "INF-1172-DUP" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "AgentUsers") {
      return new Response(
        JSON.stringify({ data: { users: { nodes: [{ id: ASTRID_UUID, displayName: "astrid" }] } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (operation === "commentCreate") {
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

async function runAdopt(existingTickets: ExistingTicket[]): Promise<{ result: FanoutResult; calls: FetchCall[] }> {
  const { fetchImpl, calls } = makeAdoptFetch(existingTickets);
  globalThis.fetch = fetchImpl;
  const result = await executeFanout("INF-1172", "Bearer tok", ADOPT_CONFIG, {
    skipPreview: true,
    findingsOverride: existingTickets.map(adoptFinding),
  });
  return { result, calls };
}

describe("INF-1172 AC1: ac-definition adopt edge shape", () => {
  it("defines a governed adopt transition from ac-definition into the impl barrier path", () => {
    const t = transition(loadDevSprint(), "ac-definition", "adopt") as WorkflowTransition & {
      generic?: string;
      adopt_existing_children?: boolean;
      requires_comment?: boolean;
    };

    expect(t.to).toBe("managing-impl");
    expect(t.generic).toBe("continue");
    expect(t.adopt_existing_children).toBe(true);
    expect(t.requires_comment).toBe(true);
  });

  it("preserves INF-453 cancel/abandon as did-not-complete terminal paths", () => {
    const def = loadDevSprint();
    const done = def.states.find((s) => s.id === "done") as { satisfies_parent_barrier?: boolean } | undefined;
    const cancelled = def.states.find((s) => s.id === "cancelled") as { satisfies_parent_barrier?: boolean } | undefined;

    for (const stateId of ["spawn-arms", "managing-arms"]) {
      expect(transition(def, stateId, "cancel").to).toBe("cancelled");
      expect(transition(def, stateId, "abandon").to).toBe("cancelled");
    }
    expect(done?.satisfies_parent_barrier).toBe(true);
    expect(cancelled?.satisfies_parent_barrier).not.toBe(true);
  });
});

describe("INF-1172 AC1/AC3: adopt existing impl tickets without minting duplicates", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("adopts named existing tickets by setting parent and records them for the barrier", async () => {
    const tickets: ExistingTicket[] = [
      { identifier: "INF-1159-A", internalId: "child-a-id", title: "Review guard", labels: ["wf:dev-impl", "state:code-review"] },
      { identifier: "INF-1159-B", internalId: "child-b-id", title: "Routing guard", labels: ["wf:dev-impl", "state:routing"] },
    ];

    const { result, calls } = await runAdopt(tickets);

    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toEqual([]);
    expect(result.specMatchedChildren.sort()).toEqual(["INF-1159-A", "INF-1159-B"]);

    expect(calls.filter((call) => call.operation === "issueCreate")).toHaveLength(0);
    const parentUpdates = calls.filter((call) => call.operation === "issueUpdate");
    expect(parentUpdates).toHaveLength(2);
    expect(parentUpdates.map((call) => call.variables.issueId ?? call.variables.id).sort()).toEqual([
      "child-a-id",
      "child-b-id",
    ]);
    for (const update of parentUpdates) {
      expect(update.input).toMatchObject({ parentId: "parent-internal-id" });
      expect(update.input?.labelIds).toEqual(expect.arrayContaining(["wf-dev-impl-label"]));
    }
  });

  it("INF-1159 regression: review/routing/doing children adopt once, mint zero duplicates, then converge after termination", async () => {
    const tickets: ExistingTicket[] = [
      { identifier: "INF-1159-R", internalId: "review-id", title: "Existing review ticket", labels: ["wf:dev-impl", "state:code-review"] },
      { identifier: "INF-1159-Q", internalId: "routing-id", title: "Existing routing ticket", labels: ["wf:dev-impl", "state:routing"] },
      { identifier: "INF-1159-D", internalId: "doing-id", title: "Existing doing ticket", labels: ["wf:dev-impl", "state:implementation"] },
    ];

    const { result, calls } = await runAdopt(tickets);

    expect(result.created).toBe(0);
    expect(calls.filter((call) => call.operation === "issueCreate")).toHaveLength(0);
    expect(result.specMatchedChildren.sort()).toEqual(["INF-1159-D", "INF-1159-Q", "INF-1159-R"]);

    globalThis.fetch = makeConvergeFetch(
      ["wf:dev-sprint", "state:managing-impl"],
      [doneImplChild("INF-1159-R"), doneImplChild("INF-1159-Q"), doneImplChild("INF-1159-D")],
    );
    await expect(
      checkWorkflowRules(
        "converge", "INF-1172", "Bearer tok", "astrid",
        null, ASTRID_UUID, null, false, false, true,
      ),
    ).resolves.toBeNull();
  });
});

describe("INF-1172 AC2: adopted children participate in the standard walk", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1172-adopt-"));

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    const defsDir = path.join(dir, "defs");
    fs.mkdirSync(defsDir);
    fs.copyFileSync(DEV_SPRINT_PATH, path.join(defsDir, "dev-sprint.yaml"));
    process.env.WORKFLOW_DEFS_DIR = defsDir;

    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          { name: "astrid", linearUserId: ASTRID_UUID, clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
        ],
      }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.AGENTS_FILE;
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("holds while adopted children are in flight and allows converge when they are terminal", async () => {
    globalThis.fetch = makeConvergeFetch(
      ["wf:dev-sprint", "state:managing-impl"],
      [doneImplChild("INF-1172-A"), liveImplChild("INF-1172-B", "implementation")],
    );
    await expect(
      checkWorkflowRules(
        "converge", "INF-1172", "Bearer tok", "astrid",
        null, ASTRID_UUID, null, false, false, true,
      ),
    ).resolves.toMatch(/still in flight|acceptance walk is not yet satisfied/i);

    globalThis.fetch = makeConvergeFetch(
      ["wf:dev-sprint", "state:managing-impl"],
      [doneImplChild("INF-1172-A"), doneImplChild("INF-1172-B")],
    );
    await expect(
      checkWorkflowRules(
        "converge", "INF-1172", "Bearer tok", "astrid",
        null, ASTRID_UUID, null, false, false, true,
      ),
    ).resolves.toBeNull();
  });
});
