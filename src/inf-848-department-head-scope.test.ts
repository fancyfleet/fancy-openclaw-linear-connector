/**
 * INF-848 — department-head call sites must thread department/team scope.
 *
 * These are regression tests for the live production helpers that derive legal
 * targets or render workflow instructions. They deliberately do not call
 * resolveBodiesForRole("department-head", scope) directly; INF-784 already
 * covers the resolver unit behavior.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";

import {
  buildStateTransitionReminder,
  loadWorkflowDefById,
  loadWorkflowRegistry,
  resetWorkflowCache,
  resolveTransitionTargets,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { checkRoleGuardEnforced } from "./routing-guard.js";
import { checkDefAgainstFixture } from "./fixture-drift-detector.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";
import type { RouteResult } from "./types.js";

const TOK = "Bearer test-token";
const ISSUE = "INF-848";
const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");

const POLICY_WITH_SCOPED_DEPARTMENT_HEADS = `
capabilities:
  - id: linear:transition
  - id: deploy:execute

containers:
  - id: department-lead
    grants: [linear:transition]
  - id: worker
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: requester
    grants: [linear:transition]
  - id: engine
    no_body: true
    grants: [linear:transition]

roles:
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: requester
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
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
  - id: igor
    container: worker
    fills_roles: [worker]
  - id: sage
    container: worker
    fills_roles: [worker]
  - id: ai
    container: requester
    fills_roles: [requester]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return (async (_url: string, _init?: RequestInit) =>
    jsonResponse({
      data: {
        issue: {
          labels: { nodes: labels.map((name) => ({ name })) },
        },
      },
    })) as unknown as typeof globalThis.fetch;
}

function makeRoute(identifier: string, title: string): RouteResult {
  return {
    agentId: "charles",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason: "delegate",
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as RouteResult["event"],
  };
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-848-"));
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_WITH_SCOPED_DEPARTMENT_HEADS, "utf8");
  fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "charles-linear-id" },
      { name: "laren", linearUserId: "laren-linear-id" },
      { name: "igor", linearUserId: "igor-linear-id" },
      { name: "sage", linearUserId: "sage-linear-id" },
      { name: "ai", linearUserId: "ai-linear-id" },
      { name: "hanzo", linearUserId: "hanzo-linear-id" },
    ],
  }), "utf8");
  fs.mkdirSync(path.join(tmpDir, "guidance", "task"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "guidance", "dept-engine"), { recursive: true });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.WORKFLOW_GUIDANCE_DIR = path.join(tmpDir, "guidance");
  process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  process.env.LABEL_FETCH_MAX_RETRIES = "0";
  process.env.LABEL_FETCH_BASE_DELAY_MS = "1";
  resetPolicyCache();
  resetWorkflowCache();
  _resetAppliedStateStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.AGENTS_FILE;
  delete process.env.AGENTS_PATH;
  delete process.env.LABEL_FETCH_MAX_RETRIES;
  delete process.env.LABEL_FETCH_BASE_DELAY_MS;
  resetPolicyCache();
  resetWorkflowCache();
  _resetAppliedStateStore();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-848 AC1/AC2: wf:task department-head paths survive DSN-scoped Laren grants", () => {
  it("resolveTransitionTargets derives the scoped routing target for task intake → routing", async () => {
    const def = await loadWorkflowDefById("task");
    const intake = def!.states.find((s) => s.id === "intake");
    const request = intake!.transitions?.find((t) => t.command === "request");

    await expect(resolveTransitionTargets(request!, def!)).resolves.toEqual({
      bodies: ["laren"],
      mode: "auto",
    });
  });

  it("dispatch-message build renders review/routing legal actions instead of falling back when Laren is DSN-scoped", async () => {
    globalThis.fetch = makeLabelFetch(["wf:task", "state:intake"]);
    const { buildDeliveryMessage } = await import("./delivery/build-message.js");

    const message = await buildDeliveryMessage(makeRoute("INF-848", "Unscoped wf:task review/routing"), TOK);

    expect(message).toContain("This is a [task] managed workflow ticket");
    expect(message).toContain("linear continue-workflow INF-848");
    expect(message).toContain("[auto-assigns to laren]");
    expect(message).not.toContain("Workflow context unavailable");
    expect(message).not.toContain("Next Steps:");
  });

  it("buildStateTransitionReminder survives when a task revision reminder includes a department-head-owned submit target", async () => {
    globalThis.fetch = makeLabelFetch(["wf:task", "state:sign-off"]);

    await expect(buildStateTransitionReminder("request-changes", ISSUE, TOK)).resolves.toContain(
      "linear submit INF-848",
    );
  });
});

describe("INF-848 AC3: Engineering department-engine head routing stays staffed after global head migration", () => {
  it("resolveTransitionTargets keeps ENG/Engineering dept-engine transitions staffed by the Engineering head", async () => {
    const def = await loadWorkflowDefById("dept-engine");
    const evaluating = def!.states.find((s) => s.id === "evaluating");
    const proposeTheme = evaluating!.transitions?.find((t) => t.command === "propose-theme");

    await expect(resolveTransitionTargets(proposeTheme!, def!)).resolves.toEqual({
      bodies: ["charles"],
      mode: "auto",
    });
  });

  it("department-engine dispatch target derivation renders the scoped Engineering head instead of Laren or no target", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dept-engine", "state:evaluating"]);
    const { buildDeliveryMessage } = await import("./delivery/build-message.js");

    const message = await buildDeliveryMessage(makeRoute("ENG-848", "Engineering department engine"), TOK);

    expect(message).toContain("This is a [dept-engine] managed workflow ticket");
    expect(message).toContain("linear continue-workflow ENG-848");
    expect(message).toContain("[auto-assigns to charles]");
    expect(message).not.toContain("laren");
    expect(message).not.toContain("Workflow context unavailable");
  });

  it("routing guard corrects wrong dept-engine dispatches to the scoped Engineering head", async () => {
    await expect(checkRoleGuardEnforced("laren", ["wf:dept-engine", "state:evaluating"])).resolves.toEqual(
      expect.objectContaining({
        blocked: true,
        correctedTo: "charles",
        legalBodies: ["charles"],
      }),
    );
  });

  it("workflow bootstrap seats dept-engine entry tickets with the scoped Engineering head", async () => {
    const mutationBodies: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
        mutationBodies.push(body);
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (body.includes("labels")) {
        return jsonResponse({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-wf-dept-engine", name: "wf:dept-engine" },
                  { id: "label-state-evaluating", name: "state:evaluating" },
                ],
              },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    }) as typeof globalThis.fetch;

    const { reloadAgents } = await import("./agents.js");
    reloadAgents();
    const { applyBootstrapToIssue } = await import("./workflow-bootstrap.js");

    const result = await applyBootstrapToIssue({
      id: "issue-inf-848",
      teamId: "team-eng",
      identifier: "INF-848",
      title: "Department engine bootstrap",
      labels: [{ id: "label-wf-dept-engine", name: "wf:dept-engine" }],
    }, TOK);

    expect(result).toEqual(expect.objectContaining({
      action: "bootstrapped",
      delegateAgentName: "charles",
    }));
    expect(mutationBodies.join("\n")).toContain("charles-linear-id");
    expect(mutationBodies.join("\n")).not.toContain("laren-linear-id");
  });
});

describe("INF-848 AC4: connector health and fixture-drift inputs stay green across the policy migration", () => {
  it("keeps task and dept-engine registered defs in sync with canonical fixtures", async () => {
    for (const workflowId of ["task", "dept-engine"]) {
      const deployed = fs.readFileSync(path.join(REGISTERED_DEFS_DIR, `${workflowId}.yaml`), "utf8");
      await expect(checkDefAgainstFixture(workflowId, deployed)).resolves.toEqual(expect.objectContaining({
        fixtureExists: true,
        inSync: true,
        driftDescription: null,
      }));
    }
  });

  it("loads the production registry with task and dept-engine while the scoped policy is active", async () => {
    const registry = await loadWorkflowRegistry();

    expect(registry.has("task")).toBe(true);
    expect(registry.has("dept-engine")).toBe(true);
  });
});
