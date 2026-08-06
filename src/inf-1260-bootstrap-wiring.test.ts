/**
 * INF-1260 AC9 (AI-1808 bootstrap-wiring guard): every background/event-driven
 * component this ticket touches (the divergence detector, the commitment-gate
 * comment listener, and any lease-recovery sweep) must be registered at
 * server bootstrap — reachable from the production entry point (`createApp`
 * in src/index.ts) — proven by an INTEGRATION TEST that boots the entry point
 * and asserts registration. A module-level unit test does not satisfy this
 * (AI-1808's own lesson: AI-1773/AI-1775 shipped fully unit-tested background
 * drivers that were never wired into bootstrap).
 *
 * Chosen component for this AC: a dispatch-lease-recovery sweep implied by
 * AC2 (zombie/stale dispatch leases must be detected + recovered, not just
 * silently expire opportunistically inside reconciliation-wake.ts — see
 * src/inf-1260-zombie-lease-submit.test.ts). Today there is NO dedicated
 * lease-recovery cron registered anywhere in src/index.ts — pruning is only
 * opportunistic (src/bag/reconciliation-wake.ts:78) — so it does not appear
 * in the `crons` registry surfaced at /health (src/cron/registry.ts).
 *
 * This test boots the REAL `createApp()` entry point and asserts a
 * lease-recovery driver is registered and observable at /health without
 * waiting for a live trigger. It is RED today because no such driver exists.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
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

const WORKFLOW_YAML = `
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
        to: implementation
  - id: implementation
    owner_role: steward
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: done
  - id: done
    kind: terminal
    native_state: done
    transitions: []
`;

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("INF-1260 AC9 (bootstrap wiring): a dispatch-lease-recovery driver must be registered at the production entry point", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalAgentsFile: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;
  let originalWorkflowDefPath: string | undefined;
  let originalLinearServiceCredential: string | undefined;

  beforeEach(() => {
    originalAgentsFile = process.env.AGENTS_FILE;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalLinearServiceCredential = process.env.LINEAR_SERVICE_CREDENTIAL;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-bootstrap-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.LINEAR_SERVICE_CREDENTIAL = "tok-service";
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-leases.db"),
      dispatchInFlightDbPath: path.join(dir, "dispatch-inflight.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
      livenessDispatchDbPath: path.join(dir, "liveness-dispatches.db"),
      deadLetterQueueDbPath: path.join(dir, "dead-letter-queue.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
    });
  });

  afterEach(() => {
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalLinearServiceCredential !== undefined) process.env.LINEAR_SERVICE_CREDENTIAL = originalLinearServiceCredential;
    else delete process.env.LINEAR_SERVICE_CREDENTIAL;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    appState.deadLetterQueue.close();
    appState.managingStateStore.close();
    appState.mutationAuditStore.close();
    appState.enrolledTicketsStore.close();
    appState.idempotencyStore.close();
    appState.dispatchLeaseStore.close();
    appState.dispatchInFlightStore.close();
    appState.livenessDispatchStore.close();
    appState.proposalStore.close();
    appState.dispatchDeliveryScheduler.stop();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC9: /health.crons includes a registered dispatch-lease-recovery driver — proven at the real entry point, not a unit test", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);

    const crons = (res.body as { crons?: Array<{ id?: string; name?: string }> }).crons ?? [];
    // Desired: a lease-recovery driver is registered at bootstrap (AI-1810
    // convention — registerCron() is called from inside its own
    // register*Cron() function, so an entry here proves createApp() actually
    // wired it, not just that some module defines it). Today no such driver
    // exists anywhere in src/index.ts — RED.
    const leaseRecoveryCron = crons.find((c) => /lease.*recover|recover.*lease/i.test(`${c.id ?? ""} ${c.name ?? ""}`));
    expect(leaseRecoveryCron).toBeDefined();
  });
});
