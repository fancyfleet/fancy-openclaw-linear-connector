/**
 * INF-1205 — dev-impl v20: revert INF-695 commitment gate + unify reject verb.
 *
 * AC map:
 * - AC1/fixture guard: the live registered dev-impl def is v20 with exactly the
 *   eight v20 states, and no doing/needs-info/rejected remnants.
 * - AC2/bootstrap liveness: createApp() boots the production app factory used
 *   by index.ts and /health.workflowRegistry exposes the live v20 registry.
 * - AC3: `linear reject <id>` works from write-tests, implementation,
 *   code-review, merge, deploy, and ac-validate, routing to the v20 destination.
 * - AC4: implementation has no commitment_gate and `submit` is the sole forward
 *   edge; the INF-695 accept/not-ready fork is gone.
 * - AC5: request-changes/ac-fail are removed from the def and the dev-impl
 *   guidance documents the reject replacement.
 * - AC6: the canonical mirror of the vault def is in sync with registered v20.
 * - AC7: a LIF-375-shaped v19 ticket at removed state doing migrates to v20
 *   implementation instead of being stranded.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";

import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetDefStateMigrationLiveness, runDefStateMigrationSweep } from "./def-state-migration.js";
import {
  applyStateTransition,
  loadWorkflowRegistry,
  resetNativeStateCache,
  resetWorkflowCache,
  type WorkflowDef,
} from "./workflow-gate.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const REGISTERED_DEV_IMPL = path.join(REGISTERED_DEFS_DIR, "dev-impl.yaml");
const CANONICAL_DEV_IMPL = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const GUIDANCE_DIR = path.resolve(process.cwd(), "config-templates/workflows/dev-impl");

const V20_STATES = [
  "intake",
  "write-tests",
  "implementation",
  "code-review",
  "merge",
  "deploy",
  "ac-validate",
  "done",
];

const REMOVED_INF_695_STATES = ["doing", "needs-info", "rejected"];
const REMOVED_REVISION_VERBS = ["request-changes", "ac-fail"];
const REMOVED_COMMITMENT_VERBS = ["accept", "not-ready"];

const REJECT_EDGES: Array<{ from: string; to: string; actor: string; delegate: string }> = [
  { from: "write-tests", to: "intake", actor: "tdd", delegate: "lin-tdd" },
  { from: "implementation", to: "write-tests", actor: "igor", delegate: "lin-igor" },
  { from: "code-review", to: "implementation", actor: "charles", delegate: "lin-charles" },
  { from: "merge", to: "code-review", actor: "hanzo", delegate: "lin-hanzo" },
  { from: "deploy", to: "implementation", actor: "grover", delegate: "lin-grover" },
  { from: "ac-validate", to: "implementation", actor: "astrid", delegate: "lin-astrid" },
];

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute
  - id: infra:ssh
  - id: workflow:force-deploy

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:force-deploy]
  - id: test-author
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]

roles:
  - id: steward
    requires: [human:escalate]
  - id: test-author
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: host-deploy
    requires: [infra:ssh]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
`;

type LooseDef = Record<string, any>;
type GraphqlCall = { query: string; variables: Record<string, any> };

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readDef(file: string): LooseDef {
  return loadYaml(fs.readFileSync(file, "utf8")) as LooseDef;
}

function state(def: LooseDef, id: string): LooseDef {
  const found = ((def.states ?? []) as LooseDef[]).find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found!;
}

function stateIds(def: LooseDef): string[] {
  return ((def.states ?? []) as LooseDef[]).map((s) => s.id);
}

function transitionsFrom(def: LooseDef, id: string): Array<{ command: string; to: string; generic?: string }> {
  return (state(def, id).transitions ?? []) as Array<{ command: string; to: string; generic?: string }>;
}

function allTransitionCommands(def: LooseDef): string[] {
  return ((def.states ?? []) as LooseDef[]).flatMap((s) => (s.transitions ?? []).map((t: LooseDef) => t.command));
}

function parseBody(init?: RequestInit): GraphqlCall {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installTransitionFetch(sourceState: string, delegateId: string): { calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  let currentDelegateId = delegateId;
  let labelNodes = [
    { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: "team-lif" } },
    { id: `label-state-${sourceState}`, name: `state:${sourceState}`, team: { id: "team-lif" } },
    { id: "label-workflow-version-19", name: "workflow-version:19", team: { id: "team-lif" } },
  ];
  const teamLabels = [
    { id: "label-wf-dev-impl", name: "wf:dev-impl" },
    { id: "label-workflow-version-20", name: "workflow-version:20" },
    ...V20_STATES.map((id) => ({ id: `label-state-${id}`, name: `state:${id}` })),
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = parseBody(init);
    const query = parsed.query ?? "";
    calls.push(parsed);

    if (query.includes("TeamStates")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "native-todo", name: "Todo", type: "unstarted" },
                { id: "native-doing", name: "Doing", type: "started" },
                { id: "native-done", name: "Done", type: "completed" },
                { id: "native-invalid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({ data: { team: { labels: { nodes: teamLabels } } } });
    }
    if (query.includes("IssueBranchAndPR") || query.includes("IssueRepoAttachments")) {
      return json({ data: { issue: { attachments: { nodes: [] }, description: "", comments: { nodes: [] } } } });
    }
    if (query.includes("IssueContext") || query.includes("issue(")) {
      return json({
        data: {
          issue: {
            id: "issue-lif-375",
            identifier: "LIF-375",
            team: { id: "team-lif", key: "LIF", name: "LifeOS" },
            labels: { nodes: labelNodes },
            delegate: currentDelegateId ? { id: currentDelegateId } : null,
            state: { id: "native-todo", name: "Todo", type: "unstarted" },
            assignee: null,
          },
        },
      });
    }
    if (query.includes("issueUpdate")) {
      const nextLabelIds = (parsed.variables?.labelIds ?? []) as string[];
      labelNodes = teamLabels
        .filter((label) => nextLabelIds.includes(label.id))
        .map((label) => ({ ...label, team: { id: "team-lif" } }));
      if (typeof parsed.variables?.delegateId === "string") {
        currentDelegateId = parsed.variables.delegateId;
      }
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;

  return { calls };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1205-"));
  saveEnv(
    "WORKFLOW_DEFS_DIR",
    "WORKFLOW_DEF_DIR",
    "WORKFLOW_DEF_PATH",
    "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
    "CAPABILITY_POLICY_PATH",
    "AGENTS_FILE",
    "AGENTS_PATH",
    "ADMIN_SECRET",
    "WORKFLOW_GUIDANCE_DIR",
  );
  fs.writeFileSync(path.join(tmpDir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "lin-astrid", accessToken: "tok-astrid" },
        { name: "tdd", linearUserId: "lin-tdd", accessToken: "tok-tdd" },
        { name: "igor", linearUserId: "lin-igor", accessToken: "tok-igor" },
        { name: "charles", linearUserId: "lin-charles", accessToken: "tok-charles" },
        { name: "hanzo", linearUserId: "lin-hanzo", accessToken: "tok-hanzo" },
        { name: "grover", linearUserId: "lin-grover", accessToken: "tok-grover" },
      ],
    }),
    "utf8",
  );
  savedFetch = globalThis.fetch;
});

beforeEach(() => {
  process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
  process.env.WORKFLOW_DEF_PATH = REGISTERED_DEV_IMPL;
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(tmpDir, `def-state-${Date.now()}-${Math.random()}.json`);
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "capability-policy.yaml");
  process.env.AGENTS_FILE = path.join(tmpDir, "agents.json");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
  process.env.ADMIN_SECRET = "inf-1205-admin-secret";
  process.env.WORKFLOW_GUIDANCE_DIR = path.resolve(process.cwd(), "config-templates/workflows");
  reloadAgents();
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  resetDefStateMigrationLiveness();
  globalThis.fetch = savedFetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
  resetDefStateMigrationLiveness();
});

afterAll(() => {
  restoreEnv();
  globalThis.fetch = savedFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-1205 AC1/AC4/AC5: dev-impl v20 registered def shape", () => {
  it("AC1: registered dev-impl is v20 with exactly the eight v20 states and no INF-695 removed states", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("dev-impl");

    // INF-1260 AC5 added a resume-review forward-recovery edge at intake,
    // bumping the registered def to v21. The v20 state shape (still exactly
    // these eight states, no INF-695 removed states) is unchanged.
    expect(def?.version).toBe(21);
    expect(def?.states.map((s) => s.id)).toEqual(V20_STATES);
    expect(def?.states.map((s) => s.id)).toEqual(expect.not.arrayContaining(REMOVED_INF_695_STATES));
  });

  it("AC4: implementation has no commitment_gate and submit is its sole forward edge", () => {
    const def = readDef(REGISTERED_DEV_IMPL);
    const implementation = state(def, "implementation");
    const commands = transitionsFrom(def, "implementation").map((t) => t.command);

    expect(implementation.commitment_gate).toBeUndefined();
    expect(commands).toContain("submit");
    expect(commands).toContain("reject");
    expect(commands).toContain("handoff");
    expect(commands).toEqual(expect.not.arrayContaining(REMOVED_COMMITMENT_VERBS));
    expect(transitionsFrom(def, "implementation").filter((t) => !["handoff", "reject"].includes(t.command))).toEqual([
      expect.objectContaining({ command: "submit", to: "code-review", generic: "continue" }),
    ]);
  });

  it("AC5: request-changes/ac-fail are not legal commands; dev-impl guidance documents reject as the replacement", () => {
    const def = readDef(REGISTERED_DEV_IMPL);
    expect(allTransitionCommands(def)).toEqual(expect.not.arrayContaining(REMOVED_REVISION_VERBS));

    const guidance = fs
      .readdirSync(GUIDANCE_DIR)
      .filter((file) => file.endsWith(".md"))
      .map((file) => fs.readFileSync(path.join(GUIDANCE_DIR, file), "utf8"))
      .join("\n");

    expect(guidance).toMatch(/\breject\b/i);
    expect(guidance).toMatch(/request-changes[\s\S]{0,160}(removed|retired|replaced|alias|maps? to|use reject)/i);
    expect(guidance).toMatch(/ac-fail[\s\S]{0,160}(removed|retired|replaced|alias|maps? to|use reject)/i);
  });
});

describe("INF-1205 AC2: bootstrap liveness exposes live dev-impl v20 registry", () => {
  it("boots createApp() and /health.workflowRegistry.dev-impl reports v20 exactly", async () => {
    const appState = createApp();
    try {
      const res = await request(appState.app)
        .get("/health")
        .set("Authorization", "Bearer inf-1205-admin-secret");

      expect(res.body.workflowRegistry?.["dev-impl"]).toEqual({
        id: "dev-impl",
        version: 21,
        states: V20_STATES,
      });
      expect(res.body.workflowRegistry?.["dev-impl"]?.states).toEqual(
        expect.not.arrayContaining(REMOVED_INF_695_STATES),
      );
    } finally {
      appState.bag.close();
      appState.sessionTracker.close();
      appState.agentQueue.close();
      appState.operationalEventStore.close();
      appState.observationStore.close();
      appState.watchdog.stop();
      appState.noActivityDetector.stop();
      appState.managingPoller.stop();
    }
  });
});

describe("INF-1205 AC3: reject works from every v20 revision/back edge", () => {
  it.each(REJECT_EDGES)(
    "AC3: reject from $from routes to $to through the live def",
    async ({ from, to, actor, delegate }) => {
      const { calls } = installTransitionFetch(from, delegate);

      const result = await applyStateTransition("reject", "issue-lif-375", "Bearer tok", {
        bodyId: actor,
        sourceStateOverride: from,
      });

      expect(result).toMatchObject({ status: "applied", from, to });
      const update = calls.find((call) => call.query.includes("issueUpdate") && Array.isArray(call.variables.labelIds));
      expect(update?.variables.labelIds).toContain(`label-state-${to}`);
      expect(update?.variables.labelIds).not.toContain(`label-state-${from}`);
    },
  );
});

describe("INF-1205 AC6: canonical dev-impl mirror matches registered v20", () => {
  it("canonical mirror and registered def are structurally identical v20 definitions", () => {
    const registered = readDef(REGISTERED_DEV_IMPL);
    const canonical = readDef(CANONICAL_DEV_IMPL);

    expect(canonical).toEqual(registered);
    expect(canonical.version).toBe(21);
    expect(stateIds(canonical)).toEqual(V20_STATES);
    expect(stateIds(canonical)).toEqual(expect.not.arrayContaining(REMOVED_INF_695_STATES));
  });
});

describe("INF-1205 AC7: LIF-375 v19 doing is migrated, not stranded", () => {
  it("registered v20 declares removed-state migrations for INF-695 states to implementation", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("dev-impl") as WorkflowDef | undefined;

    expect(def?.migrations).toMatchObject({
      doing: "implementation",
      "needs-info": "implementation",
      rejected: "implementation",
    });
  });

  it("a LIF-375-shaped v19 ticket at state:doing migrates atomically to state:implementation", async () => {
    const registry = await loadWorkflowRegistry();
    const def = registry.get("dev-impl") as WorkflowDef;
    const labelIds: Record<string, string> = {
      "wf:dev-impl": "label-wf-dev-impl",
      "workflow-version:19": "label-workflow-version-19",
      "workflow-version:20": "label-workflow-version-20",
      "state:doing": "label-state-doing",
      "state:implementation": "label-state-implementation",
    };
    const capturedLabelIds: string[][] = [];
    const wakes: Array<{ agent: string; identifier: string }> = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = parseBody(init);
      const query = parsed.query ?? "";
      if (query.includes("issues(") || query.includes("WorkflowIssues") || query.includes("IssueSearch")) {
        return json({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-lif-375",
                  identifier: "LIF-375",
                  team: { id: "team-lif" },
                  labels: {
                    nodes: [
                      { id: "label-wf-dev-impl", name: "wf:dev-impl" },
                      { id: "label-workflow-version-19", name: "workflow-version:19" },
                      { id: "label-state-doing", name: "state:doing" },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (query.includes("issueUpdate")) {
        capturedLabelIds.push((parsed.variables?.labelIds ?? []) as string[]);
        return json({ data: { issueUpdate: { success: true } } });
      }
      return json({ data: {} });
    }) as typeof globalThis.fetch;

    const result = await runDefStateMigrationSweep({
      authToken: "Bearer tok",
      workflowRegistry: new Map([["dev-impl", def]]),
      labelNameToId: (name) => labelIds[name] ?? null,
      wakeFn: async (agent, identifier) => {
        wakes.push({ agent, identifier });
      },
    });

    expect(result.scanned).toBe(1);
    expect(result.migrated).toEqual([
      { ticketId: "issue-lif-375", identifier: "LIF-375", fromState: "doing", toState: "implementation" },
    ]);
    expect(capturedLabelIds[0]).toContain("label-state-implementation");
    expect(capturedLabelIds[0]).not.toContain("label-state-doing");
    expect(wakes.some((wake) => wake.identifier === "LIF-375")).toBe(true);
  });
});
