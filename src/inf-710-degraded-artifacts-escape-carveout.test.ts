/**
 * INF-710 — Deploy gate must not block its own escape/escalate/needs-human edge.
 *
 * Structural defect: the config-health FAIL-CLOSED gate (Phase 6.5 / §16.0) runs
 * before transition resolution and short-circuits EVERY intent when config
 * artifacts are degraded — including the escape/escalate/needs-human recovery
 * edges. On the live wedge (INF-694, deploy state), that produced a
 * no-terminal-path deadlock: the owner could not advance, force, escalate, or
 * hand to a human; only an out-of-band break-glass steward could move it.
 *
 * Fix: carve escalation/escape/needs-human out of the degraded-artifacts
 * predicate so a blocked owner always has a legal path to a human/steward, even
 * when the forward deploy move is (correctly) refused.
 *
 * Behaviour-level ACs (per the ticket):
 *   AC1: with config forced degraded, `continue` (forward) still refuses with the
 *        "config artifacts are degraded" block.
 *   AC2: with config forced degraded, `escape` (break-glass, by the delegate)
 *        succeeds — it is NOT swallowed by the degraded-artifacts gate.
 *   AC3: `escalate` and `needs-human` are NOT swallowed by the degraded-artifacts
 *        gate (they reach their own downstream legality checks, never the
 *        config-health short-circuit).
 *
 * Red baseline: before the carve-out, AC2/AC3 fail (every recovery edge returns
 * the "config artifacts are degraded" block). AC1 passes both before and after —
 * it guards against over-carving (the forward move must still refuse).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  checkWorkflowRules,
  resetWorkflowCache,
  resetNativeStateCache,
  isConfigHealthExemptIntent,
  type WorkflowDef,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { resetConfigHealth, recordFailure, isHealthy } from "./config-health.js";
import { clearImplementerStore } from "./implementer-store.js";
import { clearArtifactStore } from "./artifact-store.js";

const DEGRADED_MSG = "config artifacts are degraded";

// A minimal dev-impl-shaped workflow whose `deploy` state offers a forward move
// (`continue`), an `escalate` recovery move, and the implicit break-glass
// `escape` edge — mirroring the live INF-694 topology.
const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: intake
  owner_role: steward

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: deploy
        assign: { mode: required }

  - id: deploy
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done
        assign: { mode: auto }
      - command: escalate
        to: escalated
        assign: { mode: auto }
      - command: needs-human
        to: escalated

  - id: escalated
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: continue
        to: done

  - id: done
    kind: terminal
    native_state: done
`;

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: deployment
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: deployment
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const TEST_AGENTS = {
  agents: [
    { name: "hanzo",  linearUserId: "hanzo-uuid",  clientId: "ha-c", clientSecret: "ha-s", accessToken: "ha-t", refreshToken: "ha-r" },
    { name: "astrid", linearUserId: "astrid-uuid", clientId: "as-c", clientSecret: "as-s", accessToken: "as-t", refreshToken: "as-r" },
  ],
};

const testDef = yaml.load(TEST_WORKFLOW_YAML) as WorkflowDef;

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid",    name: "Todo",    type: "unstarted" },
  { id: "state-doing-uuid",   name: "Doing",   type: "started" },
  { id: "state-done-uuid",    name: "Done",    type: "completed" },
  { id: "state-invalid-uuid", name: "Invalid", type: "canceled" },
];

// fetch mock: a wf:dev-impl ticket in `state:deploy` whose delegate is Hanzo.
function makeDeployFetch(delegateLinearUserId: string | null): typeof globalThis.fetch {
  const labelNames = ["wf:dev-impl", "state:deploy"];
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({ data: { issue: { attachments: { nodes: [] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("delegate")) {
      return new Response(
        JSON.stringify({ data: { issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
          delegate: delegateLinearUserId ? { id: delegateLinearUserId } : null,
        }}}),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: { issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf710-test-"));

  const policyFile = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const workflowFile = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = workflowFile;

  const agentsFile = path.join(tmpDir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify(TEST_AGENTS, null, 2), "utf8");
  process.env.AGENTS_FILE = agentsFile;
  reloadAgents();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEFS_DIR;
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  clearAcRecordStore();
  resetConfigHealth();
  clearImplementerStore();
  clearArtifactStore();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConfigHealth();
});

// Force config into a degraded state via an artifact OTHER than workflow-def, so
// the workflow registry still loads (the def itself is valid) and the recovery
// edges can reach their downstream legality checks. This models "fixtures forced
// red" at the observable gate: isConfigHealthy() === false.
function forceConfigDegraded(): void {
  recordFailure("agents", "INF-710 test: forced degraded artifact");
  expect(isHealthy()).toBe(false);
}

describe("INF-710: unit — recovery-edge exemption set", () => {
  it("exempts exactly escape, escalate, needs-human", () => {
    expect(isConfigHealthExemptIntent("escape")).toBe(true);
    expect(isConfigHealthExemptIntent("escalate")).toBe(true);
    expect(isConfigHealthExemptIntent("needs-human")).toBe(true);
  });

  it("does NOT exempt forward-progress intents", () => {
    expect(isConfigHealthExemptIntent("continue")).toBe(false);
    expect(isConfigHealthExemptIntent("force-deploy")).toBe(false);
    expect(isConfigHealthExemptIntent("deploy")).toBe(false);
    expect(isConfigHealthExemptIntent("complete")).toBe(false);
  });
});

describe("INF-710: behaviour — degraded-artifacts gate and its escape hatch", () => {
  it("AC1: forward `continue` still refuses when config is degraded (no over-carve)", async () => {
    forceConfigDegraded();
    globalThis.fetch = makeDeployFetch("hanzo-uuid");
    const result = await checkWorkflowRules(
      "continue", "issue-uuid", "Bearer tok", "hanzo", null, "hanzo-uuid",
    );
    expect(result).not.toBeNull();
    expect(result).toContain(DEGRADED_MSG);
  });

  it("AC2: `escape` by the delegate SUCCEEDS when config is degraded (no deadlock)", async () => {
    forceConfigDegraded();
    globalThis.fetch = makeDeployFetch("hanzo-uuid");
    const result = await checkWorkflowRules(
      "escape", "issue-uuid", "Bearer tok", "hanzo", null, "hanzo-uuid",
    );
    // Delegate break-glass escape returns null (allowed) — and, critically, is
    // never the degraded-artifacts block.
    expect(result).toBeNull();
  });

  it("AC3a: `escalate` is NOT swallowed by the degraded-artifacts gate", async () => {
    forceConfigDegraded();
    globalThis.fetch = makeDeployFetch("hanzo-uuid");
    const result = await checkWorkflowRules(
      "escalate", "issue-uuid", "Bearer tok", "hanzo", null, "hanzo-uuid",
    );
    // Whatever the downstream verdict, it must not be the config-health block.
    if (result !== null) expect(result).not.toContain(DEGRADED_MSG);
  });

  it("AC3b: `needs-human` is NOT swallowed by the degraded-artifacts gate", async () => {
    forceConfigDegraded();
    globalThis.fetch = makeDeployFetch("hanzo-uuid");
    const result = await checkWorkflowRules(
      "needs-human", "issue-uuid", "Bearer tok", "hanzo", null, "hanzo-uuid",
    );
    if (result !== null) expect(result).not.toContain(DEGRADED_MSG);
  });

  it("sanity: when config is HEALTHY, `continue` is not blocked by the config-health gate", async () => {
    // Not degraded — the config-health short-circuit must not fire at all.
    globalThis.fetch = makeDeployFetch("hanzo-uuid");
    const result = await checkWorkflowRules(
      "continue", "issue-uuid", "Bearer tok", "hanzo", null, "hanzo-uuid",
    );
    if (result !== null) expect(result).not.toContain(DEGRADED_MSG);
  });
});
