/**
 * INF-1272 AC2: DispatchWatchdog must expose a public `getConfig(): WatchdogConfig`
 * accessor so callers (index.ts) can read exponentialBackoffMs/maxResignals without
 * an `as any` cast onto the private `config` field.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { DispatchAckTracker } from "./dispatch-ack-tracker.js";
import { DispatchWatchdog } from "./dispatch-watchdog.js";
import { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-config-getter-test-"));
}

const wakeConfig: WakeUpConfig = { nodeBin: process.execPath, timeoutMs: 10, maxRetries: 0 };

function setupDeps(dir: string) {
  const bag = new PendingWorkBag(path.join(dir, "bag.db"), 60_000);
  const sessionTracker = new SessionTracker(30_000);
  const ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
  const operationalEventStore = new OperationalEventStore(path.join(dir, "events.db"));
  return { bag, sessionTracker, ackTracker, operationalEventStore };
}

describe("DispatchWatchdog.getConfig()", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns the exponentialBackoffMs and maxResignals passed to the constructor", () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    const watchdog = new DispatchWatchdog(
      { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig },
      { ackTimeoutMs: 10_000, maxResignals: 7, cycleIntervalMs: 60_000, exponentialBackoffMs: 5000 },
    );

    const config = watchdog.getConfig();
    expect(config.exponentialBackoffMs).toBe(5000);
    expect(config.maxResignals).toBe(7);

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });

  test("returns a valid default config (numeric exponentialBackoffMs and maxResignals) when no config is passed", () => {
    const { bag, sessionTracker, ackTracker, operationalEventStore } = setupDeps(dir);

    const watchdog = new DispatchWatchdog(
      { bag, sessionTracker, ackTracker, operationalEventStore, wakeConfig },
    );

    const config = watchdog.getConfig();
    expect(typeof config.exponentialBackoffMs).toBe("number");
    expect(typeof config.maxResignals).toBe("number");

    watchdog.stop();
    bag.close();
    sessionTracker.close();
    ackTracker.close();
    operationalEventStore.close();
  });
});
