/**
 * INF-1164 — deprecate wf:task in favor of wf:chore.
 *
 * AC map:
 *   AC1: new `wf:task` enrollment redirects to `wf:chore` or rejects naming `wf:chore`.
 *   AC2: dept-engine solicitations spawn `wf:chore`, not `wf:task`.
 *   AC3: dev-sprint implementation fanout no longer accepts/emits `wf:task`;
 *        implementation children are only `wf:dev-impl`/`wf:chore`.
 *   AC4: already in-flight `wf:task` tickets still resolve and can complete.
 *   AC5: task.yaml carries an explicit deprecation marker; registry resolves it
 *        for in-flight use but blocks new enrollment through the bootstrap path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { validateFanoutSpec, type FanoutConfig } from "./fanout.js";
import { applyBootstrapToIssue, type IssueContext } from "./workflow-bootstrap.js";
import {
  checkWorkflowRules,
  loadWorkflowRegistry,
  resetNativeStateCache,
  resetWorkflowCache,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const TASK_DEF_PATH = path.join(REGISTERED_DEFS_DIR, "task.yaml");
const DEPT_ENGINE_DEF_PATH = path.join(REGISTERED_DEFS_DIR, "dept-engine.yaml");
const DEV_SPRINT_DEF_PATH = path.join(REGISTERED_DEFS_DIR, "dev-sprint.yaml");

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: requester
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: design
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: engine
    grants: [linear:transition]

roles:
  - id: requester
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: ai
    container: requester
    fills_roles: [requester]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: laren
    container: design
    fills_roles: [department-head]
  - id: penny
    container: design
    fills_roles: [worker]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

type LooseRecord = Record<string, any>;

function readYaml(file: string): LooseRecord {
  return loadYaml(fs.readFileSync(file, "utf8")) as LooseRecord;
}

function state(def: LooseRecord, id: string): LooseRecord {
  const found = (def.states ?? []).find((candidate: LooseRecord) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function allStrings(value: unknown): string[] {
  const seen: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      seen.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) visit(item);
    }
  };
  visit(value);
  return seen;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let capturedLabelIds: string[];
let capturedCommentBodies: string[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1164-wf-task-deprecation-"));
  for (const key of ["WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_PATH", "CAPABILITY_POLICY_PATH", "AGENTS_PATH"]) {
    savedEnv[key] = process.env[key];
  }

  fs.writeFileSync(path.join(tmpDir, "policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "ai", linearUserId: "lin-ai" },
        { name: "astrid", linearUserId: "lin-astrid" },
        { name: "laren", linearUserId: "lin-laren" },
        { name: "penny", linearUserId: "lin-penny" },
        { name: "hanzo", linearUserId: "lin-hanzo" },
        { name: "engine-1", linearUserId: "lin-engine" },
      ],
    }),
    "utf8",
  );
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  reloadAgents();
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  savedFetch = globalThis.fetch;
  capturedLabelIds = [];
  capturedCommentBodies = [];
  installBootstrapFetch();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function installBootstrapFetch(): void {
  const labels = [
    { id: "label-wf-task", name: "wf:task" },
    { id: "label-wf-chore", name: "wf:chore" },
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-state-intake", name: "state:intake" },
    { id: "label-state-sign-off", name: "state:sign-off" },
    { id: "label-state-done", name: "state:done" },
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("commentCreate")) {
      const parsed = JSON.parse(body) as { variables?: { body?: string } };
      capturedCommentBodies.push(parsed.variables?.body ?? "");
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }
    if (body.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: labels } } } });
    }
    if (body.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "Todo", type: "unstarted" },
                { id: "native-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      });
    }
    if (body.includes("ApplyAtomicTransition") || body.includes("issueUpdate")) {
      const parsed = JSON.parse(body) as { variables?: { labelIds?: string[] } };
      capturedLabelIds = parsed.variables?.labelIds ?? [];
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (body.includes("IssueContext")) {
      return json({
        data: {
          issue: {
            labels: { nodes: [{ name: "wf:task" }, { name: "state:sign-off" }] },
            delegate: { id: "lin-ai" },
          },
        },
      });
    }
    if (body.includes("IssueBranchAndPR")) {
      return json({ data: { issue: { attachments: { nodes: [] } } } });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;
}

describe("INF-1164 AC1/AC5: new wf:task enrollment is blocked or redirected to wf:chore", () => {
  it("redirects an explicit create --workflow task request to wf:chore enrollment or rejects naming wf:chore", async () => {
    const issue: IssueContext = {
      id: "issue-inf-1164",
      identifier: "INF-1164-T",
      teamId: "team-inf",
      title: "Archive stale runbook",
      description: "<!-- openclaw:workflow-request id=\"task\" -->",
      labels: [{ id: "label-wf-pending", name: "wf:pending" }],
      creatorId: "lin-ai",
    };

    const result = await applyBootstrapToIssue(issue, "Bearer test-token");

    if (result?.action === "rejected") {
      expect(result.rejectionReason).toMatch(/wf:chore|chore/i);
      expect(capturedCommentBodies.join("\n")).toMatch(/wf:chore|chore/i);
    } else {
      expect(result).toMatchObject({
        action: "bootstrapped",
        workflowId: "chore",
        entryState: "intake",
      });
      expect(capturedLabelIds).toContain("label-wf-chore");
      expect(capturedLabelIds).not.toContain("label-wf-task");
      expect(capturedLabelIds).not.toContain("label-wf-pending");
    }
  });

  it("redirects a direct/default wf:task enrollment to wf:chore or rejects naming wf:chore", async () => {
    const issue: IssueContext = {
      id: "issue-inf-1164-default",
      identifier: "INF-1164-D",
      teamId: "team-inf",
      title: "Schedule operational cleanup",
      description: "Default workflow enrollment should no longer create wf:task.",
      labels: [{ id: "label-wf-task", name: "wf:task" }],
      creatorId: "lin-ai",
    };

    const result = await applyBootstrapToIssue(issue, "Bearer test-token");

    if (result?.action === "rejected") {
      expect(result.rejectionReason).toMatch(/wf:chore|chore/i);
      expect(capturedCommentBodies.join("\n")).toMatch(/wf:chore|chore/i);
    } else {
      expect(result).toMatchObject({
        action: "bootstrapped",
        workflowId: "chore",
        entryState: "intake",
      });
      expect(capturedLabelIds).toContain("label-wf-chore");
      expect(capturedLabelIds).not.toContain("label-wf-task");
    }
  });

  it("keeps task registered for resolution but marks it deprecated and unavailable for new enrollment", async () => {
    const taskDef = readYaml(TASK_DEF_PATH);
    expect(taskDef.deprecated).toEqual(expect.objectContaining({
      replacement: "wf:chore",
      new_enrollment: false,
    }));

    const registry = await loadWorkflowRegistry();
    expect(registry.has("task")).toBe(true);
    expect(registry.has("chore")).toBe(true);
  });
});

describe("INF-1164 AC2: dept-engine spawns wf:chore operational children", () => {
  it("uses wf:chore for solicitation fanout and has no dept-engine wf:task child_workflow", () => {
    const def = readYaml(DEPT_ENGINE_DEF_PATH);
    expect(state(def, "solicit").fanout).toEqual(expect.objectContaining({
      spec_source: "solicitations",
      child_workflow: "wf:chore",
    }));

    const childWorkflows = (def.states ?? [])
      .map((s: LooseRecord) => s.fanout?.child_workflow)
      .filter(Boolean);
    expect(childWorkflows).not.toContain("wf:task");
  });
});

describe("INF-1164 AC3: dev-sprint implementation fanout excludes wf:task", () => {
  it("does not document or default implementation children to wf:task", () => {
    const def = readYaml(DEV_SPRINT_DEF_PATH);
    expect(state(def, "spawn-impl").fanout).toEqual(expect.objectContaining({
      child_workflow: "wf:dev-impl",
    }));

    const implText = [
      state(def, "ac-definition").description,
      state(def, "spawn-impl").description,
      state(def, "spawn-impl").fanout,
    ];
    expect(allStrings(implText).join("\n")).not.toMatch(/wf:task/);
  });

  it("rejects a dev-sprint implementation spec entry that explicitly asks for wf:task", async () => {
    const registry = await loadWorkflowRegistry();
    const registeredWorkflows = new Set([...registry.keys(), ...[...registry.keys()].map((id) => `wf:${id}`)]);
    const config = state(readYaml(DEV_SPRINT_DEF_PATH), "spawn-impl").fanout as FanoutConfig;
    const spec = `
## Findings

- **Operational cleanup** [wf:task -> astrid]
  classification: declared-standalone
  Remove stale notes after release.
`;

    const result = validateFanoutSpec(spec, config, registeredWorkflows);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/wf:task/);
      expect(result.reason).toMatch(/wf:chore|dev-impl/i);
    }
  });
});

describe("INF-1164 AC4: existing in-flight wf:task tickets are grandfathered", () => {
  it("resolves task from the registry and allows sign-off --accept--> done", async () => {
    const registry = await loadWorkflowRegistry();
    const task = registry.get("task") as WorkflowDef | undefined;
    expect(task).toBeDefined();
    expect(task?.states.some((s) => s.id === "sign-off")).toBe(true);
    expect(task?.states.some((s) => s.id === "done" && s.kind === "terminal")).toBe(true);

    const result = await checkWorkflowRules(
      "accept",
      "INF-1164-GRANDFATHER",
      "Bearer test-token",
      "ai",
      null,
      "lin-ai",
      null,
      false,
      false,
      false,
    );
    expect(result).toBeNull();
  });
});
