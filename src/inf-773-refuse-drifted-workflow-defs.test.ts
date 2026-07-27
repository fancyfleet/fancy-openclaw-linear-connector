/**
 * INF-773 — Gate: refuse-serving drifted workflow defs.
 *
 * AC map:
 *   AC1: a synthetic version-skewed workflow def is unsafe under the current
 *        observer-only fixture-drift path because the registry can serve it.
 *   AC2: loadWorkflowRegistry must refuse that def through the existing per-def
 *        fail-closed seam before registry.set.
 *   AC3: directory mode excludes only the drifted def while healthy defs remain
 *        available; single-file mode still rethrows/fails the whole primary.
 *   AC4: AC1.3/AC1.5 coverage: fixture reconcile/check failure cannot
 *        manufacture a green health result, and the red baseline proves
 *        observer-only drift detection was unsafe.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { checkDefAgainstFixture, resetFixtureDriftStatus, runFixtureDriftCheck } from "./fixture-drift-detector.js";
import { getStatus, isHealthy, resetConfigHealth } from "./config-health.js";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";

const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src", "registered-defs");

let tmpDir: string;
let defsDir: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
}

function registeredDef(name: string): string {
  return fs.readFileSync(path.join(REGISTERED_DEFS_DIR, `${name}.yaml`), "utf8");
}

function versionSkewedDevImpl(): string {
  const raw = registeredDef("dev-impl");
  if (!/^version:\s*\d+/m.test(raw)) {
    throw new Error("dev-impl fixture must declare a numeric version for INF-773");
  }
  return raw.replace(/^version:\s*\d+/m, "version: 999");
}

function writeDef(name: string, raw: string): string {
  const file = path.join(defsDir, `${name}.yaml`);
  fs.writeFileSync(file, raw, "utf8");
  return file;
}

beforeEach(() => {
  saveEnv(
    "WORKFLOW_DEFS_DIR",
    "WORKFLOW_DEF_DIR",
    "WORKFLOW_DEF_PATH",
    "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
    "DATA_DIR",
    "ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT",
  );
  // jest.setup.ts sets the suite-wide grace opt-out so synthetic defs load; this
  // dedicated test asserts the fail-closed refusal, so it opts back INTO
  // enforcement by clearing the grace flag (restored in afterEach via restoreEnv).
  delete process.env.ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-773-"));
  defsDir = path.join(tmpDir, "defs");
  fs.mkdirSync(defsDir, { recursive: true });
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(tmpDir, "def-state-snapshot.json");
  resetWorkflowCache();
  resetConfigHealth();
  resetFixtureDriftStatus();
});

afterEach(() => {
  restoreEnv();
  resetWorkflowCache();
  resetConfigHealth();
  resetFixtureDriftStatus();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("INF-773 loadWorkflowRegistry fixture-drift refusal", () => {
  test("AC1/AC2: version-skewed dev-impl is not served before fixture-drift observation", async () => {
    const drifted = versionSkewedDevImpl();
    writeDef("dev-impl", drifted);

    const fixtureCheck = await checkDefAgainstFixture("dev-impl", drifted);
    expect(fixtureCheck.fixtureExists).toBe(true);
    expect(fixtureCheck.inSync).toBe(false);
    expect(fixtureCheck.driftDescription).toContain("version");

    const registry = await loadWorkflowRegistry();

    // This is the core red baseline: current production serves the drifted def,
    // and only the observer path notices after the unsafe registry.set already happened.
    expect(registry.has("dev-impl")).toBe(false);
    expect(registry.get("dev-impl")?.version).not.toBe(999);
    expect(isHealthy()).toBe(false);
    expect(getStatus().artifacts["workflow-def"].lastError).toMatch(/drift|fixture|dev-impl/i);
  });

  test("AC3: directory mode excludes only the drifted def and keeps healthy defs available", async () => {
    writeDef("dev-impl", versionSkewedDevImpl());
    writeDef("task", registeredDef("task"));

    const taskCheck = await checkDefAgainstFixture("task", registeredDef("task"));
    expect(taskCheck.fixtureExists).toBe(true);
    expect(taskCheck.inSync).toBe(true);

    const registry = await loadWorkflowRegistry();

    expect(registry.has("dev-impl")).toBe(false);
    expect(registry.has("task")).toBe(true);
    expect(registry.get("task")?.id).toBe("task");
    expect(isHealthy()).toBe(false);
  });

  test("AC3: single-file mode rethrows and fails the whole primary on fixture drift", async () => {
    delete process.env.WORKFLOW_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_DIR;
    const primary = path.join(tmpDir, "primary-dev-impl.yaml");
    fs.writeFileSync(primary, versionSkewedDevImpl(), "utf8");
    process.env.WORKFLOW_DEF_PATH = primary;

    await expect(loadWorkflowRegistry()).rejects.toThrow(/drift|fixture|dev-impl/i);
    expect(isHealthy()).toBe(false);
    expect(getStatus().artifacts["workflow-def"].lastError).toMatch(/drift|fixture|dev-impl/i);
  });

  test("AC1.3/AC1.5: drift check failure cannot report green health after the loader refuses a def", async () => {
    writeDef("dev-impl", versionSkewedDevImpl());
    writeDef("task", registeredDef("task"));

    const registry = await loadWorkflowRegistry();
    expect(registry.has("dev-impl")).toBe(false);
    expect(registry.has("task")).toBe(true);

    const status = await runFixtureDriftCheck();

    expect(status.healthy).toBe(false);
    expect(status.drifted).toBeGreaterThan(0);
    expect(status.entries.some((entry) => entry.workflowId === "dev-impl")).toBe(true);
    expect(getStatus().healthy).toBe(false);
  });
});
