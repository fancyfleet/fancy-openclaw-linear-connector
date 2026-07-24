/**
 * INF-528 — dev-sprint governed terminal edge from `spawn-impl`.
 *
 * Residual coverage hole in INF-504. INF-504 (v10) added `converge` → done from
 * `ac-definition` and `managing-impl`, but NOT from `spawn-impl`. A sprint whose
 * impl children were already spawned + terminal (shipped out-of-band) can get
 * wedged at `spawn-impl`: the only forward move is `spawn`, which dedups to a
 * no-op once children exist (v7) and never advances, and the only other move is
 * break-glass `escape` (loops to intake, re-spawning arms). So `converge → done`
 * was unreachable from `spawn-impl`. This extends the same governed edge —
 * children-terminal + steward attestation comment — to originate from
 * `spawn-impl` too. Live victim: LSO-1 (children LSO-5/6/7 all Done).
 *
 * AC map:
 *  - AC1: `converge` edge exists on spawn-impl, → `done`, carrying
 *         requires_children_terminal + requires_comment.
 *  - AC2: it terminates at `done` (satisfies_parent_barrier), not `cancelled`.
 *  - AC3: the runtime gate BLOCKS converge from spawn-impl while any child is
 *         non-terminal.
 *  - AC4: the runtime gate BLOCKS converge from spawn-impl on a childless sprint.
 *  - AC5: the runtime gate FAILS CLOSED when the child set is unreadable.
 *  - AC6: the runtime gate ALLOWS converge from spawn-impl when every child is
 *         terminal.
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

// ── AC1 + AC2: structural (def-shape) ───────────────────────────────────────

describe("INF-528 AC1: converge edge shape on spawn-impl", () => {
  it("bumps the dev-sprint def version past v10", () => {
    expect(loadDevSprint().version).toBeGreaterThanOrEqual(11);
  });

  it("spawn-impl has a converge edge → done, gated on children-terminal + comment", () => {
    const def = loadDevSprint();
    const t = tx(def, "spawn-impl", "converge");
    expect(t.to).toBe("done");
    expect(t.requires_children_terminal).toBe(true);
    expect(t.requires_comment).toBe(true);
  });

  it("preserves the existing spawn → managing-impl edge (converge is additive)", () => {
    const def = loadDevSprint();
    expect(tx(def, "spawn-impl", "spawn").to).toBe("managing-impl");
  });
});

describe("INF-528 AC2: converge from spawn-impl terminates at done (not cancelled)", () => {
  it("converge does NOT route to the did-not-complete cancelled terminal", () => {
    const def = loadDevSprint();
    expect(tx(def, "spawn-impl", "converge").to).not.toBe("cancelled");
  });
});

// ── AC3–AC6: runtime gate behaviour through checkWorkflowRules ───────────────

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
 * Fetch mock that dispatches on the GraphQL operation name (not call order):
 * the `IssueContext` query returns the sprint's labels + delegate, the
 * `ParentChildren` query returns the supplied child set.
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
            identifier: "LSO-1",
            labels: { nodes: labels.map((name) => ({ name })) },
            delegate: delegateId ? { id: delegateId } : null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
}

/** A terminal child carries a workflow terminal state label. */
const doneChild = (id: string) => ({ identifier: id, labels: ["wf:dev-impl", "state:done"] });
/** A non-terminal child sits mid-workflow. */
const liveChild = (id: string) => ({ identifier: id, labels: ["wf:dev-impl", "state:implementation"] });

describe("INF-528 AC3–AC6: converge-from-spawn-impl children-terminal runtime gate", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-528-converge-"));

    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // Real dev-sprint def (so the converge transition under test is loaded) in
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
  const converge = (fetchImpl: typeof globalThis.fetch, issueId = "LSO-1") => {
    globalThis.fetch = fetchImpl;
    return checkWorkflowRules(
      "converge", issueId, "Bearer tok", "astrid",
      /* target */ null, /* callerLinearUserId */ ASTRID_UUID,
      /* artifactRef */ null, /* breakGlassOverride */ false,
      /* isMetaIntent */ false, /* hasComment */ true,
    );
  };

  // The sprint is wedged in spawn-impl — the state INF-504 left uncovered.
  const SPAWN_IMPL_LABELS = ["wf:dev-sprint", "state:spawn-impl"];

  it("AC3: blocks while a child is still in flight", async () => {
    const result = await converge(
      makeFetch(SPAWN_IMPL_LABELS, ASTRID_UUID, [doneChild("LSO-5"), liveChild("LSO-6")]),
    );
    expect(result).not.toBeNull();
    expect(result).toMatch(/acceptance walk is not yet satisfied|still in flight/i);
  });

  it("AC4: blocks a childless (vacuous) sprint", async () => {
    const result = await converge(makeFetch(SPAWN_IMPL_LABELS, ASTRID_UUID, []));
    expect(result).not.toBeNull();
    expect(result).toMatch(/no children/i);
  });

  it("AC5: fails closed when the child set is unreadable", async () => {
    const result = await converge(makeFetch(SPAWN_IMPL_LABELS, ASTRID_UUID, "read-fail"));
    expect(result).not.toBeNull();
    expect(result).toMatch(/unable to read the ticket's children/i);
  });

  it("AC6: allows converge from spawn-impl when every child is terminal (LSO-1 walk)", async () => {
    // LSO-1's actual shape: impl children LSO-5/6/7 all Done.
    const result = await converge(
      makeFetch(SPAWN_IMPL_LABELS, ASTRID_UUID, [
        doneChild("LSO-5"),
        doneChild("LSO-6"),
        doneChild("LSO-7"),
      ]),
    );
    expect(result).toBeNull();
  });
});
