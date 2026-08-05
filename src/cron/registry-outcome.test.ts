/**
 * INF-1213 — Failing tests: cron registry outcome signal.
 *
 * Tests the concept the AC requires: the registry must record run outcome
 * (success/failure) per run, and that outcome must be surfaced via
 * getRegisteredCrons(). Implementation shape is the implementer's choice.
 *
 * These tests MUST FAIL against current code (registry.ts has no outcome).
 * They should PASS once the implementer adds outcome tracking.
 */

import { jest } from "@jest/globals";
import {
  registerCron,
  getRegisteredCrons,
  resetCronRegistryForTest,
  markCronRun,
} from "./registry.js";

describe("INF-1213: cron registry records outcome per run (AC1)", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("CronRegistryEntry includes a lastRunOutcome field after a run is recorded", () => {
    registerCron("test-cron", "every 5m");
    // The registry currently has markCronRun(name, now?) — no outcome.
    // After the implementation, calling the run-stamp with outcome must
    // populate a lastRunOutcome field on the entry.
    markCronRun("test-cron", { outcome: "success" } as Parameters<typeof markCronRun>[1]);
    const entry = getRegisteredCrons().find((e) => e.name === "test-cron");
    // AC1: entry must carry an outcome field with a value
    expect(entry).toHaveProperty("lastRunOutcome");
    expect(entry?.lastRunOutcome).toBe("success");
  });

  test("lastRunOutcome is null before any run is recorded", () => {
    registerCron("test-cron", "every 5m");
    const entry = getRegisteredCrons().find((e) => e.name === "test-cron");
    expect(entry).toHaveProperty("lastRunOutcome");
    expect(entry?.lastRunOutcome).toBeNull();
  });

  test("registry records a failure outcome", () => {
    registerCron("test-cron", "every 5m");
    markCronRun("test-cron", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);
    const entry = getRegisteredCrons().find((e) => e.name === "test-cron");
    expect(entry?.lastRunOutcome).toBe("failure");
  });

  test("outcome overwrites on each run (latest wins)", () => {
    registerCron("test-cron", "every 5m");
    markCronRun("test-cron", { outcome: "success" } as Parameters<typeof markCronRun>[1]);
    markCronRun("test-cron", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);
    const entry = getRegisteredCrons().find((e) => e.name === "test-cron");
    expect(entry?.lastRunOutcome).toBe("failure");
  });
});

describe("INF-1213 AC6: regression — failure distinguishable from success", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("repeated failures are reflected in registry, not just a recent timestamp", () => {
    registerCron("flaky-cron", "every 1m");

    // Simulate repeated throws — all failures
    for (let i = 0; i < 5; i++) {
      markCronRun("flaky-cron", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);
    }

    const entry = getRegisteredCrons().find((e) => e.name === "flaky-cron");
    // AC6: a consumer can tell this is FAILURE, not success
    expect(entry?.lastRunOutcome).toBe("failure");
    expect(entry?.lastRunAt).not.toBeNull();
  });

  test("a success after failures updates the outcome to success", () => {
    registerCron("recovering-cron", "every 1m");

    markCronRun("recovering-cron", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);
    markCronRun("recovering-cron", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);
    markCronRun("recovering-cron", { outcome: "success" } as Parameters<typeof markCronRun>[1]);

    const entry = getRegisteredCrons().find((e) => e.name === "recovering-cron");
    expect(entry?.lastRunOutcome).toBe("success");
  });
});

describe("INF-1213 AC4: /health surfaces outcome via getRegisteredCrons", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("getRegisteredCrons returns entries with lastRunOutcome populated after runs", () => {
    registerCron("cron-a", "every 5m");
    registerCron("cron-b", "every 10m");

    markCronRun("cron-a", { outcome: "success" } as Parameters<typeof markCronRun>[1]);
    markCronRun("cron-b", { outcome: "failure" } as Parameters<typeof markCronRun>[1]);

    const crons = getRegisteredCrons();
    const a = crons.find((e) => e.name === "cron-a");
    const b = crons.find((e) => e.name === "cron-b");

    expect(a?.lastRunOutcome).toBe("success");
    expect(b?.lastRunOutcome).toBe("failure");
  });

  test("unrun crons have null lastRunOutcome in getRegisteredCrons", () => {
    registerCron("never-run", "every 1h");
    const entry = getRegisteredCrons().find((e) => e.name === "never-run");
    expect(entry?.lastRunOutcome).toBeNull();
    expect(entry?.lastRunAt).toBeNull();
  });
});

describe("INF-1213 AC2: markCronRun requires outcome — old signature must not silently succeed", () => {
  beforeEach(() => resetCronRegistryForTest());
  afterEach(() => resetCronRegistryForTest());

  test("calling markCronRun(name) without outcome records no outcome (currently passes — implementation must make this path impossible)", () => {
    registerCron("test-cron", "every 5m");
    // Current behavior: markCronRun(name) succeeds and sets lastRunAt but no outcome.
    // After implementation, this call path must either:
    // (a) not exist (markCronRun requires outcome), or
    // (b) explicitly NOT be used by call sites (they use the outcome variant).
    //
    // This test documents current behavior and will need adjustment once
    // the implementation changes the signature. For now, it verifies that
    // the current markCronRun(name) path does NOT record outcome.
    markCronRun("test-cron");
    const entry = getRegisteredCrons().find((e) => e.name === "test-cron");
    expect(entry).toHaveProperty("lastRunOutcome");
    // Current code has no lastRunOutcome — so it's undefined, not null
    // After implementation: either this call doesn't compile, or outcome is null/not-set
    expect(entry?.lastRunOutcome).toBeNull();
  });
});
