/**
 * AI-1810 — Cron/background-driver registry unit tests.
 *
 * Covers the registry module contract and the registration behavior of each
 * driver's registrar. The end-to-end guarantee (booting the production entry
 * point yields these entries in /health) lives in
 * health-crons-integration.test.ts — these tests intentionally do NOT prove
 * bootstrap wiring, only per-module behavior.
 */
import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cronRegistry from "./registry.js";
import {
  registerCron,
  getRegisteredCrons,
  markCronRun,
  resetCronRegistryForTest,
  formatIntervalMs,
  getCronStalenessMultiplierFromEnv,
} from "./registry.js";
import { registerRescueSweepCron } from "./rescue-sweep-cron.js";
import { registerG20CanaryCron } from "./g20-canary-runner.js";
import { registerSlaSweepCron } from "../sla-sweep.js";
import { registerConfigSanityAlertCron, _resetConfigSanityAlertForTests } from "../config-sanity-alert.js";

describe("cron registry (AI-1810)", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("registerCron records name, schedule, and an ISO registeredAt", () => {
    registerCron("sample-driver", "every 5m");
    const entries = getRegisteredCrons();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("sample-driver");
    expect(entries[0].schedule).toBe("every 5m");
    expect(Number.isNaN(Date.parse(entries[0].registeredAt))).toBe(false);
  });

  test("re-registering the same name overwrites instead of duplicating", () => {
    registerCron("sample-driver", "every 5m");
    registerCron("sample-driver", "every 10m");
    const entries = getRegisteredCrons();
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("every 10m");
  });

  test("getRegisteredCrons returns entries sorted by name", () => {
    registerCron("zeta", "every 1h");
    registerCron("alpha", "every 1h");
    expect(getRegisteredCrons().map((e) => e.name)).toEqual(["alpha", "zeta"]);
  });

  test("formatIntervalMs renders compact human-readable durations", () => {
    expect(formatIntervalMs(5 * 60 * 1000)).toBe("5m");
    expect(formatIntervalMs(60 * 60 * 1000)).toBe("1h");
    expect(formatIntervalMs(90 * 1000)).toBe("90s");
    expect(formatIntervalMs(1500)).toBe("1500ms");
  });

  test("INF-351: markCronRun persists lastRunAt and registerCron reloads it after restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-run-stamps-"));
    const originalStampPath = process.env.CRON_RUN_STAMP_PATH;
    process.env.CRON_RUN_STAMP_PATH = path.join(dir, "stamps.json");
    try {
      registerCron("persisted-driver", "every 1m");
      markCronRun("persisted-driver", new Date("2026-07-22T22:15:00.000Z"));

      resetCronRegistryForTest();
      registerCron("persisted-driver", "every 1m");

      expect(getRegisteredCrons()).toEqual([
        expect.objectContaining({
          name: "persisted-driver",
          lastRunAt: "2026-07-22T22:15:00.000Z",
        }),
      ]);
    } finally {
      if (originalStampPath === undefined) {
        delete process.env.CRON_RUN_STAMP_PATH;
      } else {
        process.env.CRON_RUN_STAMP_PATH = originalStampPath;
      }
      resetCronRegistryForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("INF-351: missing or corrupt run-stamp files are treated as never stamped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-run-stamps-corrupt-"));
    const originalStampPath = process.env.CRON_RUN_STAMP_PATH;
    const stampPath = path.join(dir, "stamps.json");
    process.env.CRON_RUN_STAMP_PATH = stampPath;
    try {
      registerCron("missing-stamp-file", "every 1m");
      expect(getRegisteredCrons()[0].lastRunAt).toBeNull();

      resetCronRegistryForTest();
      fs.writeFileSync(stampPath, "{not json", "utf8");
      expect(() => registerCron("corrupt-stamp-file", "every 1m")).not.toThrow();
      expect(getRegisteredCrons()[0].lastRunAt).toBeNull();
    } finally {
      if (originalStampPath === undefined) {
        delete process.env.CRON_RUN_STAMP_PATH;
      } else {
        process.env.CRON_RUN_STAMP_PATH = originalStampPath;
      }
      resetCronRegistryForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

type StaleCronEntry = {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  overdueBy: string;
  overdueByMs: number;
};

function getStaleCronsForTest(opts: { now: Date; stalenessMultiplier?: number }): StaleCronEntry[] {
  const fn = (cronRegistry as unknown as {
    getStaleCrons?: (opts: { now: Date; stalenessMultiplier?: number }) => StaleCronEntry[];
  }).getStaleCrons;
  expect(fn).toEqual(expect.any(Function));
  return fn!(opts);
}

type CronOutcome = "success" | "fail" | null;
type CronOutcomeEntry = {
  name: string;
  lastRunAt: string | null;
  lastOutcome: CronOutcome;
  lastError: string | null;
  failureStreak: number;
};

type CriticalCronFailure = {
  name: string;
  schedule: string;
  lastOutcome: "fail";
  lastError: string;
  failureStreak: number;
  severity: "critical";
};

function getOutcomeApiForTest() {
  // INF-1263 contract introduced by these RED tests:
  // - markCronRunSuccess(name, now?) records a successful run, clears lastError,
  //   resets failureStreak to 0, and updates lastRunAt.
  // - markCronRunFailure(name, error, now?) records a failed run, stores the
  //   human-readable error message in lastError, increments failureStreak, and
  //   updates lastRunAt.
  // - getRegisteredCrons() entries expose lastOutcome, lastError, and
  //   failureStreak so /health can surface run outcome without waiting for the
  //   next trigger.
  // - getCriticalCronFailures({ failureThreshold }) returns crons whose
  //   consecutive failureStreak has reached the configured threshold.
  const api = cronRegistry as unknown as {
    markCronRunSuccess?: (name: string, now?: Date) => void;
    markCronRunFailure?: (name: string, error: unknown, now?: Date) => void;
    getCriticalCronFailures?: (opts: { failureThreshold: number }) => CriticalCronFailure[];
  };
  expect(api.markCronRunSuccess).toEqual(expect.any(Function));
  expect(api.markCronRunFailure).toEqual(expect.any(Function));
  expect(api.getCriticalCronFailures).toEqual(expect.any(Function));
  return {
    markCronRunSuccess: api.markCronRunSuccess!,
    markCronRunFailure: api.markCronRunFailure!,
    getCriticalCronFailures: api.getCriticalCronFailures!,
  };
}

function getCronOutcomeEntryForTest(name: string): CronOutcomeEntry {
  const entry = getRegisteredCrons().find((cron) => cron.name === name) as CronOutcomeEntry | undefined;
  expect(entry).toBeDefined();
  expect(entry).toEqual(expect.objectContaining({
    lastOutcome: expect.anything(),
    failureStreak: expect.any(Number),
  }));
  expect(entry).toHaveProperty("lastError");
  return entry!;
}

describe("INF-339 stale cron detection", () => {
  beforeEach(() => {
    resetCronRegistryForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    resetCronRegistryForTest();
    jest.useRealTimers();
  });

  test("AC2: register-but-never-fire cron is stale after its first expected fire", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("never-fired", "every 5m");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:06:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "never-fired",
        schedule: "every 5m",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC3: lagging cron appears when lastRunAt is older than schedule times default N=3", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("lagging-driver", "every 10m");
    markCronRun("lagging-driver", new Date("2026-07-22T12:00:00.000Z"));

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:31:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "lagging-driver",
        schedule: "every 10m",
        lastRunAt: "2026-07-22T12:00:00.000Z",
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC4: stale threshold N is configurable", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("configurable-driver", "every 10m");
    markCronRun("configurable-driver", new Date("2026-07-22T12:00:00.000Z"));

    expect(getStaleCronsForTest({
      now: new Date("2026-07-22T12:31:00.000Z"),
      stalenessMultiplier: 4,
    })).toEqual([]);

    expect(getStaleCronsForTest({
      now: new Date("2026-07-22T12:41:00.000Z"),
      stalenessMultiplier: 4,
    })).toEqual([
      {
        name: "configurable-driver",
        schedule: "every 10m",
        lastRunAt: "2026-07-22T12:00:00.000Z",
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });

  test("AC4: stale threshold multiplier is read from CRON_STALENESS_MULTIPLIER", () => {
    expect(getCronStalenessMultiplierFromEnv({
      CRON_STALENESS_MULTIPLIER: "4",
    } as NodeJS.ProcessEnv)).toBe(4);
    expect(getCronStalenessMultiplierFromEnv({
      CRON_STALENESS_MULTIPLIER: "0",
    } as NodeJS.ProcessEnv)).toBe(3);
  });

  test("AC5: fresh crons and exact-threshold crons are not flagged", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("fresh-driver", "every 10m");
    markCronRun("fresh-driver", new Date("2026-07-22T12:20:00.000Z"));
    registerCron("exact-threshold", "every 10m");
    markCronRun("exact-threshold", new Date("2026-07-22T12:00:00.000Z"));
    jest.setSystemTime(new Date("2026-07-22T12:26:00.000Z"));
    registerCron("not-yet-due", "every 5m");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:30:00.000Z"),
    });

    expect(stale).toEqual([]);
  });

  test("AC5: parenthetical interval suffixes are still covered by stale detection", () => {
    jest.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    registerCron("delegation-reconciliation-sweep", "every 5m (300000ms)");
    registerCron("stale-plain-delegate-sweep", "every 5m (stale=15m)");

    const stale = getStaleCronsForTest({
      now: new Date("2026-07-22T12:06:00.000Z"),
    });

    expect(stale).toEqual([
      {
        name: "delegation-reconciliation-sweep",
        schedule: "every 5m (300000ms)",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
      {
        name: "stale-plain-delegate-sweep",
        schedule: "every 5m (stale=15m)",
        lastRunAt: null,
        overdueBy: "1m",
        overdueByMs: 60_000,
      },
    ]);
  });
});

describe("INF-1263 cron run outcome tracking and failure streak escalation", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("AC1/AC7: registry records success outcome, clears error, and exposes streak fields per cron", () => {
    const { markCronRunSuccess } = getOutcomeApiForTest();
    registerCron("outcome-driver", "every 1m");

    markCronRunSuccess("outcome-driver", new Date("2026-08-05T12:00:00.000Z"));

    expect(getCronOutcomeEntryForTest("outcome-driver")).toEqual(expect.objectContaining({
      name: "outcome-driver",
      lastRunAt: "2026-08-05T12:00:00.000Z",
      lastOutcome: "success",
      lastError: null,
      failureStreak: 0,
    }));
  });

  test("AC1/AC2/AC7: registry records failed outcome, error message, and consecutive failure streak", () => {
    const { markCronRunFailure } = getOutcomeApiForTest();
    registerCron("failing-driver", "every 1m");

    markCronRunFailure("failing-driver", new Error("Linear API 503"), new Date("2026-08-05T12:00:00.000Z"));
    markCronRunFailure("failing-driver", "timeout waiting for Linear", new Date("2026-08-05T12:01:00.000Z"));

    expect(getCronOutcomeEntryForTest("failing-driver")).toEqual(expect.objectContaining({
      name: "failing-driver",
      lastRunAt: "2026-08-05T12:01:00.000Z",
      lastOutcome: "fail",
      lastError: "timeout waiting for Linear",
      failureStreak: 2,
    }));
  });

  test("AC2/AC5: N-in-a-row failures surface as critical and a success resets the streak", () => {
    const { markCronRunSuccess, markCronRunFailure, getCriticalCronFailures } = getOutcomeApiForTest();
    registerCron("flaky-driver", "every 1m");

    markCronRunFailure("flaky-driver", new Error("first failure"), new Date("2026-08-05T12:00:00.000Z"));
    markCronRunFailure("flaky-driver", new Error("second failure"), new Date("2026-08-05T12:01:00.000Z"));
    expect(getCriticalCronFailures({ failureThreshold: 3 })).toEqual([]);

    markCronRunFailure("flaky-driver", new Error("third failure"), new Date("2026-08-05T12:02:00.000Z"));
    expect(getCriticalCronFailures({ failureThreshold: 3 })).toEqual([
      expect.objectContaining({
        name: "flaky-driver",
        lastOutcome: "fail",
        lastError: "third failure",
        failureStreak: 3,
        severity: "critical",
      }),
    ]);

    markCronRunSuccess("flaky-driver", new Date("2026-08-05T12:03:00.000Z"));
    expect(getCronOutcomeEntryForTest("flaky-driver").failureStreak).toBe(0);
    expect(getCriticalCronFailures({ failureThreshold: 3 })).toEqual([]);
  });
});

