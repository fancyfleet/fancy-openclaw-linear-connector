import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest } from "./cron/registry.js";
import { resetDeployDriftStateForTest } from "./deploy-drift.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import type { StartupCommitResult } from "./startup-commit.js";

const COMMIT = "a23768f";

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: "u-igor",
          openclawAgent: "igor",
          accessToken: "tok-igor",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function closeAppState(appState: ReturnType<typeof createApp> | undefined): void {
  if (!appState) return;
  for (const value of Object.values(appState)) {
    if (value && typeof value === "object" && "close" in value) {
      const close = (value as { close?: () => void }).close;
      if (typeof close === "function") close();
    }
  }
}

async function waitForHealth(
  app: ReturnType<typeof createApp>["app"],
  predicate: (body: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let lastBody: Record<string, unknown> | undefined;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    lastBody = res.body as Record<string, unknown>;
    if (predicate(lastBody)) return lastBody;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for deploy-drift health; last=${JSON.stringify(lastBody)}`);
}

describe("INF-1264 deploy-drift startup race", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp> | undefined;
  let previousDeployDriftIntervalMs: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1264-startup-race-"));
    previousDeployDriftIntervalMs = process.env.DEPLOY_DRIFT_INTERVAL_MS;
    process.env.DEPLOY_DRIFT_INTERVAL_MS = String(999_999 * 1000);
    process.env.AGENTS_FILE = writeAgents(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    resetDeployDriftStateForTest();
    reloadAgents();
  });

  afterEach(() => {
    closeAppState(appState);
    resetCronRegistryForTest();
    resetDeployDriftStateForTest();
    delete process.env.AGENTS_FILE;
    if (previousDeployDriftIntervalMs === undefined) delete process.env.DEPLOY_DRIFT_INTERVAL_MS;
    else process.env.DEPLOY_DRIFT_INTERVAL_MS = previousDeployDriftIntervalMs;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("awaits the real startup commit before the immediate drift check compares live to main", async () => {
    let resolveStartup!: (value: StartupCommitResult) => void;
    const startupCommitPromise = new Promise<StartupCommitResult>((resolve) => {
      resolveStartup = resolve;
    });
    let startupResolveCalls = 0;

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      resolveStartupCommit: () => {
        startupResolveCalls += 1;
        return startupCommitPromise;
      },
      resolveMainCommit: async () => COMMIT,
    } as Parameters<typeof createApp>[0] & {
      resolveStartupCommit: () => Promise<StartupCommitResult>;
      resolveMainCommit: () => Promise<string>;
    });

    expect(startupResolveCalls).toBe(1);

    const unresolved = await request(appState.app).get("/health");
    expect(unresolved.status).toBe(200);
    expect(unresolved.body.commit).toBe("unknown");
    expect(unresolved.body.deployDrift).toEqual(
      expect.objectContaining({
        scheduled: true,
        lastCheckAt: null,
      }),
    );

    resolveStartup({ commit: COMMIT, source: "deploy-stamp" });

    const body = await waitForHealth(appState.app, (health) => {
      const drift = health.deployDrift as Record<string, unknown> | undefined;
      return drift?.liveCommit === COMMIT && drift?.mainCommit === COMMIT;
    });
    const drift = body.deployDrift as Record<string, unknown>;

    expect(body.commit).toBe(COMMIT);
    expect(drift).toEqual(
      expect.objectContaining({
        liveCommit: COMMIT,
        mainCommit: COMMIT,
        driftDetected: false,
        alertRaised: false,
      }),
    );
  });
});
