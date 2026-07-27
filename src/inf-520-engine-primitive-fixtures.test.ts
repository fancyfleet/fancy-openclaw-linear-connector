/**
 * INF-520 — engine-tier primitive fixture coverage.
 *
 * These tests deliberately use synthetic workflow, role, and agent names. They
 * are engine coverage, not configuration regression coverage for any product
 * workflow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  applyStateTransition,
  loadWorkflowRegistry,
  resetNativeStateCache,
  resetWorkflowCache,
  type WorkflowDef,
} from "./workflow-gate.js";
import { validateAllRegisteredDefs } from "./workflow-conformance.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";

const PARENT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/engine-primitive-parent.yaml");
const CHILD_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/engine-primitive-child.yaml");

const FROZEN_PRIMITIVES = [
  "workflow-registration",
  "governed-transitions",
  "guards",
  "fan-out",
  "barrier-join",
  "terminal-reachability",
  "dispatch-wake",
  "idempotency-mutex",
  "parenting-reparenting",
  "role-delegate-resolution",
  "escape-break-glass",
  "commitment-gate",
] as const;

const term = (...parts: string[]): RegExp => new RegExp(`\\b${parts.join("")}\\b`, "i");

const FORBIDDEN_ENGINE_FIXTURE_TERMS = [
  term("sp", "rint"),
  term("dev", "-impl"),
  term("ig", "or"),
  term("t", "dd"),
  term("ast", "rid"),
  term("sp", "rint", "-spawner"),
];

const SYNTHETIC_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: synthetic:admit

containers:
  - id: synthetic-steward-container
    grants: [linear:transition, workflow:break-glass, synthetic:admit]
  - id: synthetic-worker-container
    grants: [linear:transition]
  - id: synthetic-review-container
    grants: [linear:transition]

roles:
  - id: synthetic-steward
    requires: [workflow:break-glass]
  - id: synthetic-worker
    requires: [linear:transition]
  - id: synthetic-reviewer
    requires: [linear:transition]
  - id: synthetic-empty-role
    requires: [linear:transition]
  - id: synthetic-pool-role
    requires: [linear:transition]

bodies:
  - id: alpha-steward
    container: synthetic-steward-container
    fills_roles: [synthetic-steward]
  - id: alpha-worker
    container: synthetic-worker-container
    fills_roles: [synthetic-worker, synthetic-pool-role]
  - id: beta-worker
    container: synthetic-worker-container
    fills_roles: [synthetic-pool-role]
  - id: gamma-reviewer
    container: synthetic-review-container
    fills_roles: [synthetic-reviewer]
`;

function readFixture(file: string): WorkflowDef & { x_engine_primitives?: string[] } {
  return yamlLoad(fs.readFileSync(file, "utf8")) as WorkflowDef & { x_engine_primitives?: string[] };
}

function writeSyntheticRuntimeFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), SYNTHETIC_POLICY_YAML, "utf8");
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "alpha-steward", linearUserId: "user-alpha-steward", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "alpha-worker", linearUserId: "user-alpha-worker", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "beta-worker", linearUserId: "user-beta-worker", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
        { name: "gamma-reviewer", linearUserId: "user-gamma-reviewer", clientId: "c", clientSecret: "s", accessToken: "t", refreshToken: "r" },
      ],
    }),
    "utf8",
  );
}

function makeDefsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-520-engine-defs-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

function makeTransitionFetch(labels: Array<{ id: string; name: string }>): { fetch: typeof globalThis.fetch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let currentLabels = labels;
  let currentDelegateId: string | null = "user-alpha-steward";
  const labelsById = new Map(labels.map((label) => [label.id, label.name]));
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
    calls.push(body);

    if (body.query?.includes("team") && body.query?.includes("labels") && body.query?.includes("TeamLabels")) {
      const nodes = [...labelsById.entries()].map(([id, name]) => ({ id, name, isGroup: false, team: { id: "team-synthetic" } }));
      return new Response(JSON.stringify({ data: { team: { labels: { nodes } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("TeamStates")) {
      return new Response(JSON.stringify({ data: { team: { states: { nodes: [
        { id: "native-todo", name: "Todo", type: "unstarted" },
        { id: "native-thinking", name: "Thinking", type: "started" },
      ] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("IssueBranchAndPR")) {
      return new Response(JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("IssueWithLabels")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            id: "internal-synthetic-ticket",
            identifier: "SYN-520",
            team: { id: "team-synthetic" },
            labels: { nodes: currentLabels },
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("CreateLabel")) {
      const name = String(body.variables?.name ?? "");
      const id = `${name.replace(/[^A-Za-z0-9_-]/g, "-")}-id`;
      labelsById.set(id, name);
      return new Response(JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("ApplyAtomicTransition")) {
      const variables = body.variables ?? {};
      const labelIds = Array.isArray(variables.labelIds) ? variables.labelIds as string[] : [];
      currentLabels = labelIds.map((id) => ({ id, name: labelsById.get(id) ?? id }));
      if ("delegateId" in variables) {
        currentDelegateId = (variables.delegateId as string | null | undefined) ?? null;
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query?.includes("CommentCreate")) {
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      data: {
        issue: {
          labels: { nodes: currentLabels },
          delegate: currentDelegateId ? { id: currentDelegateId } : null,
          state: { id: "native-thinking" },
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("INF-520 AC1/AC2/AC4: synthetic engine-tier primitive fixtures", () => {
  it("uses only synthetic fixture names and declares the frozen primitive matrix", () => {
    const parentRaw = fs.readFileSync(PARENT_FIXTURE, "utf8");
    const childRaw = fs.readFileSync(CHILD_FIXTURE, "utf8");

    for (const forbidden of FORBIDDEN_ENGINE_FIXTURE_TERMS) {
      expect(parentRaw).not.toMatch(forbidden);
      expect(childRaw).not.toMatch(forbidden);
    }

    const parent = readFixture(PARENT_FIXTURE);
    expect(parent.x_engine_primitives).toEqual([...FROZEN_PRIMITIVES]);
  });

  it("loads synthetic parent and child workflows through the registry without product fixtures", async () => {
    const defsDir = makeDefsDir({
      "synthetic-parent.yaml": fs.readFileSync(PARENT_FIXTURE, "utf8"),
      "synthetic-child.yaml": fs.readFileSync(CHILD_FIXTURE, "utf8"),
    });
    try {
      process.env.WORKFLOW_DEFS_DIR = defsDir;
      const registry = await loadWorkflowRegistry();
      expect([...registry.keys()].sort()).toEqual(["synthetic-child", "synthetic-parent"]);
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });

  it("fails definition conformance when an engine fixture omits any frozen primitive declaration", () => {
    const defWithoutMutex = fs.readFileSync(PARENT_FIXTURE, "utf8").replace("  - idempotency-mutex\n", "");
    const defsDir = makeDefsDir({
      "synthetic-parent.yaml": defWithoutMutex,
      "synthetic-child.yaml": fs.readFileSync(CHILD_FIXTURE, "utf8"),
    });
    try {
      const results = validateAllRegisteredDefs(defsDir);
      const parent = results.find((result) => result.defId === "synthetic-parent");
      expect(parent?.valid).toBe(false);
      expect(parent?.errors.map((error) => error.invariant)).toContain("engine-primitive-matrix");
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });
});

describe("INF-520 AC3: frozen delegate-resolution contract", () => {
  let tmpDir: string;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-520-runtime-"));
    writeSyntheticRuntimeFiles(tmpDir);
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
    process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
    reloadAgents();
    resetPolicyCache();
    resetWorkflowCache();
    resetNativeStateCache();
    resetConfigHealth();
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    reloadAgents();
    resetPolicyCache();
    resetWorkflowCache();
    resetNativeStateCache();
    resetConfigHealth();
  });

  it("|C|=0 is rejected at workflow-definition validation", () => {
    const zeroCandidateDef = `
id: synthetic-zero-candidate
version: 1
entry_state: start
states:
  - id: start
    owner_role: synthetic-steward
    native_state: todo
    transitions:
      - command: route-empty
        to: empty-hold
  - id: empty-hold
    owner_role: synthetic-empty-role
    native_state: thinking
`;
    const defsDir = makeDefsDir({ "synthetic-zero-candidate.yaml": zeroCandidateDef });
    try {
      const results = validateAllRegisteredDefs(defsDir);
      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: "delegate-resolution",
            state: "empty-hold",
          }),
        ]),
      );
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });

  it("|C|>1 requires explicit delegate selection criteria at workflow-definition validation", () => {
    const ambiguousPoolDef = `
id: synthetic-pool-without-criteria
version: 1
entry_state: start
states:
  - id: start
    owner_role: synthetic-steward
    native_state: todo
    transitions:
      - command: route-pool
        to: pool-work
        assign:
          mode: required
  - id: pool-work
    owner_role: synthetic-pool-role
    native_state: thinking
`;
    const defsDir = makeDefsDir({ "synthetic-pool-without-criteria.yaml": ambiguousPoolDef });
    try {
      const results = validateAllRegisteredDefs(defsDir);
      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: "delegate-resolution",
            state: "pool-work",
          }),
        ]),
      );
      expect(results[0].errors.map((error) => error.message).join("\n")).toMatch(/selection criteria/i);
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });

  it("|C|=1 auto-resolves the destination delegate at runtime", async () => {
    const singletonDef = `
id: synthetic-singleton-runtime
version: 1
entry_state: start
states:
  - id: start
    owner_role: synthetic-steward
    native_state: todo
    transitions:
      - command: route-singleton
        to: singleton-work
  - id: singleton-work
    owner_role: synthetic-worker
    native_state: thinking
`;
    const defsDir = makeDefsDir({ "synthetic-singleton-runtime.yaml": singletonDef });
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    const { fetch, calls } = makeTransitionFetch([
      { id: "wf-label-id", name: "wf:synthetic-singleton-runtime" },
      { id: "state-start-id", name: "state:start" },
    ]);
    globalThis.fetch = fetch;

    try {
      const result = await applyStateTransition("route-singleton", "SYN-520", "Bearer synthetic-token", {
        bodyId: "alpha-steward",
      });

      expect(result.status).toBe("applied");
      const atomic = calls.find((call) => String(call.query ?? "").includes("ApplyAtomicTransition"));
      expect(atomic?.variables).toEqual(expect.objectContaining({ delegateId: "user-alpha-worker" }));
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });

  it("|C|>1 accepts an explicit valid delegate and rejects an invalid delegate", async () => {
    const poolDef = `
id: synthetic-pool-runtime
version: 1
entry_state: start
states:
  - id: start
    owner_role: synthetic-steward
    native_state: todo
    transitions:
      - command: route-pool
        to: pool-work
        assign:
          mode: required
          selection_criteria: explicit-valid-body
  - id: pool-work
    owner_role: synthetic-pool-role
    native_state: thinking
`;
    const defsDir = makeDefsDir({ "synthetic-pool-runtime.yaml": poolDef });
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    const valid = makeTransitionFetch([
      { id: "wf-label-id", name: "wf:synthetic-pool-runtime" },
      { id: "state-start-id", name: "state:start" },
    ]);
    globalThis.fetch = valid.fetch;

    try {
      const applied = await applyStateTransition("route-pool", "SYN-520", "Bearer synthetic-token", {
        bodyId: "alpha-steward",
        cliTarget: "beta-worker",
      });
      expect(applied.status).toBe("applied");
      const atomic = valid.calls.find((call) => String(call.query ?? "").includes("ApplyAtomicTransition"));
      expect(atomic?.variables).toEqual(expect.objectContaining({ delegateId: "user-beta-worker" }));

      resetWorkflowCache();
      const invalid = makeTransitionFetch([
        { id: "wf-label-id", name: "wf:synthetic-pool-runtime" },
        { id: "state-start-id", name: "state:start" },
      ]);
      globalThis.fetch = invalid.fetch;
      const rejected = await applyStateTransition("route-pool", "SYN-520", "Bearer synthetic-token", {
        bodyId: "alpha-steward",
        cliTarget: "gamma-reviewer",
      });

      expect(rejected.status).toBe("failed");
      expect(rejected.code).toBe("delegate-unresolved");
      expect(rejected.detail).toMatch(/not.*valid.*synthetic-pool-role|synthetic-pool-role.*not.*valid/i);
      expect(invalid.calls.some((call) => String(call.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });

  it("|C|=0 runtime backstop holds the transition, posts a diagnostic, and does not advance state", async () => {
    const zeroCandidateDef = `
id: synthetic-zero-candidate-runtime
version: 1
entry_state: start
break_glass:
  command: abort-path
  to: escaped
  owner_role: synthetic-steward
states:
  - id: start
    owner_role: synthetic-steward
    native_state: todo
    transitions:
      - command: route-empty
        to: empty-hold
  - id: empty-hold
    owner_role: synthetic-empty-role
    native_state: thinking
  - id: escaped
    owner_role: synthetic-steward
    kind: terminal
    native_state: invalid
`;
    const defsDir = makeDefsDir({ "synthetic-zero-candidate-runtime.yaml": zeroCandidateDef });
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    const { fetch, calls } = makeTransitionFetch([
      { id: "wf-label-id", name: "wf:synthetic-zero-candidate-runtime" },
      { id: "state-start-id", name: "state:start" },
    ]);
    globalThis.fetch = fetch;

    try {
      const result = await applyStateTransition("route-empty", "SYN-520", "Bearer synthetic-token", {
        bodyId: "alpha-steward",
      });

      expect(result.status).toBe("failed");
      expect(result.code).toBe("delegate-unresolved");
      expect(result.detail).toMatch(/no bodies.*synthetic-empty-role/i);
      expect(calls.some((call) => String(call.query ?? "").includes("ApplyAtomicTransition"))).toBe(false);
      expect(calls.some((call) => String(call.query ?? "").includes("CommentCreate"))).toBe(true);
    } finally {
      fs.rmSync(defsDir, { recursive: true, force: true });
    }
  });
});
