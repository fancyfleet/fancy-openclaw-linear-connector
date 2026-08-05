/**
 * INF-1264 AC1/AC4 — live↔main deploy-drift detection, unit level.
 *
 * "No silent merged-but-not-live drift" (AC1) and "live↔main drift raises an
 * alert" (AC4) require a checker that compares the commit the running process
 * reports (the /health.commit value, sourced from resolveStartupCommit()) against
 * the tip of origin/main, and either surfaces the gap loudly or auto-remediates.
 *
 * src/deploy-drift.ts does not exist yet — every test here dynamic-imports it so
 * this file fails with a clean "module not found" rather than a parse-time crash,
 * and so the sibling bootstrap-wiring test (INF-1264-deploy-drift-bootstrap.test.ts)
 * can independently assert the index.ts wiring without double failure noise.
 *
 * Contract under test: `checkDeployDrift(opts)` where opts supplies
 * `getLiveCommit: () => Promise<string>` and `getMainCommit: () => Promise<string>`
 * (both injected so the test never touches real git/network), returning
 * `{ liveCommit, mainCommit, driftDetected, alertRaised, checkedAt }`.
 */

import { describe, it, expect } from "@jest/globals";

type DeployDriftModule = typeof import("./deploy-drift.js");

async function loadModule(): Promise<DeployDriftModule> {
  return import("./deploy-drift.js");
}

describe("checkDeployDrift (AC1/AC4)", () => {
  it("reports no drift and raises no alert when live commit matches main", async () => {
    const mod = await loadModule();
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => "abc1234",
    });
    expect(result.driftDetected).toBe(false);
    expect(result.alertRaised).toBe(false);
    expect(result.liveCommit).toBe("abc1234");
    expect(result.mainCommit).toBe("abc1234");
  });

  it("reports drift and raises an alert when live commit diverges from main (AC1: loudly surfaced)", async () => {
    const mod = await loadModule();
    let alertedWith: unknown = null;
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "old0001",
      getMainCommit: async () => "new9999",
      onDrift: (info: unknown) => {
        alertedWith = info;
      },
    });
    expect(result.driftDetected).toBe(true);
    expect(result.alertRaised).toBe(true);
    expect(result.liveCommit).toBe("old0001");
    expect(result.mainCommit).toBe("new9999");
    // The alert callback must actually have been invoked with the drift, not just
    // a boolean flag flipped internally — an alert nobody receives is not loud.
    expect(alertedWith).not.toBeNull();
  });

  it("does not silently report healthy (no-drift) when the main commit cannot be resolved", async () => {
    const mod = await loadModule();
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => {
        throw new Error("network unreachable");
      },
    });
    // A failure to resolve one side must never collapse to driftDetected: false —
    // that would be a false-positive "all healthy" during an outage of the check
    // itself, the exact silent-drift failure mode AC1 exists to close.
    expect(result.driftDetected).not.toBe(false);
    expect(result.mainCommit).toBeNull();
  });

  it("does not silently report healthy (no-drift) when the live commit cannot be resolved", async () => {
    const mod = await loadModule();
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => {
        throw new Error("stamp unreadable");
      },
      getMainCommit: async () => "new9999",
    });
    expect(result.driftDetected).not.toBe(false);
    expect(result.liveCommit).toBeNull();
  });

  it("records a checkedAt timestamp for every invocation (feeds /health.deployDrift.lastCheckAt)", async () => {
    const mod = await loadModule();
    const before = Date.now();
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => "abc1234",
    });
    expect(typeof result.checkedAt).toBe("string");
    expect(Date.parse(result.checkedAt)).toBeGreaterThanOrEqual(before);
  });

  // Production asymmetry (found live on PR #696 / commit 34e8130c): `git rev-parse
  // --short HEAD` (live side, via resolveStartupCommit) picks a dynamic
  // disambiguation length that can exceed 7 chars, while resolveMainCommit()
  // hardcodes .slice(0, 7). Same commit, different abbreviation lengths, must
  // NOT be reported as drift.
  it("does not report drift when live and main are different-length abbreviations of the same commit", async () => {
    const mod = await loadModule();
    let alerted = false;
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "34e8130c",
      getMainCommit: async () => "34e8130",
      onDrift: () => {
        alerted = true;
      },
    });
    expect(result.driftDetected).toBe(false);
    expect(result.alertRaised).toBe(false);
    expect(alerted).toBe(false);
    expect(result.liveCommit).toBe("34e8130c");
    expect(result.mainCommit).toBe("34e8130");
  });

  it("still reports drift when different-length commits do not share a common prefix", async () => {
    const mod = await loadModule();
    const result = await mod.checkDeployDrift({
      getLiveCommit: async () => "abc1234",
      getMainCommit: async () => "9999999x",
    });
    expect(result.driftDetected).toBe(true);
    expect(result.alertRaised).toBe(true);
  });
});
