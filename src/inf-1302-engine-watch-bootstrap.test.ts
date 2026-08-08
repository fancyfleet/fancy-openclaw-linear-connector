/**
 * INF-1302 AC6 + AC7 — Engine-watch bootstrap wiring + liveness (AI-1808 criterion)
 *
 * AC6: The engine-watch component is registered at server bootstrap (reachable
 * from the production entry point, e.g. index.ts), proven by an integration
 * test that boots the entry point and asserts registration. A module-level
 * unit test does NOT satisfy this.
 *
 * AC7: Liveness is observable at ac-validate without waiting for the
 * component's trigger condition: a /health field, startup log line, or
 * registry entry showing the component is scheduled/subscribed.
 *
 * REQUIRED pattern (per ticket standards): use request(supertest) against the
 * Express app returned by createApp() from src/index.ts, with isolated temp DB
 * paths via CreateAppOptions and minimal env (AGENTS_FILE, CAPABILITY_POLICY_PATH,
 * WORKFLOW_DEF_PATH, LINEAR_SERVICE_CREDENTIAL). Assert /health.crons contains
 * engine-watch OR a dedicated health field engineWatch/engine-watch.
 *
 * RED until engine-watch is wired at bootstrap and /health exposes liveness.
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

describe("INF-1302 AC6: engine-watch is registered at the production entry point", () => {
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

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1302-bootstrap-"));
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
    } catch { /* best-effort teardown */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC6: /health.crons includes a registered engine-watch driver — proven at the real entry point, not a unit test", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);

    const body = res.body as {
      crons?: Array<{ id?: string; name?: string }>;
      engineWatch?: unknown;
      "engine-watch"?: unknown;
    };

    // Primary: engine-watch appears in the crons registry (AI-1810 convention —
    // registerCron() is called from inside register*EngineWatch* so an entry here
    // proves createApp() actually wired it, not just that a module defines it).
    // Fallback: a dedicated top-level health field (engineWatch / engine-watch).
    // Today NO such driver is wired in src/index.ts — RED.
    const crons = body.crons ?? [];
    const engineWatchCron = crons.find((c) =>
      /engine.?watch/i.test(`${c.id ?? ""} ${c.name ?? ""}`),
    );
    const hasDedicatedField = body.engineWatch !== undefined || body["engine-watch"] !== undefined;

    expect(engineWatchCron !== undefined || hasDedicatedField).toBe(true);
  });

  it("AC6: createApp() boots and is reachable via /health (entry point sanity)", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
    expect(res.body).toBeDefined();
    expect(typeof res.body).toBe("object");
  });
});

describe("INF-1302 AC7: engine-watch liveness observable without waiting for trigger", () => {
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

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1302-ac7-"));
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
    } catch { /* best-effort teardown */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC7: /health exposes an engine-watch liveness field showing scheduled/subscribed state without waiting for a trigger", async () => {
    const res = await request(appState.app).get("/health");

    const body = res.body as Record<string, unknown>;

    // Implementer may satisfy AC7 via any of:
    // - top-level engineWatch / engine-watch / engine_watch health field
    // - engine-watch entry in body.crons with registeredAt/lastRunAt
    // - equivalent dedicated field inside a health sub-object
    // The key is that it is observable immediately after boot, not after the
    // component's run cadence fires. Today no such field exists — RED.

    const hasTopLevelField =
      body.engineWatch !== undefined ||
      body["engine-watch"] !== undefined ||
      body.engine_watch !== undefined;

    const crons = (body.crons as Array<{ id?: string; name?: string; registeredAt?: string; schedule?: string }> | undefined) ?? [];
    const cronShowsScheduled = crons.some(
      (c) => /engine.?watch/i.test(`${c.id ?? ""} ${c.name ?? ""}`) && typeof c.registeredAt === "string",
    );

    // Also accept nested liveness like body.engineWatchState or body.health?.engineWatch
    const hasNestedField =
      body.engineWatchState !== undefined ||
      (body.health !== undefined &&
        typeof body.health === "object" &&
        body.health !== null &&
        (((body.health as Record<string, unknown>)["engineWatch"] !== undefined) ||
          ((body.health as Record<string, unknown>)["engine-watch"] !== undefined)));

    expect(hasTopLevelField || cronShowsScheduled || hasNestedField).toBe(true);
  });

  it("AC7: engine-watch liveness indicates scheduled or subscribed state (not just present but truthy)", async () => {
    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;

    const engineWatchField =
      (body.engineWatch as Record<string, unknown> | undefined) ??
      (body["engine-watch"] as Record<string, unknown> | undefined) ??
      (body.engine_watch as Record<string, unknown> | undefined);

    const crons = (body.crons as Array<{ id?: string; name?: string; schedule?: string }> | undefined) ?? [];
    const engineCron = crons.find((c) => /engine.?watch/i.test(`${c.id ?? ""} ${c.name ?? ""}`));

    // If a dedicated field exists, it must show scheduled/subscribed/active truthy
    if (engineWatchField !== undefined) {
      const asRecord = typeof engineWatchField === "object" && engineWatchField !== null
        ? (engineWatchField as Record<string, unknown>)
        : null;
      if (asRecord !== null) {
        const scheduled =
          asRecord.scheduled === true ||
          asRecord.subscribed === true ||
          asRecord.active === true ||
          asRecord.registered === true ||
          typeof asRecord.schedule === "string" ||
          typeof asRecord.registeredAt === "string";
        expect(scheduled).toBe(true);
      } else {
        // Primitive truthy field also counts as liveness (e.g. engineWatch: true)
        expect(Boolean(engineWatchField)).toBe(true);
      }
    } else {
      // Fallback: crons registry must show the engine-watch driver
      expect(engineCron).toBeDefined();
    }
  });
});
