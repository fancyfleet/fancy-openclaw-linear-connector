/**
 * INF-924 — wf:task department-head resolution must be scoped to the ticket team.
 *
 * Regression target: an ENG-team ticket enrolled in the Design-scoped wf:task
 * archetype must never silently route department-head ownership to Laren via
 * the task definition's DSN/Design defaults or the department-prefix fallback.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";

import { buildDeliveryMessage } from "./delivery/build-message.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { checkRoleGuardEnforced } from "./routing-guard.js";
import type { RouteResult } from "./types.js";
import {
  loadWorkflowDefById,
  resetWorkflowCache,
  resolveTransitionTargets,
} from "./workflow-gate.js";

const TOK = "Bearer test-token";
const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

const POLICY_WITH_SCOPED_TASK_HEADS = `
capabilities:
  - id: linear:transition

containers:
  - id: department-lead
    grants: [linear:transition]
  - id: worker
    grants: [linear:transition]
  - id: requester
    grants: [linear:transition]

roles:
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: requester
    requires: [linear:transition]

bodies:
  - id: charles
    container: department-lead
    fills_roles: [department-head]
    departments: [ENG]
    teams: [Engineering]
  - id: laren
    container: department-lead
    fills_roles: [department-head]
    departments: [DSN]
    teams: [Design]
  - id: ai
    container: requester
    fills_roles: [requester]
  - id: igor
    container: worker
    fills_roles: [worker]
    departments: [ENG]
    teams: [Engineering]
  - id: sage
    container: worker
    fills_roles: [worker]
    departments: [DSN]
    teams: [Design]
`;

type IssueScope = {
  identifier?: string;
  teamKey?: string;
  teamName?: string;
  workflowEnrollment?: {
    department?: string;
    team?: string;
  };
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeLabelFetch(labels: string[], scope: IssueScope = {}): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const issue = {
      identifier: scope.identifier ?? "ENG-11",
      title: "Engineering task routed through wf:task",
      team: {
        key: scope.teamKey ?? "ENG",
        name: scope.teamName ?? "Engineering",
      },
      labels: { nodes: labels.map((name) => ({ name })) },
      delegate: null,
      workflowEnrollment: scope.workflowEnrollment,
    };

    if (body.includes("IssueTitle")) {
      return jsonResponse({ data: { issue } });
    }
    return jsonResponse({ data: { issue } });
  }) as unknown as typeof globalThis.fetch;
}

function makeRoute(scope: IssueScope = {}): RouteResult {
  const identifier = scope.identifier ?? "ENG-11";
  return {
    agentId: "laren",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Astrid", type: "user" },
      data: {
        identifier,
        title: "Engineering task routed through wf:task",
        team: {
          key: scope.teamKey ?? "ENG",
          name: scope.teamName ?? "Engineering",
        },
        workflowEnrollment: scope.workflowEnrollment,
      },
    } as unknown as RouteResult["event"]["data"],
  };
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-924-"));
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_WITH_SCOPED_TASK_HEADS, "utf8");
  fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "charles-linear-id" },
      { name: "laren", linearUserId: "laren-linear-id" },
      { name: "ai", linearUserId: "ai-linear-id" },
      { name: "igor", linearUserId: "igor-linear-id" },
      { name: "sage", linearUserId: "sage-linear-id" },
    ],
  }), "utf8");
  fs.mkdirSync(path.join(tmpDir, "guidance", "task"), { recursive: true });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.WORKFLOW_GUIDANCE_DIR = path.join(tmpDir, "guidance");
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  process.env.LABEL_FETCH_MAX_RETRIES = "0";
  process.env.LABEL_FETCH_BASE_DELAY_MS = "1";
  resetWorkflowCache();
  resetPolicyCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.AGENTS_PATH;
  delete process.env.LABEL_FETCH_MAX_RETRIES;
  delete process.env.LABEL_FETCH_BASE_DELAY_MS;
  resetWorkflowCache();
  resetPolicyCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-924: wf:task department-head resolution uses ticket team scope", () => {
  it("AC1: ENG-team task intake -> routing auto-assigns the Engineering head, not Laren", async () => {
    const def = await loadWorkflowDefById("task");
    const intake = def!.states.find((state) => state.id === "intake")!;
    const request = intake.transitions!.find((transition) => transition.command === "request")!;

    await expect(
      (resolveTransitionTargets as unknown as Function)(request, def, {
        issueIdentifier: "ENG-11",
        teamKey: "ENG",
        teamName: "Engineering",
        workflowEnrollment: { department: "ENG", team: "Engineering" },
      }),
    ).resolves.toEqual({
      bodies: ["charles"],
      mode: "auto",
    });
  });

  it("AC2: dispatch guard blocks a Design head holding an ENG wf:task routing state", async () => {
    await expect(
      (checkRoleGuardEnforced as unknown as Function)("laren", ["wf:task", "state:routing"], {
        issueIdentifier: "ENG-11",
        teamKey: "ENG",
        teamName: "Engineering",
        workflowEnrollment: { department: "ENG", team: "Engineering" },
      }),
    ).resolves.toEqual(expect.objectContaining({
      blocked: true,
      correctedTo: "charles",
      legalBodies: ["charles"],
    }));
  });

  it("AC3: delivery instructions for an ENG wf:task render Charles as the singleton head", async () => {
    globalThis.fetch = makeLabelFetch(["wf:task", "state:intake"], {
      identifier: "ENG-11",
      teamKey: "ENG",
      teamName: "Engineering",
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    });

    const message = await buildDeliveryMessage(makeRoute({
      identifier: "ENG-11",
      teamKey: "ENG",
      teamName: "Engineering",
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    }), TOK);

    expect(message).toContain("This is a [task] workflow ticket");
    expect(message).toContain("linear continue-workflow ENG-11");
    expect(message).toContain("[auto-assigns to charles]");
    expect(message).not.toContain("[auto-assigns to laren]");
  });
});
