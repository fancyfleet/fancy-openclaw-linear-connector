/**
 * INF-1264 — Bootstrap wiring, /health liveness for the live↔main deploy-drift
 * detector. FAILING tests (TDD write-tests state).
 *
 * Mirrors the accepted AI-2009/AI-1857 bootstrap-wiring pattern: a periodic or
 * background driver only counts as "registered" (AC6) if it is reachable from
 * the production entry point (index.ts), proven two ways:
 *   (1) static — index.ts imports AND calls registerDeployDriftCron in the
 *       bootstrap (isEntryPoint) block. A module existing but never wired from
 *       index.ts is exactly the AI-1773/AI-1775 dead-code-in-prod failure mode
 *       this ticket exists to prevent from recurring in its own fix.
 *   (2) runtime — booting createApp() + calling the registrar produces a live
 *       /health.deployDrift entry and a getRegisteredCrons() "deploy-drift" entry
 *       — i.e. the timer/registration really happened, not just an import.
 *
 * AC1  No silent merged-but-not-live drift — driftDetected observable at /health.
 * AC4  /health reports the true deployed commit (already satisfied by the
 *      existing `commit` field via getStartupCommit()/resolveStartupCommit) AND
 *      live↔main drift raises an alert — the NEW part this ticket adds.
 * AC6  Bootstrap wiring + ac-validate observability without waiting for a trigger.
 *
 * src/deploy-drift.ts does not exist yet, so runtime tests dynamic-import it
 * INSIDE the test body — keeps the static test's failure signal clean (index.ts
 * genuinely lacks the wiring) instead of a module-resolution crash.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { getRegisteredCrons, resetCronRegistryForTest } from "./cron/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const CRON_NAME = "deploy-drift";

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [{ name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" }],
    }),
    "utf8",
  );
  return file;
}

// ════════════════════════════════════════════════════════════════════════════
// AC6 (1) — static: index.ts wires the deploy-drift registrar in the bootstrap block
// ════════════════════════════════════════════════════════════════════════════

describe("AC6 static: deploy-drift detector is imported and called in index.ts", () => {
  it("imports registerDeployDriftCron from the deploy-drift module", () => {
    expect(
      INDEX_TS.includes('import { registerDeployDriftCron } from "./deploy-drift.js"'),
    ).toBe(true);
  });

  it("calls registerDeployDriftCron() in the bootstrap (isEntryPoint) block", () => {
    expect(INDEX_TS.includes("registerDeployDriftCron(")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6 (2) — runtime: registrar produces a live /health.deployDrift + crons entry
// AC1/AC4  — drift is observable at /health without waiting for the real trigger
// ════════════════════════════════════════════════════════════════════════════

describe("AC1/AC4/AC6 runtime: deploy-drift detector is observable via /health after bootstrap", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1264-boot-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
  });

  it("registerDeployDriftCron() adds a deploy-drift cron registry entry (AC6)", async () => {
    const mod = await import("./deploy-drift.js");
    mod.registerDeployDriftCron({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => "abc1234",
      cadenceMs: 999_999 * 1000, // do not actually fire during the test
    } as never);

    const cron = getRegisteredCrons().find((c) => c.name === CRON_NAME);
    expect(cron).toBeDefined();
    expect(cron!.schedule).toMatch(/\d+\s*(h|m|s|ms|d)/);

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    const crons = (res.body as { crons: Array<{ name: string }> }).crons;
    expect(crons.some((c) => c.name === CRON_NAME)).toBe(true);
  });

  it("/health exposes a deployDrift field with no drift when live matches main (AC4)", async () => {
    const mod = await import("./deploy-drift.js");
    mod.registerDeployDriftCron({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => "abc1234",
      cadenceMs: 999_999 * 1000,
    } as never);
    // Force at least one synchronous check so lastCheckAt/liveCommit/mainCommit
    // are populated without waiting for the real cadence to elapse (AC6: ac-validate
    // must not have to wait for the trigger condition).
    if (typeof (mod as { runDeployDriftCheckForTest?: () => Promise<unknown> }).runDeployDriftCheckForTest === "function") {
      await (mod as { runDeployDriftCheckForTest: () => Promise<unknown> }).runDeployDriftCheckForTest();
    }

    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    expect(body.deployDrift).toBeDefined();
    const live = body.deployDrift as Record<string, unknown>;
    expect(typeof live.scheduled).toBe("boolean");
    expect(live.scheduled).toBe(true);
    expect(live.driftDetected).toBe(false);
    expect(live.alertRaised).toBe(false);
  });

  it("/health.deployDrift reports driftDetected + alertRaised when live diverges from main (AC1: loudly surfaced)", async () => {
    const mod = await import("./deploy-drift.js");
    mod.registerDeployDriftCron({
      getLiveCommit: async () => "old0001",
      getMainCommit: async () => "new9999",
      cadenceMs: 999_999 * 1000,
    } as never);
    if (typeof (mod as { runDeployDriftCheckForTest?: () => Promise<unknown> }).runDeployDriftCheckForTest === "function") {
      await (mod as { runDeployDriftCheckForTest: () => Promise<unknown> }).runDeployDriftCheckForTest();
    }

    const res = await request(appState.app).get("/health");
    const body = res.body as Record<string, unknown>;
    const live = body.deployDrift as Record<string, unknown>;
    expect(live.driftDetected).toBe(true);
    expect(live.alertRaised).toBe(true);
    expect(live.liveCommit).toBe("old0001");
    expect(live.mainCommit).toBe("new9999");
  });
});
