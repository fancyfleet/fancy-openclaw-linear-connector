/**
 * INF-1091 — oob-reconcile-sweep never runs on <24h-restart fleet →
 * critical-stale /health 503 → connector deploy pipeline deadlock.
 *
 * Root cause (Grover's diagnosis): the fleet-wide /health 503 gate keys off
 * `criticalStaleCrons`. A cron's staleness is measured from its *persisted*
 * `lastRunAt` (restored from the run-stamp file across restarts). The boot
 * grace that should cover a fresh process only graces crons that have *never*
 * run (`evaluateCronStartupReadiness` short-circuits on `lastRunAt === null`),
 * so a cron with a >24h-old persisted stamp falls straight into the critical
 * gate and /health serves 503 from boot until its first run (+interval).
 *
 * Fix: give the critical-stale gate the same boot grace the never-run path
 * already has. A cron whose staleness is measured against a pre-boot
 * `lastRunAt`, within `max(intervalMs, bootGraceMs)` of boot, must not count
 * toward the 503 gate.
 *
 *   AC1 (unit): isCronWithinBootGrace — pre-boot-stale cron is graced during
 *        the window and NOT graced after it (the not-503-during-grace,
 *        503-after transition), and a post-boot cron / never-run cron is not
 *        graced.
 *   AC2 (integration): a persisted-stale, pre-boot cron does NOT flip deployed
 *        /health to 503 during boot grace (the cold-restart deadlock), while
 *        reporting still lists it as stale.
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { isCronWithinBootGrace } from "./cron/startup-readiness.js";
import { markCronRun, registerCron, resetCronRegistryForTest } from "./cron/registry.js";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

describe("INF-1091 AC1: isCronWithinBootGrace boot grace for persisted-stale crons", () => {
  const bootedAt = new Date("2026-08-03T00:00:00.000Z");
  const preBootLastRun = new Date(bootedAt.getTime() - 25 * HOUR_MS).toISOString();
  const intervalMs = 10 * MINUTE_MS;

  it("graces a pre-boot-stale cron while now - bootedAt < max(intervalMs, bootGraceMs)", () => {
    const now = new Date(bootedAt.getTime() + 5 * MINUTE_MS); // inside the 10m interval grace
    expect(
      isCronWithinBootGrace({ lastRunAt: preBootLastRun, intervalMs, bootedAt, now, bootGraceMs: 0 }),
    ).toBe(true);
  });

  it("stops gracing the same cron once the grace window has elapsed (503 after)", () => {
    const now = new Date(bootedAt.getTime() + 10 * MINUTE_MS + 1); // just past the 10m interval grace
    expect(
      isCronWithinBootGrace({ lastRunAt: preBootLastRun, intervalMs, bootedAt, now, bootGraceMs: 0 }),
    ).toBe(false);
  });

  it("sizes the window as max(intervalMs, bootGraceMs) — bootGraceMs wins when larger", () => {
    const now = new Date(bootedAt.getTime() + 20 * MINUTE_MS); // past interval, inside 30m bootGrace
    expect(
      isCronWithinBootGrace({
        lastRunAt: preBootLastRun,
        intervalMs,
        bootedAt,
        now,
        bootGraceMs: 30 * MINUTE_MS,
      }),
    ).toBe(true);
  });

  it("does NOT grace a cron that has run since boot (lastRunAt >= bootedAt)", () => {
    const postBootLastRun = new Date(bootedAt.getTime() + MINUTE_MS).toISOString();
    const now = new Date(bootedAt.getTime() + 2 * MINUTE_MS);
    expect(
      isCronWithinBootGrace({ lastRunAt: postBootLastRun, intervalMs, bootedAt, now, bootGraceMs: 0 }),
    ).toBe(false);
  });

  it("does NOT grace a never-run cron (lastRunAt === null) — that is the startup-readiness path", () => {
    const now = new Date(bootedAt.getTime() + MINUTE_MS);
    expect(
      isCronWithinBootGrace({ lastRunAt: null, intervalMs, bootedAt, now, bootGraceMs: 0 }),
    ).toBe(false);
  });
});

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-1091-boot-grace-"));
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

describe("INF-1091 AC2: deployed /health does not 503 on a pre-boot-stale cron during boot grace", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "cron-run-stamps.json");
    // No extra bootGraceMs — the fix must derive the grace from the cron's own
    // 10m interval, which is exactly the cold-restart window where the first
    // sweep has not yet fired.
    process.env.CRON_STARTUP_GRACE_MS = "0";
    process.env.CRON_CRITICAL_STALE_MS = String(24 * HOUR_MS);
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
    delete process.env.CRON_CRITICAL_STALE_MS;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves 200, not 503, when oob-reconcile-sweep's persisted lastRunAt predates boot by >24h and boot grace is active", async () => {
    // Default bootedAt ~ now (fresh cold restart). Register the sweep and stamp
    // a pre-boot lastRunAt >24h old (the persisted-stamp cold-restart case).
    // now - bootedAt is milliseconds << the 10m interval grace, so the fix
    // must suppress the 503 gate. Without the fix, overdueByMs (~25h) crosses
    // the 24h critical threshold and /health returns 503 from boot — the
    // cold-restart deadlock.
    registerCron("oob-reconcile-sweep", "every 10m");
    markCronRun("oob-reconcile-sweep", new Date(Date.now() - 25 * HOUR_MS));

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.criticalStaleCrons).toEqual([]);
    // Reporting is unchanged: the sweep is still surfaced as stale, the gate
    // is merely graced. (Honest health, per INF-860.)
    expect(res.body.staleCrons).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "oob-reconcile-sweep" })]),
    );
  });

  it("still serves 503 once the boot-grace window has elapsed (steady-state gate intact)", async () => {
    // Same persisted-stale sweep, but this instance booted 2h ago — well past
    // the 10m interval grace. The gate must fire: boot grace is a startup
    // window, not a permanent exemption.
    closeAppState(appState);
    appState = createApp({
      bootedAt: new Date(Date.now() - 2 * HOUR_MS),
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
    registerCron("oob-reconcile-sweep", "every 10m");
    markCronRun("oob-reconcile-sweep", new Date(Date.now() - 25 * HOUR_MS));

    const res = await request(appState!.app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.criticalStaleCrons).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "oob-reconcile-sweep" })]),
    );
  });
});