describe("driver registrars self-register (AI-1810)", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => {
    resetCronRegistryForTest();
    delete process.env.G20_CANARY_TICKET_ID;
  });

  test("registerRescueSweepCron registers 'rescue-sweep'", () => {
    registerRescueSweepCron();
    expect(getRegisteredCrons().map((e) => e.name)).toContain("rescue-sweep");
  });

  test("registerG20CanaryCron does NOT register when the canary is skipped (no ticket id)", () => {
    delete process.env.G20_CANARY_TICKET_ID;
    registerG20CanaryCron();
    expect(getRegisteredCrons().map((e) => e.name)).not.toContain("g20-canary");
  });

  test("registerG20CanaryCron registers 'g20-canary' on the scheduling path", () => {
    process.env.G20_CANARY_TICKET_ID = "AI-0000";
    registerG20CanaryCron();
    expect(getRegisteredCrons().map((e) => e.name)).toContain("g20-canary");
  });

  test("registerSlaSweepCron registers 'sla-sweep' with its cadence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sla-registry-test-"));
    const defPath = path.join(dir, "defs.yaml");
    fs.writeFileSync(defPath, "id: noop\nstates: []\n", "utf8");
    const timer = registerSlaSweepCron({
      authToken: "test-token",
      workflowDefPath: defPath,
      notify: jest.fn(),
      wakeAgent: jest.fn(async () => {}),
      cadenceMs: 60_000,
    });
    clearInterval(timer);
    fs.rmSync(dir, { recursive: true, force: true });
    const entry = getRegisteredCrons().find((e) => e.name === "sla-sweep");
    expect(entry).toBeDefined();
    expect(entry?.schedule).toBe("every 1m");
  });

  test("registerConfigSanityAlertCron registers 'config-sanity-alert'", () => {
    _resetConfigSanityAlertForTests();
    registerConfigSanityAlertCron();
    const names = getRegisteredCrons().map((e) => e.name);
    expect(names).toContain("config-sanity-alert");
    _resetConfigSanityAlertForTests();
  });
});
