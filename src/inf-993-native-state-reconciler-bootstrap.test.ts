/**
 * INF-993 AC5 — bootstrap wiring and liveness for the native-state reconciler.
 *
 * These tests must fail until the production entry point registers the
 * reconciler and /health exposes a liveness field. A module-level unit test is
 * not enough for this AC.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest, getRegisteredCrons } from "./cron/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");
const CRON_NAME = "native-state-reconciler";

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "tdd",
          linearUserId: "u-tdd",
          openclawAgent: "tdd",
          accessToken: "tok-tdd",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("INF-993 AC5 static: native-state reconciler is wired from index.ts", () => {
  it("imports registerNativeStateReconcilerCron from the reconciler module", () => {
    expect(
      INDEX_TS.includes('import { registerNativeStateReconcilerCron } from "./native-state-reconciler.js"'),
    ).toBe(true);
  });

  it("calls registerNativeStateReconcilerCron() in production bootstrap", () => {
    expect(INDEX_TS.includes("registerNativeStateReconcilerCron(")).toBe(true);
  });
});

describe("INF-993 AC5 runtime: liveness is observable through /health", () => {
  const envBackup = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-993-native-reconcile-"));
    process.env = { ...envBackup };
    process.env.AGENTS_FILE = writeAgents(tmpDir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registering the reconciler creates a cron registry entry visible at /health.crons", async () => {
    const mod = await import("./native-state-reconciler.js");
    mod.registerNativeStateReconcilerCron({
      listTickets: async () => [],
      resolveNativeStateId: async () => "state-todo-uuid",
      writeNativeState: async (_issueId: string, input: Record<string, unknown>) => ({
        success: true,
        issue: { state: { id: input.stateId } },
      }),
      cadenceMs: 999_999_000,
    });

    const appState = createApp({
      bagDbPath: ":memory:",
      agentQueueDbPath: ":memory:",
      operationalEventsDbPath: ":memory:",
    });

    const registered = getRegisteredCrons().find((cron) => cron.name === CRON_NAME);
    expect(registered).toBeDefined();

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.crons.some((cron: { name: string }) => cron.name === CRON_NAME)).toBe(true);
  });

  it("/health exposes nativeStateReconciler scheduled/liveness without waiting for a trigger", async () => {
    const appState = createApp({
      bagDbPath: ":memory:",
      agentQueueDbPath: ":memory:",
      operationalEventsDbPath: ":memory:",
    });

    const res = await request(appState.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.nativeStateReconciler).toBeDefined();
    expect(res.body.nativeStateReconciler).toEqual(expect.objectContaining({
      scheduled: true,
      lastRunAt: expect.any(String),
    }));
  });
});
