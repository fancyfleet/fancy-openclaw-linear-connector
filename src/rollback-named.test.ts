/**
 * INF-1332 Slice D — Named rollback (TDD RED phase).
 *
 * Tests MUST be RED on origin/main — no implementation exists yet.
 * Implementer (igor) will make them green. Every it() maps to an AC bullet.
 *
 * Substrate model (backup dirs from host-owned/bin/deploy-linear-connector.sh):
 *   checkpoints/<id>.json         — versioned checkpoint manifest
 *   dist.pre-deploy-<id>/         — retained artifact backup
 *   workflows.pre-deploy-<id>/    — retained workflow-definition backup
 *   live dist/ + workflows/ + health identity — production state under test
 *
 * Rollback contract under test: src/rollback.ts
 *   export async function rollbackToCheckpoint(opts: RollbackOptions): Promise<RollbackResult>
 *   export function parseRollbackArgs(argv: string[]): { checkpointId: string }
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// ── TDD RED: this module does not exist yet ──────────────────────────────
import {
  rollbackToCheckpoint,
  parseRollbackArgs,
  type RollbackOptions,
  type RollbackResult,
  type CheckpointManifest,
  type HealthIdentity,
} from "./rollback.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function digest(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

interface TmpLayout {
  tmpRoot: string;
  checkpointsDir: string;
  repoRoot: string; // where dist.pre-deploy-* and workflows.pre-deploy-* live
  distDir: string; // live dist/
  workflowsDir: string; // live workflows/
  shareDir: string; // where workflows.pre-deploy-* lives (SHARE)
}

async function mkLayout(): Promise<TmpLayout> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "inf1332-"));
  const checkpointsDir = path.join(tmpRoot, "checkpoints");
  const repoRoot = path.join(tmpRoot, "repo");
  const shareDir = path.join(tmpRoot, "share");
  const distDir = path.join(repoRoot, "dist");
  const workflowsDir = path.join(shareDir, "workflows");
  await fs.mkdir(checkpointsDir, { recursive: true });
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(shareDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(workflowsDir, { recursive: true });
  return { tmpRoot, checkpointsDir, repoRoot, distDir, workflowsDir, shareDir };
}

async function writeManifest(
  layout: TmpLayout,
  id: string,
  overrides: Partial<CheckpointManifest> = {},
): Promise<CheckpointManifest> {
  const manifest: CheckpointManifest = {
    version: 1,
    checkpointId: id,
    environment: "production",
    commit: "abc123deadbeef",
    artifactDigest: digest("artifact-A"),
    workflowDefDigest: digest("workflow-A"),
    configFingerprint: digest("config-A"),
    blessedAt: new Date().toISOString(),
    blessedBy: "alice",
    ...overrides,
  };
  await fs.writeFile(
    path.join(layout.checkpointsDir, `${id}.json`),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}

async function seedBackupSubstrate(
  layout: TmpLayout,
  id: string,
  artifactContent = "artifact-A",
  workflowContent = "workflow-A",
  configContent = "config-A",
): Promise<{ artifactDigest: string; workflowDigest: string; configFp: string }> {
  const artifactDigest = digest(artifactContent);
  const workflowDigest = digest(workflowContent);
  const configFp = digest(configContent);
  const distBackup = path.join(layout.repoRoot, `dist.pre-deploy-${id}`);
  const wfBackup = path.join(layout.shareDir, `workflows.pre-deploy-${id}`);
  await fs.mkdir(distBackup, { recursive: true });
  await fs.mkdir(wfBackup, { recursive: true });
  await fs.writeFile(path.join(distBackup, "index.js"), artifactContent, "utf8");
  await fs.writeFile(path.join(distBackup, "DEPLOY_COMMIT"), "abc123deadbeef", "utf8");
  await fs.writeFile(path.join(wfBackup, "dev-impl.yaml"), workflowContent, "utf8");
  return { artifactDigest, workflowDigest, configFp };
}

function makeHealthyIdentity(manifest: CheckpointManifest): HealthIdentity {
  return {
    checkpointId: manifest.checkpointId,
    commit: manifest.commit,
    artifactDigest: manifest.artifactDigest,
    workflowDefDigest: manifest.workflowDefDigest,
    configFingerprint: manifest.configFingerprint,
    matchesLive: {
      commit: true,
      artifact: true,
      definitions: true,
      config: true,
      overall: true,
    },
  };
}

function defaultVerifyHealth(identity: HealthIdentity) {
  return jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(identity);
}

// ── AC7: Interface shape ─────────────────────────────────────────────────

describe("INF-1332 AC7: rollback interface shape", () => {
  it("AC7: rollbackToCheckpoint is exported and callable", () => {
    expect(typeof rollbackToCheckpoint).toBe("function");
  });

  it("AC7: parseRollbackArgs requires --checkpoint and errors when missing", () => {
    expect(() => parseRollbackArgs([])).toThrow(/checkpoint/i);
    expect(() => parseRollbackArgs(["--help"])).toThrow(/checkpoint/i);
  });

  it("AC7: parseRollbackArgs resolves --checkpoint <id>", () => {
    const parsed = parseRollbackArgs(["--checkpoint", "chk-A"]);
    expect(parsed.checkpointId).toBe("chk-A");
  });

  it("AC7: parseRollbackArgs supports --checkpoint=<id> form", () => {
    const parsed = parseRollbackArgs(["--checkpoint=chk-B"]);
    expect(parsed.checkpointId).toBe("chk-B");
  });
});

// ── AC1: Happy path ──────────────────────────────────────────────────────

describe("INF-1332 AC1: happy path — resolves checkpoint, restores artifact+defs, verifies live identity", () => {
  let layout: TmpLayout;

  beforeEach(async () => {
    layout = await mkLayout();
  });

  afterEach(async () => {
    await fs.rm(layout.tmpRoot, { recursive: true, force: true });
  });

  it("AC1: resolves named checkpoint, restores dist artifact and workflow defs, restarts, and verifies exact live identity", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId, "artifact-A", "workflow-A");

    // live starts diverged (checkpoint B simulated) — rollback must overwrite
    await fs.writeFile(path.join(layout.distDir, "index.js"), "artifact-B", "utf8");
    await fs.writeFile(path.join(layout.workflowsDir, "dev-impl.yaml"), "workflow-B", "utf8");

    const verifyHealth = defaultVerifyHealth(makeHealthyIdentity(manifest));

    const result: RollbackResult = await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth,
    });

    // resolves correct backup dir — live dist now matches checkpoint artifact
    const liveArtifact = await fs.readFile(path.join(layout.distDir, "index.js"), "utf8");
    expect(liveArtifact).toBe("artifact-A");
    expect(digest(liveArtifact)).toBe(manifest.artifactDigest);

    // workflow def restored
    const liveWf = await fs.readFile(path.join(layout.workflowsDir, "dev-impl.yaml"), "utf8");
    expect(liveWf).toBe("workflow-A");
    expect(digest(liveWf)).toBe(manifest.workflowDefDigest);

    // restart/health verification happened and identity matches
    expect(verifyHealth).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.checkpointId).toBe(chkId);
    expect(result.healthIdentity?.matchesLive.overall).toBe(true);
    expect(result.healthIdentity?.artifactDigest).toBe(manifest.artifactDigest);
    expect(result.healthIdentity?.workflowDefDigest).toBe(manifest.workflowDefDigest);
    expect(result.healthIdentity?.commit).toBe(manifest.commit);
  });

  it("AC1: reports zero-gap restart verification was performed", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);
    const verifyHealth = defaultVerifyHealth(makeHealthyIdentity(manifest));

    const result = await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth,
    });

    expect(verifyHealth).toHaveBeenCalledTimes(1);
    expect(result.restartVerified).toBe(true);
  });
});

// ── AC6: Unknown checkpoint id fails loudly ─────────────────────────────────

describe("INF-1332 AC6: unknown checkpoint id fails loudly", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("AC6: resolving a non-existent checkpoint id throws with descriptive error", async () => {
    await expect(
      rollbackToCheckpoint({
        checkpointId: "does-not-exist",
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue({} as HealthIdentity),
      }),
    ).rejects.toThrow(/checkpoint.*not found|unknown checkpoint/i);
  });

  it("AC6: does not mutate live dist/workflows on unknown checkpoint", async () => {
    await fs.writeFile(path.join(layout.distDir, "index.js"), "live-B", "utf8");
    await expect(
      rollbackToCheckpoint({
        checkpointId: "ghost",
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue({} as HealthIdentity),
      }),
    ).rejects.toThrow(/checkpoint/i);

    const live = await fs.readFile(path.join(layout.distDir, "index.js"), "utf8");
    expect(live).toBe("live-B");
  });
});

// ── AC2: Missing artifact fails loudly ───────────────────────────────────────

describe("INF-1332 AC2: missing artifact fails loudly, production unchanged", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("AC2: missing dist backup aborts with /missing artifact/i", async () => {
    const chkId = "chk-A";
    await writeManifest(layout, chkId);
    // intentionally DO NOT seed dist backup
    const wfBackup = path.join(layout.shareDir, `workflows.pre-deploy-${chkId}`);
    await fs.mkdir(wfBackup, { recursive: true });
    await fs.writeFile(path.join(wfBackup, "dev-impl.yaml"), "workflow-A", "utf8");
    await fs.writeFile(path.join(layout.distDir, "index.js"), "live-B", "utf8");

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue({} as HealthIdentity),
      }),
    ).rejects.toThrow(/missing artifact/i);

    // production unchanged
    const live = await fs.readFile(path.join(layout.distDir, "index.js"), "utf8");
    expect(live).toBe("live-B");
  });

  it("AC2: incomplete dist backup (empty dir) also fails loudly", async () => {
    const chkId = "chk-A";
    await writeManifest(layout, chkId);
    await fs.mkdir(path.join(layout.repoRoot, `dist.pre-deploy-${chkId}`), { recursive: true });
    // empty — no files inside
    const wfBackup = path.join(layout.shareDir, `workflows.pre-deploy-${chkId}`);
    await fs.mkdir(wfBackup, { recursive: true });
    await fs.writeFile(path.join(wfBackup, "dev-impl.yaml"), "workflow-A", "utf8");

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue({} as HealthIdentity),
      }),
    ).rejects.toThrow(/missing artifact/i);
  });
});

// ── AC3: Identity mismatch fails loudly ───────────────────────────────────────

describe("INF-1332 AC3: identity mismatch after restore fails loudly", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("AC3: artifact digest mismatch -> loud identity-mismatch failure", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId, "artifact-A", "workflow-A");

    // health reports artifact mismatch
    const badIdentity: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      artifactDigest: digest("something-else"),
      matchesLive: { commit: true, artifact: false, definitions: true, config: true, overall: false },
    };

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(badIdentity),
      }),
    ).rejects.toThrow(/identity.*mismatch|mismatch.*identity|artifact.*mismatch/i);
  });

  it("AC3: workflow-definition digest mismatch -> loud failure", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId, "artifact-A", "workflow-A");

    const badIdentity: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      workflowDefDigest: digest("wrong-workflow"),
      matchesLive: { commit: true, artifact: true, definitions: false, config: true, overall: false },
    };

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(badIdentity),
      }),
    ).rejects.toThrow(/identity.*mismatch|definition.*mismatch|workflow.*mismatch/i);
  });

  it("AC3: commit mismatch -> loud failure", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const badIdentity: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      commit: "different-commit",
      matchesLive: { commit: false, artifact: true, definitions: true, config: true, overall: false },
    };

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(badIdentity),
      }),
    ).rejects.toThrow(/identity.*mismatch|commit.*mismatch/i);
  });

  it("AC3: config fingerprint mismatch -> loud failure", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const badIdentity: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      configFingerprint: digest("wrong-config"),
      matchesLive: { commit: true, artifact: true, definitions: true, config: false, overall: false },
    };

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(badIdentity),
      }),
    ).rejects.toThrow(/identity.*mismatch|config.*mismatch/i);
  });

  it("AC3: does not report success when matchesLive.overall is false", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const badIdentity: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      matchesLive: { commit: true, artifact: true, definitions: true, config: true, overall: false },
    };

    // Even if individual fields look ok, overall false must fail
    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(badIdentity),
      }),
    ).rejects.toThrow(/identity|mismatch|overall/i);
  });
});

// ── AC4: Unhealthy post-restart fails loudly ────────────────────────────────

describe("INF-1332 AC4: unhealthy post-restart fails loudly", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("AC4: health check returning unhealthy throws loudly", async () => {
    const chkId = "chk-A";
    await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const unhealthy: HealthIdentity = {
      checkpointId: chkId,
      commit: "abc123deadbeef",
      artifactDigest: digest("artifact-A"),
      workflowDefDigest: digest("workflow-A"),
      configFingerprint: digest("config-A"),
      healthy: false,
      statusCode: 503,
      matchesLive: { commit: true, artifact: true, definitions: true, config: true, overall: false },
    } as unknown as HealthIdentity;

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(unhealthy),
      }),
    ).rejects.toThrow(/unhealthy|health|not.*healthy|degraded|503/i);
  });

  it("AC4: verifyHealth throwing/rejecting surfaces as loud failure", async () => {
    const chkId = "chk-A";
    await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockRejectedValue(new Error("health endpoint unreachable")),
      }),
    ).rejects.toThrow(/health|unreachable|restart|verification/i);
  });

  it("AC4: matchesLive false is treated as unhealthy even with 200", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const degraded: HealthIdentity = {
      ...makeHealthyIdentity(manifest),
      statusCode: 200,
      healthy: true,
      matchesLive: { commit: true, artifact: false, definitions: true, config: true, overall: false },
    } as unknown as HealthIdentity;

    await expect(
      rollbackToCheckpoint({
        checkpointId: chkId,
        checkpointsDir: layout.checkpointsDir,
        repoRoot: layout.repoRoot,
        shareDir: layout.shareDir,
        distDir: layout.distDir,
        workflowsDir: layout.workflowsDir,
        verifyHealth: jest.fn<() => Promise<HealthIdentity>>().mockResolvedValue(degraded),
      }),
    ).rejects.toThrow(/identity|mismatch|unhealthy|overall/i);
  });
});

// ── AC5: Newer workflow states warn, never auto-rewound ────────────────────

describe("INF-1332 AC5: newer workflow states warn and require manual handling, never auto-rewound", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("AC5: issues in newer workflow states remain unchanged after rollback", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    // Simulate newer workflow states that the older engine cannot interpret
    const newerIssues = [
      { id: "INF-999", workflowState: "in_review", workflowVersion: 2 },
      { id: "INF-1000", workflowState: "blocked", workflowVersion: 3 },
    ];
    const issueStore = {
      issues: [...newerIssues],
      getIssues: jest.fn(() => newerIssues),
      updateIssue: jest.fn(),
    };

    const verifyHealth = defaultVerifyHealth(makeHealthyIdentity(manifest));

    const result = await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth,
      issueStore: issueStore as unknown as RollbackOptions["issueStore"],
    });

    // No auto-mutation: updateIssue never called for newer-state issues
    expect(issueStore.updateIssue).not.toHaveBeenCalled();
    // Issues still present and unchanged
    expect(issueStore.issues).toEqual(newerIssues);
    // Warnings emitted for each newer-state issue
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    const warningText = result.warnings.join(" ");
    expect(warningText).toMatch(/newer|unknown|manual/i);
  });

  it("AC5: warnings identify the affected issues requiring manual handling", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const newerIssues = [{ id: "INF-2000", workflowState: "future_state", workflowVersion: 99 }];
    const issueStore = {
      issues: [...newerIssues],
      getIssues: jest.fn(() => newerIssues),
      updateIssue: jest.fn(),
    };

    const result = await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth: defaultVerifyHealth(makeHealthyIdentity(manifest)),
      issueStore: issueStore as unknown as RollbackOptions["issueStore"],
    });

    expect(result.warnings.join(" ")).toMatch(/INF-2000|future_state|manual/i);
    expect(issueStore.updateIssue).not.toHaveBeenCalled();
  });

  it("AC5: no warning when there are no newer states, and still no mutation", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId);

    const issueStore = {
      issues: [] as unknown[],
      getIssues: jest.fn(() => []),
      updateIssue: jest.fn(),
    };

    const result = await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth: defaultVerifyHealth(makeHealthyIdentity(manifest)),
      issueStore: issueStore as unknown as RollbackOptions["issueStore"],
    });

    expect(result.warnings).toEqual([]);
    expect(issueStore.updateIssue).not.toHaveBeenCalled();
  });
});

// ── AC1 extended: staging isolation ───────────────────────────────────────

describe("INF-1332 staging isolation — rollback does not mutate staging", () => {
  let layout: TmpLayout;
  beforeEach(async () => { layout = await mkLayout(); });
  afterEach(async () => { await fs.rm(layout.tmpRoot, { recursive: true, force: true }); });

  it("staging state dir/files remain untouched after production rollback", async () => {
    const chkId = "chk-A";
    const manifest = await writeManifest(layout, chkId);
    await seedBackupSubstrate(layout, chkId, "artifact-A", "workflow-A");

    // Create a separate staging dist
    const stagingDist = path.join(layout.tmpRoot, "staging-dist");
    await fs.mkdir(stagingDist, { recursive: true });
    await fs.writeFile(path.join(stagingDist, "index.js"), "staging-artifact", "utf8");

    await rollbackToCheckpoint({
      checkpointId: chkId,
      checkpointsDir: layout.checkpointsDir,
      repoRoot: layout.repoRoot,
      shareDir: layout.shareDir,
      distDir: layout.distDir,
      workflowsDir: layout.workflowsDir,
      verifyHealth: defaultVerifyHealth(makeHealthyIdentity(manifest)),
      stagingDistDir: stagingDist,
    });

    const stagingContent = await fs.readFile(path.join(stagingDist, "index.js"), "utf8");
    expect(stagingContent).toBe("staging-artifact");
  });
});
