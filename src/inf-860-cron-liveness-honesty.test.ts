/**
 * INF-860 — Verify cron liveness honesty.
 *
 * Parent INF-855 slice:
 *   AC1: deployed-style /health reports no criticalStaleCrons for
 *        validation-watchdog or merged-evidence-reconciler unless intentional
 *        retirement is explicit.
 *   AC2: stale required crons degrade health loudly enough to block
 *        engine-clean decisions.
 *   AC3: verification uses deployed /health-style behavior, not labels or SHAs.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import {
  getRegisteredCrons,
  markCronRun,
  registerCron,
  resetCronRegistryForTest,
} from "./cron/registry.js";

const REQUIRED_CRONS = [
  "validation-watchdog",
  "merged-evidence-reconciler",
] as const;

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-860-cron-health-"));
}

function writeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");
  return agentsFile;
}

function closeAppState(appState: ReturnType<typeof createApp> | undefined): void {
  if (!appState) return;
  appState.dispatchDeliveryScheduler?.stop();
  appState.watchdog?.stop();
  appState.noActivityDetector?.stop();
  appState.stuckDelegateDetector?.stop();
  appState.managingPoller?.stop();
  appState.bag?.close();
  appState.sessionTracker?.close();
  appState.agentQueue?.close();
  appState.operationalEventStore?.close();
}

function ageRegisteredCron(name: string, registeredAt: string): void {
  const entry = getRegisteredCrons().find((cron) => cron.name === name);
  if (!entry) throw new Error(`missing cron registry entry for ${name}`);
  entry.registeredAt = registeredAt;
}

describe("INF-860: deployed /health required cron liveness honesty", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "cron-run-stamps.json");
    process.env.CRON_STARTUP_GRACE_MS = "30000";
    // Keep the historical age-only critical threshold high so this test proves
    // required identity criticality, not "anything older than 24h is critical."
    process.env.CRON_CRITICAL_STALE_MS = String(24 * 60 * 60 * 1000);
    reloadAgents();
    resetCronRegistryForTest();
    appState = createApp({
      // INF-1091: pin bootedAt 2h ago so these required-cron liveness
      // assertions exercise the steady-state /health gate (a process up well
      // past the boot-grace window), not the fresh-boot grace path. Stale
      // required crons must still degrade health once grace has elapsed.
      bootedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      managingStateDbPath: path.join(dir, "managing-state.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
      deadLetterQueueDbPath: path.join(dir, "dead-letter.db"),
    });
    resetCronRegistryForTest();
  });

  afterEach(() => {
    closeAppState(appState);
    resetCronRegistryForTest();
    delete process.env.AGENTS_FILE;
    delete process.env.CRON_RUN_STAMP_PATH;
    delete process.env.CRON_STARTUP_GRACE_MS;
    delete process.env.CRON_CRITICAL_STALE_MS;
    delete process.env.REQUIRED_CRON_RETIREMENTS_JSON;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1/AC3: /health identifies validation-watchdog and merged-evidence-reconciler as required deployed cron identities", async () => {
    const now = new Date();
    for (const cron of REQUIRED_CRONS) {
      registerCron(cron, "every 5m");
      markCronRun(cron, now);
    }

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.requiredCrons).toEqual(
      expect.arrayContaining(
        REQUIRED_CRONS.map((name) => expect.objectContaining({
          name,
          required: true,
          retired: false,
          source: "/health",
        })),
      ),
    );
  });

  it("AC2/AC3: stale required crons are critical and degrade /health before the generic 24h critical threshold", async () => {
    const staleLastRunAt = new Date(Date.now() - 21 * 60 * 1000);
    for (const cron of REQUIRED_CRONS) {
      registerCron(cron, "every 5m");
      markCronRun(cron, staleLastRunAt);
    }

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.criticalStaleCrons).toEqual(
      expect.arrayContaining(
        REQUIRED_CRONS.map((name) => expect.objectContaining({
          name,
          schedule: "every 5m",
          required: true,
        })),
      ),
    );
    expect(res.body.warnings).toEqual(
      expect.arrayContaining(
        REQUIRED_CRONS.map((name) => expect.objectContaining({
          kind: "critical-stale-cron",
          cron: name,
          required: true,
        })),
      ),
    );
  });

  it("AC1/AC3: fresh required crons are recorded as clean and do not create false criticalStaleCrons", async () => {
    const now = new Date();
    for (const cron of REQUIRED_CRONS) {
      registerCron(cron, "every 5m");
      markCronRun(cron, now);
    }

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.criticalStaleCrons).toEqual([]);
    expect(res.body.requiredCrons).toEqual(
      expect.arrayContaining(
        REQUIRED_CRONS.map((name) => expect.objectContaining({
          name,
          status: "fresh",
          retired: false,
        })),
      ),
    );
  });

  it("AC1/AC3: an explicitly retired required cron is documented at /health and does not create a false criticalStaleCron", async () => {
    process.env.REQUIRED_CRON_RETIREMENTS_JSON = JSON.stringify([
      {
        name: "validation-watchdog",
        reason: "INF-860 test retirement record",
        ticket: "INF-860",
      },
    ]);
    registerCron("validation-watchdog", "every 5m");
    ageRegisteredCron(
      "validation-watchdog",
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    );
    registerCron("merged-evidence-reconciler", "every 5m");
    markCronRun("merged-evidence-reconciler", new Date());

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.criticalStaleCrons).toEqual([]);
    expect(res.body.requiredCrons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "validation-watchdog",
          required: true,
          retired: true,
          retirement: expect.objectContaining({
            reason: "INF-860 test retirement record",
            ticket: "INF-860",
          }),
        }),
        expect.objectContaining({
          name: "merged-evidence-reconciler",
          required: true,
          retired: false,
          status: "fresh",
        }),
      ]),
    );
  });
});
