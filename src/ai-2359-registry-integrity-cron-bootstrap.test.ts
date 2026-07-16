/**
 * AI-2359 — AC3: A periodic registry-integrity check runs (e.g. daily cron)
 * that compares capability-policy role bodies against agents.json entries and
 * alerts on mismatches.
 *
 * AI-1808 bootstrap-wiring addendum: The periodic registry-integrity check
 * component must be registered at server bootstrap (reachable from the
 * production entry point, e.g. index.ts / createApp()), proven by an
 * integration test that boots the entry point and asserts registration.
 * A module-level unit test does NOT satisfy this.
 *
 * AI-1808 liveness addendum: Liveness of the registry-integrity check
 * component must be observable at ac-validate without waiting for its
 * trigger condition — a /health field, startup log line, or registry
 * entry showing the component is scheduled/subscribed.
 *
 * AC4 (optional): A recovery cron entry that detects this specific failure
 * pattern (role body declared, no registry entry, tokens unknown) and
 * surfaces the re-onboard authorize URL.
 *
 * This test asserts:
 *   1. createApp() registers a "registry-integrity-check" cron entry
 *      (visible in getRegisteredCrons()).
 *   2. /health exposes this cron in its `crons` array.
 *   3. (AC4) An optional recovery helper surfaces the authorize URL for
 *      re-onboarding.
 */

import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { resetCronRegistryForTest, getRegisteredCrons } from "./cron/registry.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-2359-cron-"));
}

const SAMPLE_AGENTS = [
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

function writeAgentsFile(dir: string, agents: unknown[]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

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

describe("AI-2359 AC3: createApp registers periodic registry-integrity check cron", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    resetCronRegistryForTest();
    resetPolicyCache();
    resetConfigHealth();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * AC3 — PRODUCTION ENTRY POINT PROOF (AI-1808 addendum):
   * createApp() must register a cron entry named "registry-integrity-check"
   * in the cron registry. This proves the periodic check is wired at bootstrap,
   * not just importable.
   *
   * THIS TEST WILL FAIL until the implementer adds a `registerRegistryIntegrityCron()`
   * call inside createApp() and calls registerCron() with the name.
   */
  test("createApp registers registry-integrity-check cron entry", async () => {
    const agentsFile = writeAgentsFile(dir, SAMPLE_AGENTS);
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
      // Assert the cron is registered via the module-level registry.
      const crons = getRegisteredCrons();
      const integCron = crons.find((c) => c.name === "registry-integrity-check");
      expect(integCron).toBeDefined();
      expect(integCron!.name).toBe("registry-integrity-check");
      expect(integCron!.schedule).toBeDefined();
      // The schedule should be a human-readable duration (e.g. "24h" for daily).
      expect(typeof integCron!.schedule).toBe("string");
      expect(integCron!.schedule.length).toBeGreaterThan(0);
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });

  /**
   * AI-1808 liveness addendum: The registry-integrity check must be observable
   * at /health without waiting for the cron trigger — so ac-validate can see
   * the component is scheduled.
   */
  test("registry-integrity-check cron is visible at /health.crons", async () => {
    const agentsFile = writeAgentsFile(dir, SAMPLE_AGENTS);
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

      expect(res.body).toHaveProperty("crons");
      const crons: Array<{ name: string }> = res.body.crons;
      const integCron = crons.find((c) => c.name === "registry-integrity-check");
      expect(integCron).toBeDefined();
      expect(integCron!.name).toBe("registry-integrity-check");
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });

  /**
   * AC3 — EDGE CASE: after the cron fires (lastRunAt set), the registry entry
   * should still be visible at /health with the updated lastRunAt.
   */
  test("registry-integrity-check cron has registeredAt and can set lastRunAt", async () => {
    const agentsFile = writeAgentsFile(dir, SAMPLE_AGENTS);
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

      const crons: Array<{ name: string; registeredAt: string; lastRunAt: string | null }> = res.body.crons;
      const integCron = crons.find((c) => c.name === "registry-integrity-check");
      expect(integCron).toBeDefined();

      // Must have a registeredAt timestamp (ISO 8601).
      expect(integCron!.registeredAt).toBeDefined();
      expect(Date.parse(integCron!.registeredAt)).not.toBeNaN();

      // lastRunAt may be null initially (hasn't run yet in this process).
      // The important thing is the type: null or a timestamp string.
      if (integCron!.lastRunAt !== null) {
        expect(Date.parse(integCron!.lastRunAt)).not.toBeNaN();
      }
    } finally {
      bag?.close();
      sessionTracker?.close();
      agentQueue?.close();
      operationalEventStore?.close();
    }
  });
});

describe("AI-2359 AC4 (optional): recovery cron surfaces re-onboard authorize URL", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    resetCronRegistryForTest();
    resetPolicyCache();
    resetConfigHealth();
  });

  afterEach(() => {
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * AC4 (optional): A recovery cron that detects the specific failure pattern —
   * role body declared in capability-policy, no agents.json entry, tokens
   * unknown — and surfaces the Linear OAuth authorize URL for re-onboarding.
   *
   * This test is SKIPPED by default (it's optional). The implementer may create
   * a separate recovery cron entry, or fold the detection into the periodic
   * registry-integrity check.
   *
   * If implemented, this test asserts the recovery entry is also registered
   * at createApp().
   */
  test.skip("AC4 (optional) — recovery helper surfaces authorize URL for unregistered body", () => {
    // OPTIONAL — SKIP. The implementer can create this as a separate cron
    // entry or integrate it into the main registry-integrity check.
    //
    // If implemented, the recovery flow should:
    //   1. Detect a policy body with no agents.json entry (already detected
    //      by the registry-integrity cross-check).
    //   2. For each unregistered body, check if it has NO OAuth token anywhere
    //      (not just no entry — the agent was never onboarded).
    //   3. Surface the Linear app authorization URL so a human can re-onboard:
    //      https://linear.app/oauth/authorize?client_id=...&redirect_uri=...
    //   4. Post the authorize URL to an operational event or alert so it's
    //      visible without log access.
    //
    // Expected assertion:
    //   const crons = getRegisteredCrons();
    //   const recoverCron = crons.find((c) => c.name === "registry-recovery");
    //   expect(recoverCron).toBeDefined();
    //
    // Or if folded into the main check:
    //   const res = await request(app).get("/health");
    //   expect(res.body.registryPolicy.recoveryUrl).toBeDefined();
  });
});
