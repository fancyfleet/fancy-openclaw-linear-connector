/**
 * INF-873 — wf:dept-engine instance scope must come from enrollment/runtime.
 *
 * Regression target: DSN-15 enrolled as wf:dept-engine at evaluating, but the
 * connector used static ENG instantiation defaults and corrected Laren to
 * Charles. These tests intentionally pass DSN/Design issue context into the
 * production role-resolution call sites; current code ignores that context.
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

const POLICY_WITH_DEPARTMENT_SCOPED_HEADS = `
capabilities:
  - id: linear:transition

containers:
  - id: department-lead
    grants: [linear:transition]
  - id: engine
    no_body: true
    grants: [linear:transition]

roles:
  - id: department-head
    requires: [linear:transition]
  - id: engine
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
`;

const DEPT_ENGINE_WITH_STATIC_ENG_DEFAULTS = `
id: dept-engine
version: 1
archetype: continuous-loop
entry_state: evaluating

instantiation:
  charter_ref: department-charter
  department: ENG
  team: Engineering
  foundation_milestone: runtime-dispatch-hardened

states:
  - id: evaluating
    owner_role: department-head
    native_state: thinking
    transitions:
      - command: propose-theme
        to: theme-proposal
        generic: continue
  - id: theme-proposal
    owner_role: department-head
    native_state: thinking
    transitions:
      - command: confirm-theme
        to: theme-confirm
        generic: continue
  - id: theme-confirm
    owner_role: department-head
    native_state: todo
    transitions:
      - command: solicit
        to: solicit
        generic: continue
  - id: solicit
    owner_role: engine
    native_state: doing
    transitions:
      - command: synthesize
        to: synthesize-scope
        generic: continue
  - id: synthesize-scope
    owner_role: department-head
    kind: barrier
    barrier: true
    native_state: doing
    transitions:
      - command: spawn
        to: managing
        generic: continue
  - id: managing
    owner_role: department-head
    kind: barrier
    barrier: true
    native_state: managing
    transitions:
      - command: validate
        to: validation
        generic: continue
  - id: validation
    owner_role: department-head
    native_state: thinking
    transitions:
      - command: complete-cycle
        to: done
        generic: continue
  - id: done
    owner_role: engine
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
    transitions:
      - command: loop
        to: evaluating
        generic: continue
`;

type IssueScope = {
  identifier?: string;
  teamKey?: string;
  teamName?: string;
  workflowEnrollment?: {
    department?: string;
    team?: string;
    charterRef?: string;
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
    if (body.includes("IssueTitle")) {
      return jsonResponse({
        data: {
          issue: {
            identifier: scope.identifier ?? "DSN-15",
            title: "Design department engine",
            team: {
              key: scope.teamKey ?? "DSN",
              name: scope.teamName ?? "Design",
            },
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      });
    }
    return jsonResponse({
      data: {
        issue: {
          identifier: scope.identifier ?? "DSN-15",
          team: {
            key: scope.teamKey ?? "DSN",
            name: scope.teamName ?? "Design",
          },
          labels: { nodes: labels.map((name) => ({ name })) },
          delegate: null,
        },
      },
    });
  }) as unknown as typeof globalThis.fetch;
}

function makeRoute(scope: IssueScope): RouteResult {
  const identifier = scope.identifier ?? "DSN-15";
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
        title: "Design department engine",
        team: {
          key: scope.teamKey,
          name: scope.teamName,
        },
        workflowEnrollment: scope.workflowEnrollment,
      },
    } as unknown as RouteResult["event"]["data"],
  };
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-873-"));
  const workflowsDir = path.join(tmpDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(path.join(workflowsDir, "dept-engine.yaml"), DEPT_ENGINE_WITH_STATIC_ENG_DEFAULTS, "utf8");
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_WITH_DEPARTMENT_SCOPED_HEADS, "utf8");
  fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "charles-linear-id" },
      { name: "laren", linearUserId: "laren-linear-id" },
    ],
  }), "utf8");
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.WORKFLOW_DEFS_DIR = path.join(tmpDir, "workflows");
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

describe("INF-873 AC1/AC3: DSN enrollment/runtime scope resolves department-head to Laren", () => {
  it("reproduces DSN-15: evaluating must not resolve Charles from static ENG defaults", async () => {
    const def = await loadWorkflowDefById("dept-engine");
    const evaluating = def!.states.find((state) => state.id === "evaluating")!;
    const proposeTheme = evaluating.transitions!.find((transition) => transition.command === "propose-theme")!;

    await expect(
      (resolveTransitionTargets as unknown as Function)(proposeTheme, def, {
        issueIdentifier: "DSN-15",
        teamKey: "DSN",
        teamName: "Design",
        workflowEnrollment: { department: "DSN", team: "Design", charterRef: "design-department-charter" },
      }),
    ).resolves.toEqual({
      bodies: ["laren"],
      mode: "auto",
    });
  });

  it.each([
    "evaluating",
    "theme-proposal",
    "theme-confirm",
    "synthesize-scope",
    "managing",
    "validation",
  ])("treats Charles as illegal and corrects to Laren for DSN/Design state:%s", async (state) => {
    await expect(
      (checkRoleGuardEnforced as unknown as Function)("charles", ["wf:dept-engine", `state:${state}`], {
        issueIdentifier: "DSN-15",
        teamKey: "DSN",
        teamName: "Design",
        workflowEnrollment: { department: "DSN", team: "Design", charterRef: "design-department-charter" },
      }),
    ).resolves.toEqual(expect.objectContaining({
      blocked: true,
      correctedTo: "laren",
      legalBodies: ["laren"],
    }));
  });

  it("renders DSN evaluating enrollment as auto-assigned to Laren, not Charles", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dept-engine", "state:evaluating"], {
      identifier: "DSN-15",
      teamKey: "DSN",
      teamName: "Design",
      workflowEnrollment: { department: "DSN", team: "Design", charterRef: "design-department-charter" },
    });

    const message = await buildDeliveryMessage(makeRoute({
      identifier: "DSN-15",
      teamKey: "DSN",
      teamName: "Design",
      workflowEnrollment: { department: "DSN", team: "Design", charterRef: "design-department-charter" },
    }), TOK);

    expect(message).toContain("This is a [dept-engine] workflow ticket");
    expect(message).toContain("linear continue-workflow DSN-15");
    expect(message).toContain("[auto-assigns to laren]");
    expect(message).not.toContain("charles");
  });
});

describe("INF-873 AC4/AC5: ENG remains Charles; missing or ambiguous scope fails closed", () => {
  it("keeps ENG/Engineering department-head staffed by Charles", async () => {
    await expect(
      (checkRoleGuardEnforced as unknown as Function)("laren", ["wf:dept-engine", "state:evaluating"], {
        issueIdentifier: "ENG-873",
        teamKey: "ENG",
        teamName: "Engineering",
        workflowEnrollment: { department: "ENG", team: "Engineering", charterRef: "engineering-department-charter" },
      }),
    ).resolves.toEqual(expect.objectContaining({
      blocked: true,
      correctedTo: "charles",
      legalBodies: ["charles"],
    }));
  });

  it("fails closed with actionable scope guidance when DSN/Design instance metadata is unavailable", async () => {
    await expect(
      (checkRoleGuardEnforced as unknown as Function)("charles", ["wf:dept-engine", "state:evaluating"], {
        issueIdentifier: "DSN-15",
        teamKey: undefined,
        teamName: undefined,
        workflowEnrollment: undefined,
      }),
    ).resolves.toEqual(expect.objectContaining({
      blocked: true,
      correctedTo: undefined,
      legalBodies: [],
      reason: expect.stringMatching(/department|team|scope|metadata|enrollment/i),
    }));
  });
});
