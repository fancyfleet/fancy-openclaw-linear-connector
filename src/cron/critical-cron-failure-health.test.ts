/**
 * INF-1263 AC2 — end-to-end: a cron's N-in-a-row failure streak must surface
 * as a loud /health signal, not just as a raw failureStreak number sitting in
 * /health.crons[].
 *
 * getCriticalCronFailures() itself is already unit-tested in registry.test.ts
 * (AC2/AC5). This file proves it is actually WIRED: markCronRunFailure()
 * against the real registry, through the real createApp() /health route, via
 * a real HTTP request — the same pattern inf-860-cron-liveness-honesty.test.ts
 * uses for criticalStaleCrons. A regression here means the escalation is
 * dead code again, exactly the gap Charles's code-review caught on PR #694.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import {
  markCronRunFailure,
  registerCron,
  resetCronRegistryForTest,
} from "./registry.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-1263-critical-cron-failure-"));
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

describe("INF-1263 AC2: critical cron failure streaks surface at /health", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "cron-run-stamps.json");
    process.env.CRON_STARTUP_GRACE_MS = "30000";
    process.env.CRON_FAILURE_THRESHOLD = "3";
    reloadAgents();
    resetCronRegistryForTest();
    appState = createApp({
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
    delete process.env.CRON_FAILURE_THRESHOLD;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a cron failing 2-in-a-row (below threshold) does not degrade /health", async () => {
    registerCron("flaky-driver", "every 1m");
    markCronRunFailure("flaky-driver", new Error("first failure"));
    markCronRunFailure("flaky-driver", new Error("second failure"));

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.criticalCronFailures).toEqual([]);
    expect(res.body.warnings).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ kind: "critical-cron-failure" })]),
    );
  });

  it("a cron failing 3-in-a-row degrades /health with a loud critical-cron-failure warning", async () => {
    registerCron("flaky-driver", "every 1m");
    markCronRunFailure("flaky-driver", new Error("first failure"));
    markCronRunFailure("flaky-driver", new Error("second failure"));
    markCronRunFailure("flaky-driver", new Error("third failure"));

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.criticalCronFailures).toEqual([
      expect.objectContaining({
        name: "flaky-driver",
        schedule: "every 1m",
        lastOutcome: "fail",
        lastError: "third failure",
        failureStreak: 3,
        severity: "critical",
      }),
    ]);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "critical-cron-failure",
          cron: "flaky-driver",
          failureStreak: 3,
          lastError: "third failure",
        }),
      ]),
    );
  });
});
