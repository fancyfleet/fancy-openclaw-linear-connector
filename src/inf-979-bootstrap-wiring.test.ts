/**
 * INF-979 AC4 — Bootstrap wiring + observable liveness for stale-session
 * recovery and governed redispatch re-seat behavior.
 *
 * AC4 is the AI-1808 production-wiring guard: this ticket changes
 * event-driven/background behavior, so unit tests for recoverTicket() and
 * setStateAtomic() are not enough. The recovery/re-seat path must be registered
 * from the production bootstrap reachable from index.ts, and ac-validate must
 * be able to observe that liveness without waiting for a stale session.
 *
 * This test boots the production app factory exported by index.ts and asserts
 * /health carries a dedicated liveness field proving:
 *   - the stale-session recovery driver is scheduled/subscribed; and
 *   - the governed redispatch path has the re-seat guard active.
 *
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-inf-979",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

const WORKFLOW_DEF = `
id: dev-impl
version: 1
entry_state: implementation
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions: []
  - id: done
    kind: terminal
    native_state: done
    transitions: []
  - id: escape
    kind: terminal
    native_state: invalid
    transitions: []
`;

const CAPABILITY_POLICY = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
`;

describe("INF-979 AC4: stale-session recovery/re-seat is wired at production bootstrap", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-979-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    const workflowDefFile = path.join(dir, "dev-impl.yaml");
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");
    fs.writeFileSync(workflowDefFile, WORKFLOW_DEF, "utf8");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY, "utf8");

    for (const key of [
      "AGENTS_FILE",
      "DATA_DIR",
      "WORKFLOW_DEF_PATH",
      "WORKFLOW_DEFS_DIR",
      "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
      "CAPABILITY_POLICY_PATH",
      "LINEAR_WEBHOOK_SECRET",
      "LINEAR_OAUTH_TOKEN",
      "OPENCLAW_HOOKS_URL",
      "OPENCLAW_HOOKS_TOKEN",
    ]) {
      originalEnv[key] = process.env[key];
    }

    process.env.AGENTS_FILE = agentsFile;
    process.env.DATA_DIR = path.join(dir, "data");
    process.env.WORKFLOW_DEF_PATH = workflowDefFile;
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "def-state-snapshot.json");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret";
    process.env.LINEAR_OAUTH_TOKEN = "test-linear-oauth-token";
    process.env.OPENCLAW_HOOKS_URL = "http://127.0.0.1/nonexistent-hooks";
    process.env.OPENCLAW_HOOKS_TOKEN = "test-token";

    resetConfigHealth();
    resetPolicyCache();
    resetWorkflowCache();
    reloadAgents();

    appState = createApp({
      agentQueueDbPath: path.join(dir, "queue.db"),
      bagDbPath: path.join(dir, "bag.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
  });

  afterAll(() => {
    try {
      appState.agentQueue.close();
      appState.bag.close();
      appState.sessionTracker.close();
      appState.operationalEventStore.close();
      appState.enrolledTicketsStore.close();
      appState.livenessDispatchStore.close();
      appState.watchdog.stop();
      appState.noActivityDetector.stop();
      appState.stuckDelegateDetector.stop();
      appState.managingPoller.stop();
    } catch {
      /* best-effort teardown */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigHealth();
    resetPolicyCache();
    resetWorkflowCache();
  });

  test(
    "/health exposes stale-session recovery driver and governed re-seat path liveness",
    async () => {
      const res = await request(appState.app).get("/health");
      const body = res.body as Record<string, unknown>;

      expect(body.staleSessionRecovery).toBeDefined();
      expect(typeof body.staleSessionRecovery).toBe("object");

      const liveness = body.staleSessionRecovery as Record<string, unknown>;

      expect(liveness.driverRegistered).toBe(true);
      expect(liveness.staleSessionHandlerSubscribed).toBe(true);
      expect(liveness.governedRedispatchReseatActive).toBe(true);
    },
  );
});
