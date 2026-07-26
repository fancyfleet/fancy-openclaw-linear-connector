/**
 * INF-758 — dev-sprint `converge` → done must require a completed implementation child.
 *
 * Defect (LIF-291, Cycle 9): a `wf:dev-sprint` reached `state:done` directly
 * from `ac-definition` — its three scoping/design arms (wf:sprint-arm-scope/ux/
 * design) were all terminal, so the INF-504 `converge` edge's
 * `requires_children_terminal` gate was satisfied VACUOUSLY. No implementation
 * child was ever minted; no code shipped; validation was skipped. The parent
 * spawner (LIF-45) then auto-advanced `managing → releasing` on an empty
 * increment — an AI-1870 / LIF-2 self-deleting-alarm one phase earlier.
 *
 * Fix: every `converge` → done edge (ac-definition, spawn-impl, managing-impl)
 * now also carries `requires_implementation_child: true`. The runtime gate
 * refuses convergence unless >=1 COMPLETED implementation child exists — a
 * terminal child carrying `wf:dev-impl` or `wf:task`. Scoping/design arms alone
 * no longer satisfy the terminal completion edge.
 *
 * AC map:
 *  - AC1: def is >= v12 and all three converge edges carry
 *         requires_implementation_child (alongside the INF-504 gates).
 *  - AC2: the runtime gate BLOCKS converge when every child is terminal but the
 *         only children are scoping/design arms (the LIF-291 shape).
 *  - AC3: the runtime gate ALLOWS converge when a terminal wf:dev-impl child
 *         exists (even mixed with terminal scope arms).
 *  - AC4: a terminal wf:task child also satisfies the implementation-child gate.
 *  - AC5: the gate governs all three converge edges (ac-definition, spawn-impl,
 *         managing-impl).
 *
 * (Break-glass bypass is a shared `!breakGlassOverride` guard with the INF-504
 * children-terminal gate — its authorization is exercised by the break-glass
 * suite, not re-tested here.)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import type { WorkflowDef, WorkflowState, WorkflowTransition } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
const DEV_SPRINT_PATH = path.join(REGISTERED_DEFS_DIR, "dev-sprint.yaml");

const CONVERGE_STATES = ["ac-definition", "spawn-impl", "managing-impl"] as const;

function loadDevSprint(): WorkflowDef {
  return yamlLoad(fs.readFileSync(DEV_SPRINT_PATH, "utf8")) as WorkflowDef;
}

function state(def: WorkflowDef, id: string): WorkflowState {
  const found = def.states.find((s) => s.id === id);
  expect(found).toBeDefined();
  return found!;
}

function tx(def: WorkflowDef, stateId: string, command: string): WorkflowTransition {
  const found = state(def, stateId).transitions?.find((t) => t.command === command);
  expect(found).toBeDefined();
  return found!;
}

// ── AC1: structural (def-shape) ──────────────────────────────────────────────

describe("INF-758 AC1: converge edges require an implementation child", () => {
  it("bumps the dev-sprint def version past v11", () => {
    expect(loadDevSprint().version).toBeGreaterThanOrEqual(12);
  });

  for (const stateId of CONVERGE_STATES) {
    it(`${stateId} converge → done carries requires_implementation_child (with the INF-504 gates)`, () => {
      const def = loadDevSprint();
      const t = tx(def, stateId, "converge");
      expect(t.to).toBe("done");
      expect(t.requires_implementation_child).toBe(true);
      // The INF-504 gates remain — the impl-child gate is additive, not a replacement.
      expect(t.requires_children_terminal).toBe(true);
      expect(t.requires_comment).toBe(true);
    });
  }
});

// ── AC2–AC6: runtime gate behaviour through checkWorkflowRules ────────────────

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

/**
 * Fetch mock dispatched on the GraphQL operation name (not call order — INF-504
 * red baselines were fooled by order-based mocks): `IssueContext` returns the
 * sprint's labels + delegate, `ParentChildren` returns the supplied child set.
 */
