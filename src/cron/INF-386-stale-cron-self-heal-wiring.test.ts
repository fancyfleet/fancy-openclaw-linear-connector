import { describe, expect, jest, afterEach, test } from "@jest/globals";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../index.js";
import { reloadAgents } from "../agents.js";
import { markCronRun, registerCron, resetCronRegistryForTest } from "./registry.js";
import {
  registerStaleCronReinitializer,
  resetStaleCronSelfHealForTest,
} from "./stale-cron-self-heal.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-386-stale-cron-"));
}

function writeAgentsFile(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "sage",
          linearUserId: "user-sage-12345678",
          openclawAgent: "sage",
          clientId: "client-id-value",
          clientSecret: "client-secret-value",
          accessToken: "access-token-value",
          refreshToken: "refresh-token-value",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

describe("INF-386 stale cron self-heal production wiring", () => {
  let dir: string | undefined;
  let appState: ReturnType<typeof createApp> | undefined;

  afterEach(() => {
    appState?.dispatchDeliveryScheduler?.stop();
    appState?.watchdog?.stop();
    appState?.noActivityDetector?.stop();
    appState?.stuckDelegateDetector?.stop();
    appState?.managingPoller?.stop();
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    resetCronRegistryForTest();
    resetStaleCronSelfHealForTest();
    delete process.env.AGENTS_FILE;
    delete process.env.CRON_RUN_STAMP_PATH;
    delete process.env.STALE_CRON_SELF_HEAL_RETRY_CAP;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("/health attempts stale-cron self-heal once, then keeps capped stale cron monitor-visible", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "cron-run-stamps.json");
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    registerCron("inf-386-stale-driver", "every 1m");
    markCronRun("inf-386-stale-driver", new Date("2026-07-22T12:00:00.000Z"));
    const reinitializeCron = jest.fn(async () => undefined);
    registerStaleCronReinitializer("inf-386-stale-driver", reinitializeCron);

    const first = await request(appState.app).get("/health");

    expect(first.body.staleCrons).toEqual([
      expect.objectContaining({
        name: "inf-386-stale-driver",
        lastRunAt: "2026-07-22T12:00:00.000Z",
      }),
    ]);
    expect(first.body.staleCronSelfHeal.attempted).toEqual([
      { name: "inf-386-stale-driver", attempt: 1 },
    ]);
    expect(first.body.staleCronSelfHeal.capped).toEqual([]);
    expect(reinitializeCron).toHaveBeenCalledTimes(1);

    const second = await request(appState.app).get("/health");

    expect(reinitializeCron).toHaveBeenCalledTimes(1);
    expect(second.body.staleCrons).toEqual([
      expect.objectContaining({
        name: "inf-386-stale-driver",
        lastRunAt: "2026-07-22T12:00:00.000Z",
      }),
    ]);
    expect(second.body.staleCronSelfHeal.attempted).toEqual([]);
    expect(second.body.staleCronSelfHeal.capped).toEqual([
      { name: "inf-386-stale-driver", attempts: 1 },
    ]);
    expect(second.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stale-cron-self-heal-capped",
          cron: "inf-386-stale-driver",
          attempts: 1,
        }),
      ]),
    );
  });
});
