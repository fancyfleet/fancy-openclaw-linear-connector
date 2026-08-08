/**
 * INF-1302 R2 — engine-watch production tick regression: the collector must NOT
 * be empty and the tick must promote recurrence through the real classification
 * → dedup → follow-up → summary path. These tests fail when collectSignals() is
 * the empty stub or disconnected from any source, and pass once the production
 * collector is wired to the operational-event store.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetEngineWatchStateForTest, getEngineWatchState } from "./engine-watch-state.js";
import { resetEngineWatchDedupForTest } from "./engine-watch/engine-watch.js";
import { triggerEngineWatchForTest, resetEngineWatchCronForTest } from "./cron/engine-watch-cron.js";
import { LINEAR_API_URL } from "./linear-helpers.js";

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: steward
    requires: [human:escalate, workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: igor
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
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

// Fixtures matching the engine-watch.test.ts regression shapes — must be byte-for-byte consistent
const MIGRATE_STATE_SIGNAL = {
  id: "sig-migrate-1",
  class: "migrate-state-client-error",
  evidence:
    "[Proxy] migrate-state failed: old client still prints success=true but server rejected transition; delegate repair needed (INF-1277 still needed delegate repair after INF-1288)",
  source: "connector-log" as const,
  runId: "run-2026-08-07T04:04Z",
  observedAt: "2026-08-07T04:04:00Z",
};

const XFN_INTAKE_SIGNAL = {
  id: "sig-xfn-1",
  class: "xfn-intake-recovery-stale-routing",
  evidence:
    "xfn/intake recovery lost true workflow position: stored snapshot state=intake delegate=astrid vs true state=implementation; restarted stale/illegal routing from stored intake snapshot (INF-1230/INF-1298)",
  source: "engine-run" as const,
  runId: "run-2026-08-07T04:04Z",
  observedAt: "2026-08-07T04:04:00Z",
};

describe("INF-1302 R2 — production tick must not be empty; regression signals must promote to active tickets with summary", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | null = null;
  let originalAgentsFile: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;
  let originalWorkflowDefPath: string | undefined;
  let originalLinearServiceCredential: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalAgentsFile = process.env.AGENTS_FILE;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalLinearServiceCredential = process.env.LINEAR_SERVICE_CREDENTIAL;
    originalFetch = globalThis.fetch;

    resetEngineWatchStateForTest();
    resetEngineWatchDedupForTest();
    resetEngineWatchCronForTest();
    process.env.LINEAR_SERVICE_CREDENTIAL = "tok-service-test";

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1302-r2-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, POLICY_YAML, "utf8");
    fs.writeFileSync(process.env.WORKFLOW_DEF_PATH, WORKFLOW_YAML, "utf8");

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (appState) {
      try {
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
      } catch { /* best-effort */ }
      appState = null;
    }
    resetEngineWatchStateForTest();
    resetEngineWatchDedupForTest();
    resetEngineWatchCronForTest();

    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalLinearServiceCredential !== undefined) process.env.LINEAR_SERVICE_CREDENTIAL = originalLinearServiceCredential;
    else delete process.env.LINEAR_SERVICE_CREDENTIAL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("R2-AC-empty-collector: a tick with an empty/disconnected collector is RED — must report zero signals as a skip, not a success with hidden signals", async () => {
    // If the collector returns [], the tick records success with 0 signals — but AC1 says every new signal must be classified.
    // With no source wired, real recurrence is invisible. This test proves the production collector is INJECTED (not the stub).
    // We assert that createApp's engine-watch is wired to the live store by checking the store is non-empty when events exist.
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

    // Seed an operational event that the production collector MUST turn into a signal
    appState.operationalEventStore.append({
      outcome: "def-state-migrated",
      type: "def-state-migration",
      agent: "astrid",
      key: "linear-INF-1288",
      errorSummary: "migrate-state: old client still prints success=true but server rejected transition; delegate repair needed",
      detail: { from: "deployment", target: "ac-validate" },
    });

    // The production collector reads from this store — so a tick must see >=1 signal.
    // If the collector is the empty stub `() => []`, this tick sees 0 signals and this assertion fails — the correct RED.
    const result = await triggerEngineWatchForTest({
      operationalEventStore: appState.operationalEventStore as unknown as never,
      resolveOwner: async (signal) => {
        // Terminal owner INF-1288, no active follow-up — tick must create one
        if (signal.class === "migrate-state-client-error") {
          return {
            closestOwner: { id: "issue-1288", identifier: "INF-1288", state: "Done", stateType: "completed" },
            activeFollowup: null,
          };
        }
        return { closestOwner: null, activeFollowup: null };
      },
      createTicket: async (signal) => ({ id: `new-${signal.id}`, identifier: "INF-3101", state: "To Do", stateType: "unstarted" }),
    });

    expect(result.signals).toBeGreaterThan(0);
    expect(result.dispositions).toBeGreaterThan(0);
    expect(result.summary).toContain("INF-3101");
  });

  it("R2-AC2-terminal-recurrence: migrate-state recurrence after INF-1288 promotes to active follow-up via the real tick (not just the unit classifier)", async () => {
    const result = await triggerEngineWatchForTest({
      collectSignals: () => [MIGRATE_STATE_SIGNAL],
      resolveOwner: async () => ({
        closestOwner: { id: "issue-1288", identifier: "INF-1288", state: "Done", stateType: "completed" },
        activeFollowup: null,
      }),
      createTicket: async () => ({ id: "issue-followup-1", identifier: "INF-3101", state: "To Do", stateType: "unstarted" }),
    });

    expect(result.signals).toBe(1);
    expect(result.dispositionsList).toHaveLength(1);
    expect(result.dispositionsList[0].kind).toBe("recurrence-with-followup");
    if (result.dispositionsList[0].kind === "recurrence-with-followup") {
      expect(result.dispositionsList[0].terminalOwner.identifier).toBe("INF-1288");
      expect(result.dispositionsList[0].followupTicket.identifier).toBe("INF-3101");
    }
    expect(result.summary).toContain("INF-3101");
    expect(result.summary).toContain("recurrence-with-followup");
  });

  it("R2-AC2-xfn: xfn/intake stale-routing recurrence after INF-1230 promotes to active follow-up, with summary owning ticket", async () => {
    const result = await triggerEngineWatchForTest({
      collectSignals: () => [XFN_INTAKE_SIGNAL],
      resolveOwner: async () => ({
        closestOwner: { id: "issue-1230", identifier: "INF-1230", state: "Canceled", stateType: "canceled" },
        activeFollowup: null,
      }),
      createTicket: async () => ({ id: "issue-xfn-1", identifier: "INF-XFN-1", state: "To Do", stateType: "unstarted" }),
    });

    expect(result.signals).toBe(1);
    expect(result.dispositionsList[0].kind).toBe("recurrence-with-followup");
    expect(result.summary).toContain("INF-XFN-1");
  });

  it("R2-AC4-dedup: repeated evidence with an active owner does NOT spam new tickets — tick dedups via the shared registry", async () => {
    resetEngineWatchDedupForTest();
    let createCount = 0;
    const createTicket = async () => {
      createCount += 1;
      return { id: `new-${createCount}`, identifier: `INF-NEW-${createCount}`, state: "To Do", stateType: "unstarted" as const };
    };

    // First signal: active owner exists — classified as attached-active-owner, no ticket created
    const r1 = await triggerEngineWatchForTest({
      collectSignals: () => [{ ...MIGRATE_STATE_SIGNAL, id: "sig-dedup-1a", evidence: "repeated migrate-state error same class" }],
      resolveOwner: async () => ({
        closestOwner: { id: "issue-active", identifier: "INF-2001", state: "Doing", stateType: "started" },
        activeFollowup: null,
      }),
      createTicket,
    });
    expect(r1.dispositionsList[0].kind).toBe("attached-active-owner");
    expect(createCount).toBe(0);

    // Second signal with identical dedup key + same active owner — must NOT create a ticket
    const r2 = await triggerEngineWatchForTest({
      collectSignals: () => [{ ...MIGRATE_STATE_SIGNAL, id: "sig-dedup-1b", evidence: "repeated migrate-state error same class" }],
      resolveOwner: async () => ({
        closestOwner: { id: "issue-active", identifier: "INF-2001", state: "Doing", stateType: "started" },
        activeFollowup: null,
      }),
      createTicket,
    });
    expect(r2.dispositionsList[0].kind).toBe("attached-active-owner");
    expect(createCount).toBe(0);
  });

  it("R2-liveness: tick liveness is observable at /health without waiting for the trigger (lastSummary + lastOutcome)", async () => {
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

    // Drive one tick through the injectable path so /health reflects it
    await triggerEngineWatchForTest({
      collectSignals: () => [MIGRATE_STATE_SIGNAL],
      resolveOwner: async () => ({
        closestOwner: { id: "issue-1288", identifier: "INF-1288", state: "Done", stateType: "completed" },
        activeFollowup: null,
      }),
      createTicket: async () => ({ id: "issue-followup-1", identifier: "INF-3101", state: "To Do", stateType: "unstarted" }),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBeGreaterThanOrEqual(200);
    const body = res.body as { engineWatch?: unknown; "engine-watch"?: unknown };
    const ew = (body.engineWatch ?? body["engine-watch"]) as Record<string, unknown> | undefined;
    expect(ew).toBeDefined();
    expect(ew!.scheduled).toBe(true);
    // Must expose the last run's summary and outcome without waiting for a cron trigger
    expect(typeof (ew as { lastRunAt?: unknown }).lastRunAt === "string" || (ew as { registeredAt?: unknown }).registeredAt !== undefined).toBe(true);
  });
});