function makeFetch(
  labels: string[],
  delegateId: string | null,
  children: Array<{ identifier: string; labels: string[] }> | "read-fail",
): typeof globalThis.fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const body = String(init?.body ?? "");
    if (body.includes("ParentChildren")) {
      if (children === "read-fail") {
        return new Response("upstream boom", { status: 500, statusText: "Server Error" });
      }
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              children: {
                nodes: children.map((c) => ({
                  identifier: c.identifier,
                  labels: { nodes: c.labels.map((name) => ({ name })) },
                })),
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // IssueContext (labels + delegate)
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            identifier: "LIF-291",
            labels: { nodes: labels.map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
}

/** A terminal scoping/design arm — the LIF-291 shape. Terminal, but NOT an impl child. */
const doneScopeArm = (id: string, arm = "scope") => ({
  identifier: id,
  labels: [`wf:sprint-arm-${arm}`, "state:done"],
});
/** A terminal implementation child. */
const doneImplChild = (id: string) => ({ identifier: id, labels: ["wf:dev-impl", "state:done"] });
/** A terminal wf:task implementation child (ac-definition allows wf:task impl tickets). */
const doneTaskChild = (id: string) => ({ identifier: id, labels: ["wf:task", "state:done"] });

describe("INF-758 AC2–AC6: converge implementation-child runtime gate", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-758-impl-child-"));

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // Real dev-sprint def (so the converge transitions under test are loaded) in
    // an isolated defs dir the registry reads from.
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

  // caller = current delegate (astrid), comment provided (converge requires one).
  const converge = (fetchImpl: typeof globalThis.fetch) => {
    globalThis.fetch = fetchImpl;
    return checkWorkflowRules(
      "converge", "LIF-291", "Bearer tok", "astrid",
      /* target */ null, /* callerLinearUserId */ ASTRID_UUID,
      /* artifactRef */ null, /* breakGlassOverride */ false,
      /* isMetaIntent */ false, /* hasComment */ true,
    );
  };

  const stateLabel = (s: string) => `state:${s}`;

  it("AC2: BLOCKS converge when all children are terminal scoping/design arms (LIF-291)", async () => {
    // The exact LIF-291 shape: three scope/UX/design arms, all Done, no impl child.
    const result = await converge(
      makeFetch(
        ["wf:dev-sprint", stateLabel("ac-definition")],
        ASTRID_UUID,
        [doneScopeArm("LIF-292", "scope"), doneScopeArm("LIF-293", "ux"), doneScopeArm("LIF-294", "design")],
      ),
    );
    expect(result).not.toBeNull();
    expect(result).toMatch(/without a completed implementation child|implementation ticket/i);
  });

  it("AC3: ALLOWS converge when a terminal wf:dev-impl child exists (mixed with scope arms)", async () => {
    const result = await converge(
      makeFetch(
        ["wf:dev-sprint", stateLabel("ac-definition")],
        ASTRID_UUID,
        [doneScopeArm("LIF-292"), doneImplChild("LIF-297")],
      ),
    );
    expect(result).toBeNull();
  });

  it("AC4: a terminal wf:task child also satisfies the implementation-child gate", async () => {
    const result = await converge(
      makeFetch(
        ["wf:dev-sprint", stateLabel("ac-definition")],
        ASTRID_UUID,
        [doneTaskChild("LIF-298")],
      ),
    );
    expect(result).toBeNull();
  });

  it("AC5: the same gate governs spawn-impl and managing-impl converge edges", async () => {
    for (const s of ["spawn-impl", "managing-impl"]) {
      // arms-only → blocked
      const blocked = await converge(
        makeFetch(["wf:dev-sprint", stateLabel(s)], ASTRID_UUID, [doneScopeArm("LIF-292")]),
      );
      expect(blocked).not.toBeNull();
      expect(blocked).toMatch(/without a completed implementation child|implementation ticket/i);

      // impl child present → allowed
      const allowed = await converge(
        makeFetch(["wf:dev-sprint", stateLabel(s)], ASTRID_UUID, [doneImplChild("LIF-297")]),
      );
      expect(allowed).toBeNull();
    }
  });
});
