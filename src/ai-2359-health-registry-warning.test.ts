/**
 * AI-2359 — AC1: /health endpoint emits a warning when a role body declared in
 * capability-policy has no corresponding entry in the agent registry.
 *
 * On 2026-07-12, tdd, cra, and woz vanished from the live agents.json registry
 * without any config change. The /health endpoint dropped from 29 to 26 agents
 * but emitted no warning — the gap between the capability policy's declared
 * bodies and the actual registry was invisible at /health. The drop was only
 * noticed hours later when agent sessions stopped routing.
 *
 * This AC closes that observability gap: /health must surface registry⇄policy
 * violations so a steward noticing a healthy-but-shrinking roster is not the
 * only detection path.
 *
 * The implementer must:
 *   - Surface `getRegistryPolicyStatus()` at /health (e.g. a `registryPolicy`
 *     field with `lastCheck`, `violations`, `notes`).
 *   - Run the cross-check at createApp() time and again on registry hot-reloads
 *     (the startup + hot-reload wiring already exists via `startRegistryPolicyCheck()`;
 *     the missing piece is surfacing the result in /health).
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-2359-health-reg-"));
}

/** Build a minimal agents.json with known agents. */
function writeAgentsFile(dir: string, agents: Record<string, unknown>[]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

const ALWAYS_AGENTS = [
  {
    name: "astrid",
    linearUserId: "user-astrid",
    openclawAgent: "astrid",
    clientId: "c",
    clientSecret: "s",
    accessToken: "t",
    refreshToken: "r",
    host: "local" as const,
  },
];

/** Write a capability-policy that includes an UNREGISTERED body (one not in agents.json). */
function writePolicyWithOrphanBody(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  // Include a registered body (astrid) and an orphan (woz) that has no agents.json entry.
  fs.writeFileSync(file, `
capabilities:
  - id: repo:read
    description: read repos

containers:
  - id: workflow
    grants: [repo:read]
  - id: utility
    grants: [repo:read]

roles:
  - id: steward
    requires: [repo:read]
  - id: worker
    requires: [repo:read]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: woz
    container: utility
    fills_roles: [worker]
`.trimStart(), "utf8");
  return file;
}

/** Write a clean policy where every body is registered. */
function writeCleanPolicy(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(file, `
capabilities:
  - id: repo:read
    description: read repos

containers:
  - id: workflow
    grants: [repo:read]

roles:
  - id: steward
    requires: [repo:read]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
`.trimStart(), "utf8");
  return file;
}

describe("AI-2359 AC1: /health warns when a policy body has no registry entry", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    resetPolicyCache();
    resetConfigHealth();
  });

  afterEach(() => {
    // Clean up temp files
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("surfaces registry-policy violations at /health when a body is unregistered", async () => {
    const agentsFile = writeAgentsFile(dir, ALWAYS_AGENTS);
    const policyFile = writePolicyWithOrphanBody(dir);
    process.env.AGENTS_FILE = agentsFile;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    // Reset the in-memory agent cache so load() picks up our test agents.json.
    reloadAgents();

    const { app, bag, sessionTracker, agentQueue, operationalEventStore } = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "ops-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
    });

    try {
      const res = await request(app).get("/health").expect(200);

      // The /health response must include a registryPolicy field with the
      // cross-check result. This assertion WILL FAIL until the implementer
      // surfaces getRegistryPolicyStatus() in the /health response.
      expect(res.body).toHaveProperty("registryPolicy");
      expect(res.body.registryPolicy).toHaveProperty("violations");
      expect(res.body.registryPolicy).toHaveProperty("notes");

      // With the orphan body (woz) present, violations should be non-empty.
      expect(res.body.registryPolicy.violations.length).toBeGreaterThan(0);
      const violation = res.body.registryPolicy.violations[0];
      expect(violation).toContain("woz");
      expect(violation).toContain("no registered agent");
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });

  test("reports no violations when every policy body has a registry entry", async () => {
    const agentsFile = writeAgentsFile(dir, ALWAYS_AGENTS);
    const policyFile = writeCleanPolicy(dir);
    process.env.AGENTS_FILE = agentsFile;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    reloadAgents();

    const { app, bag, sessionTracker, agentQueue, operationalEventStore } = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "ops-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
    });

    try {
      const res = await request(app).get("/health").expect(200);

      expect(res.body).toHaveProperty("registryPolicy");
      expect(res.body.registryPolicy).toHaveProperty("violations");
      expect(res.body.registryPolicy.violations).toEqual([]);
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });

  test("registryPolicy field has lastCheck timestamp", async () => {
    const agentsFile = writeAgentsFile(dir, ALWAYS_AGENTS);
    const policyFile = writeCleanPolicy(dir);
    process.env.AGENTS_FILE = agentsFile;
    process.env.CAPABILITY_POLICY_PATH = policyFile;

    reloadAgents();

    const { app, bag, sessionTracker, agentQueue, operationalEventStore } = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "ops-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
    });

    try {
      const res = await request(app).get("/health").expect(200);

      expect(res.body.registryPolicy.lastCheck).toBeDefined();
      expect(typeof res.body.registryPolicy.lastCheck).toBe("string");
      // ISO 8601: should parse as a valid date.
      expect(Date.parse(res.body.registryPolicy.lastCheck)).not.toBeNaN();
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });

  test("violations include multiple unregistered bodies when applicable", async () => {
    const agentsFile = writeAgentsFile(dir, ALWAYS_AGENTS);
    // Write a policy with two unregistered bodies.
    const file = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(file, `
capabilities:
  - id: repo:read
    description: read repos

containers:
  - id: workflow
    grants: [repo:read]
  - id: utility
    grants: [repo:read]
  - id: dev
    grants: [repo:read]

roles:
  - id: steward
    requires: [repo:read]
  - id: worker
    requires: [repo:read]

bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
  - id: woz
    container: utility
    fills_roles: [worker]
  - id: r2d2
    container: dev
    fills_roles: [worker]
`.trimStart(), "utf8");

    process.env.AGENTS_FILE = agentsFile;
    process.env.CAPABILITY_POLICY_PATH = file;

    reloadAgents();

    const { app, bag, sessionTracker, agentQueue, operationalEventStore } = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "ops-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
    });

    try {
      const res = await request(app).get("/health").expect(200);

      const violations = res.body.registryPolicy.violations;
      expect(violations.length).toBeGreaterThanOrEqual(2);
      expect(violations.some((v: string) => v.includes("woz"))).toBe(true);
      expect(violations.some((v: string) => v.includes("r2d2"))).toBe(true);
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });
});
