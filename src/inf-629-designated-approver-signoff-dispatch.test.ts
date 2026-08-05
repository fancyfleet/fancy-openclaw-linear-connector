/**
 * INF-629 — designated-approver signoff wake dispatch for sprint-spawner gates.
 *
 * Regression intent:
 * - A non-holder hitting sprint-spawner determining-scope signoff gates must
 *   queue/wake Ai as the sprint:signoff designated approver, not stop at an
 *   unactionable "approver must run it directly" message.
 * - The routing guard must not auto-correct that designated-approver wake back
 *   to the state's steward owner.
 * - Ai may fire the transition without being delegate, while the steward/author
 *   still cannot self-bless.
 * - Duplicate signoff wakes are bounded without suppressing the first corrected
 *   Ai route.
 * - Stuck diagnostics distinguish "awaiting designated approver signoff" from
 *   ordinary transition-stuck guidance.
 * - The live sprint-spawner fixture keeps both signoff edges configured.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { checkRoleGuardEnforced } from "./routing-guard.js";
import { DispatchIdempotencyStore } from "./store/dispatch-idempotency-store.js";
import { DispatchCircuitBreaker } from "./dispatch-circuit-breaker.js";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: sprint:signoff

containers:
  - id: workflow
    grants: [linear:transition, workflow:break-glass]
  - id: ai
    grants: [linear:transition, sprint:signoff]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: ai
    container: ai
    fills_roles: []
  - id: charles
    container: dev
    fills_roles: [dev]
`;

const SPRINT_SPAWNER_YAML = `
id: sprint-spawner
version: 629
archetype: continuous-loop
entry_state: evaluating

break_glass:
  command: escape
  to: evaluating
  owner_role: steward

states:
  - id: evaluating
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: proceed
        to: determining-scope

  - id: determining-scope
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: propose-brief
        to: spawning-scope
        generic: continue
        requires_capability: sprint:signoff
        designated_approver: true
      - command: deliver-direct
        to: releasing
        requires_capability: sprint:signoff
        designated_approver: true

  - id: spawning-scope
    owner_role: engine
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: scoping

  - id: scoping
    owner_role: steward
    kind: normal
    native_state: managing
    barrier: true
    transitions:
      - command: launch
        to: launching

  - id: launching
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: spawn
        to: releasing
        generic: continue

  - id: releasing
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: release
        to: evaluating
`;

const ASTRID_UUID = "astrid-linear-uuid";
const AI_UUID = "ai-linear-uuid";
const TICKET = "INF-629-SPRINT-SPAWNER";

function makeLinearFetch(
  originalFetch: typeof globalThis.fetch,
  delegateId: string | null = ASTRID_UUID,
): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("api.linear.app")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (
        bodyText.includes("IssueContext") ||
        bodyText.includes("IssueLabels") ||
        bodyText.includes("CurrentDelegate")
      ) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "linear-issue-uuid",
              identifier: TICKET,
              labels: {
                nodes: [
                  { name: "wf:sprint-spawner" },
                  { name: "state:determining-scope" },
                ],
              },
              delegate: delegateId ? { id: delegateId } : null,
              state: { name: "Doing", type: "started" },
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return originalFetch(url, init);
  }) as typeof globalThis.fetch;
}

describe("INF-629 signoff wake dispatch mechanics", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalWorkflowDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-629-signoff-"));
    const workflowFile = path.join(tmpDir, "sprint-spawner.yaml");
    const policyFile = path.join(tmpDir, "capability-policy.yaml");
    fs.writeFileSync(workflowFile, SPRINT_SPAWNER_YAML, "utf8");
    fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetWorkflowCache();
    resetPolicyCache();
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeLinearFetch(originalFetch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalWorkflowDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = originalWorkflowDefsDir;
    else delete process.env.WORKFLOW_DEFS_DIR;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    resetWorkflowCache();
    resetPolicyCache();
  });

  it.each(["propose-brief", "deliver-direct"])(
    "AC1: steward/delegate non-holder %s queues Ai as sprint:signoff designated approver",
    async (intent) => {
      const result = await checkWorkflowRules(intent, TICKET, "Bearer tok", "astrid", null, ASTRID_UUID);

      expect(result).not.toBeNull();
      expect(result).toMatch(/designated approver/i);
      expect(result).toMatch(/\bai\b/i);
      expect(result).toMatch(/queued|wake|dispatch/i);
      expect(result).not.toMatch(/must run .*directly/i);
      expect(result).not.toMatch(/dead[- ]?end|handoff-work/i);
    },
  );

  it("AC2: routing guard treats Ai as legal for sprint-spawner determining-scope signoff wake", async () => {
    const result = await checkRoleGuardEnforced("ai", [
      "wf:sprint-spawner",
      "state:determining-scope",
    ]);

    expect(result.blocked).toBe(false);
    expect(result.correctedTo).toBeUndefined();
    expect(result.legalBodies ?? []).not.toContain("astrid");
  });

  it("AC3: Ai can fire signoff directly without being the steward delegate", async () => {
    const result = await checkWorkflowRules("propose-brief", TICKET, "Bearer tok", "ai", null, AI_UUID);
    expect(result).toBeNull();
  });

  it("AC3: steward author still cannot self-bless the sprint signoff gate", async () => {
    const result = await checkWorkflowRules("propose-brief", TICKET, "Bearer tok", "astrid", null, ASTRID_UUID);
    expect(result).not.toBeNull();
    expect(result).toMatch(/sprint:signoff|designated approver/i);
  });

  it("AC4: duplicate Ai signoff wake is bounded, but first corrected route is admitted", () => {
    const dbPath = path.join(tmpDir, "dispatch-idempotency.db");
    const store = new DispatchIdempotencyStore(dbPath);
    const t0 = "2026-07-25T12:00:00.000Z";
    const t1 = "2026-07-25T12:00:01.000Z";

    store.checkAndRecord(`linear-${TICKET}`, "state:determining-scope", "astrid", t0, { nowMs: Date.parse(t0) });

    const firstAiSignoff = store.checkAndRecord(
      `linear-${TICKET}`,
      "state:determining-scope:sprint:signoff",
      "ai",
      t1,
      { nowMs: Date.parse(t1), delegateChanged: true },
    );
    const duplicateAiSignoff = store.checkAndRecord(
      `linear-${TICKET}`,
      "state:determining-scope:sprint:signoff",
      "ai",
      t1,
      { nowMs: Date.parse(t1) + 1_000, delegateChanged: true },
    );

    expect(firstAiSignoff).toMatchObject({ suppressed: false, stale: false });
    expect(duplicateAiSignoff).toMatchObject({ suppressed: true, stale: false });
    store.close();
  });

  it("AC5: diagnostics report awaiting designated approver signoff instead of ordinary transition-stuck escape guidance", () => {
    const breaker = new DispatchCircuitBreaker({ maxWakesBeforeAlert: 2 });
    const labels = [
      "wf:sprint-spawner",
      "state:determining-scope",
      "designated-approver:ai",
      "requires:sprint:signoff",
    ];

    breaker.recordWake(`linear-${TICKET}`, labels);
    breaker.recordWake(`linear-${TICKET}`, labels);
    const diagnostic = breaker.evaluate(`linear-${TICKET}`);

    expect(diagnostic.shouldAlert).toBe(false);
    expect(diagnostic.reason).toMatch(/awaiting designated approver signoff/i);
    expect(diagnostic.reason).toMatch(/\bai\b/i);
    expect(diagnostic.reason).not.toMatch(/transition-stuck|escape/i);
  });
});

describe("INF-629 live sprint-spawner configuration regression", () => {
  it("AC6: registered sprint-spawner determining-scope uses sprint:signoff designated approver on both signoff exits", () => {
    const registeredDefPath = path.join(process.cwd(), "src", "registered-defs", "sprint-spawner.yaml");
    const def = yaml.load(fs.readFileSync(registeredDefPath, "utf8")) as {
      id: string;
      states: Array<{
        id: string;
        transitions?: Array<{
          command: string;
          requires_capability?: string;
          designated_approver?: boolean;
        }>;
      }>;
    };

    expect(def.id).toBe("sprint-spawner");
    const determiningScope = def.states.find((state) => state.id === "determining-scope");
    expect(determiningScope).toBeDefined();

    for (const command of ["propose-brief", "deliver-direct"]) {
      const transition = determiningScope?.transitions?.find((tx) => tx.command === command);
      expect(transition).toMatchObject({
        requires_capability: "sprint:signoff",
        designated_approver: true,
      });
    }
  });
});
