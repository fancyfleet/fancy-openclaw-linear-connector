/**
 * AI-1914 — AC3 wired on the real registry-load path (revision follow-up).
 *
 * The module-level tests in ai-1914-def-state-migration.test.ts prove
 * `validateDefStateRemovals` in isolation, but ac-validate found the validator
 * had ZERO production call sites — editing a def to remove a state and reloading
 * activated it silently (the AI-1775/AI-1808 "tested green, never called" shape).
 *
 * These tests prove refusal THROUGH `loadWorkflowRegistry` — the actual load
 * path — for both deploy modes, and prove the guard is armed from the production
 * entry point (createApp) so the check is not silently off in production.
 *
 * Design notes (see def-state-snapshot-store.ts):
 *   - `previousStateIds` comes from a persisted, restart-durable snapshot of the
 *     last activated version's state set (disk-backed under DATA_DIR). We
 *     simulate a restart with clearDefStateSnapshotStore() (drops the in-memory
 *     cache; the on-disk baseline remains) before loading the removing version.
 *   - "Does not activate" follows the AI-1530 per-def posture: dir mode excludes
 *     the def + records a config-health failure; single-file mode rethrows.
 *   - The guard is armed explicitly here (production arms it in createApp); the
 *     general unit-test population never arms it, so unrelated fixtures sharing a
 *     def id are not diffed against each other.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  loadWorkflowRegistry,
  resetWorkflowCache,
} from "./workflow-gate.js";
import {
  armDefStateRemovalGuard,
  disarmDefStateRemovalGuard,
  clearDefStateSnapshotStore,
  isDefStateRemovalGuardArmed,
} from "./def-state-snapshot-store.js";
import { resetConfigHealth, isHealthy } from "./config-health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A valid dev-impl def. `extraState` (default present) lets us build v(N) with a
// state that v(N+1) drops. `migrations` / `strandAck` opt into a sanctioned path
// for the dropped state.
function devImplYaml(opts: {
  version: number;
  includeReview?: boolean;
  migrations?: Record<string, string>;
  strandAck?: string[];
}): string {
  const { version, includeReview = true, migrations, strandAck } = opts;
  const reviewState = includeReview
    ? `  - id: code-review
    owner_role: dev
    native_state: doing
    transitions:
      - command: approve
        to: done
`
    : "";
  const implTarget = includeReview ? "code-review" : "done";
  const migrationsBlock = migrations
    ? `migrations:\n${Object.entries(migrations).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`
    : "";
  const strandBlock = strandAck ? `strand_acknowledged:\n${strandAck.map((s) => `  - ${s}`).join("\n")}\n` : "";
  return `
id: dev-impl
version: ${version}
entry_state: intake
${migrationsBlock}${strandBlock}states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ${implTarget}
${reviewState}  - id: done
    native_state: done
    transitions: []
  - id: escape
    native_state: invalid
    transitions: []
`;
}

let tmpDir: string;
let savedDefsDir: string | undefined;
let savedDefPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-ac3-loadpath-"));
  savedDefsDir = process.env.WORKFLOW_DEFS_DIR;
  savedDefPath = process.env.WORKFLOW_DEF_PATH;
  resetWorkflowCache();
  clearDefStateSnapshotStore();
  resetConfigHealth();
  armDefStateRemovalGuard();
});

afterEach(() => {
  disarmDefStateRemovalGuard();
  clearDefStateSnapshotStore();
  resetWorkflowCache();
  if (savedDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
  else process.env.WORKFLOW_DEFS_DIR = savedDefsDir;
  if (savedDefPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
  else process.env.WORKFLOW_DEF_PATH = savedDefPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Simulate a connector restart: drop the in-memory registry + snapshot caches
 *  so the next load re-reads the durable on-disk snapshot baseline. */
function simulateRestart(): void {
  resetWorkflowCache(); // also clears the in-memory snapshot cache
}

// ── Dir mode: removal without a path ⇒ def excluded + config-health failure ────

describe("AC3 (dir mode): loadWorkflowRegistry refuses a def that removes a state without a path", () => {
  function writeDef(yaml: string): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, "defs-"));
    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), yaml, "utf8");
    return dir;
  }

  it("v(N+1) removing a state with NO migration/strand-ack is excluded; the prior def is not replaced", async () => {
    // v(N): code-review present → activate, recording the durable snapshot.
    process.env.WORKFLOW_DEFS_DIR = writeDef(devImplYaml({ version: 1 }));
    const r1 = await loadWorkflowRegistry();
    expect(r1.has("dev-impl")).toBe(true);
    expect(r1.get("dev-impl")!.states.some((s) => s.id === "code-review")).toBe(true);

    // v(N+1): code-review removed, no migrations, no strand-ack. Restart, reload.
    process.env.WORKFLOW_DEFS_DIR = writeDef(devImplYaml({ version: 2, includeReview: false }));
    simulateRestart();
    const r2 = await loadWorkflowRegistry();

    // Fail-closed: the unsafe def is excluded from the registry (does not activate).
    expect(r2.has("dev-impl")).toBe(false);
    // Per-def fail-closed surfaces via config-health.
    expect(isHealthy()).toBe(false);
  });

  it("v(N+1) removing a state WITH a migrations mapping activates normally", async () => {
    process.env.WORKFLOW_DEFS_DIR = writeDef(devImplYaml({ version: 1 }));
    await loadWorkflowRegistry();

    process.env.WORKFLOW_DEFS_DIR = writeDef(
      devImplYaml({ version: 2, includeReview: false, migrations: { "code-review": "done" } }),
    );
    simulateRestart();
    const r2 = await loadWorkflowRegistry();

    expect(r2.has("dev-impl")).toBe(true);
    expect(r2.get("dev-impl")!.states.some((s) => s.id === "code-review")).toBe(false);
  });

  it("v(N+1) removing a state listed under strand_acknowledged activates normally", async () => {
    process.env.WORKFLOW_DEFS_DIR = writeDef(devImplYaml({ version: 1 }));
    await loadWorkflowRegistry();

    process.env.WORKFLOW_DEFS_DIR = writeDef(
      devImplYaml({ version: 2, includeReview: false, strandAck: ["code-review"] }),
    );
    simulateRestart();
    const r2 = await loadWorkflowRegistry();

    expect(r2.has("dev-impl")).toBe(true);
  });

  it("re-activating the SAME def version is idempotent (no false removal)", async () => {
    process.env.WORKFLOW_DEFS_DIR = writeDef(devImplYaml({ version: 1 }));
    await loadWorkflowRegistry();
    simulateRestart();
    const r2 = await loadWorkflowRegistry();
    expect(r2.has("dev-impl")).toBe(true);
    expect(isHealthy()).toBe(true);
  });
});

// ── Single-file mode: removal without a path ⇒ loadWorkflowRegistry rethrows ───

describe("AC3 (single-file mode): loadWorkflowRegistry rethrows on unsafe state removal", () => {
  it("v(N+1) removing a state with no path throws a clear error naming the state and the fix", async () => {
    const defFile = path.join(tmpDir, "dev-impl.yaml");
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = defFile;

    fs.writeFileSync(defFile, devImplYaml({ version: 1 }), "utf8");
    const r1 = await loadWorkflowRegistry();
    expect(r1.has("dev-impl")).toBe(true);

    fs.writeFileSync(defFile, devImplYaml({ version: 2, includeReview: false }), "utf8");
    simulateRestart();

    await expect(loadWorkflowRegistry()).rejects.toThrow(/code-review/);
    // config-health records the failure too.
    expect(isHealthy()).toBe(false);
  });

  it("the error points the operator at the sanctioned migration path", async () => {
    const defFile = path.join(tmpDir, "dev-impl.yaml");
    delete process.env.WORKFLOW_DEFS_DIR;
    process.env.WORKFLOW_DEF_PATH = defFile;

    fs.writeFileSync(defFile, devImplYaml({ version: 1 }), "utf8");
    await loadWorkflowRegistry();

    fs.writeFileSync(defFile, devImplYaml({ version: 2, includeReview: false }), "utf8");
    simulateRestart();

    await expect(loadWorkflowRegistry()).rejects.toThrow(/migrations|strand_acknowledged/);
  });
});

// ── Guard is off by default; unrelated loads are not diffed ───────────────────

describe("AC3: the removal guard is not armed for the general test population", () => {
  it("with the guard disarmed, a state-reducing reload is NOT blocked (test-isolation gate)", async () => {
    disarmDefStateRemovalGuard();
    const dir1 = fs.mkdtempSync(path.join(tmpDir, "u1-"));
    fs.writeFileSync(path.join(dir1, "dev-impl.yaml"), devImplYaml({ version: 1 }), "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir1;
    await loadWorkflowRegistry();

    const dir2 = fs.mkdtempSync(path.join(tmpDir, "u2-"));
    fs.writeFileSync(path.join(dir2, "dev-impl.yaml"), devImplYaml({ version: 2, includeReview: false }), "utf8");
    process.env.WORKFLOW_DEFS_DIR = dir2;
    simulateRestart();
    const r2 = await loadWorkflowRegistry();

    // Not armed → the reducing def loads (this is why unrelated unit tests that
    // reuse the "dev-impl" id are unaffected).
    expect(r2.has("dev-impl")).toBe(true);
  });
});

// ── Production wiring: createApp arms the guard (AI-1808 anti-pattern guard) ───

describe("AC3: the guard is armed from the production entry point", () => {
  const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

  it("index.ts imports armDefStateRemovalGuard from the snapshot store", () => {
    expect(
      /armDefStateRemovalGuard.*from\s*"\.\/def-state-snapshot-store\.js"/s.test(INDEX_TS),
    ).toBe(true);
  });

  it("index.ts calls armDefStateRemovalGuard() in createApp", () => {
    expect(INDEX_TS.includes("armDefStateRemovalGuard()")).toBe(true);
  });

  it("booting createApp arms the guard (reachable from the entry point, not a dead module)", async () => {
    disarmDefStateRemovalGuard();
    expect(isDefStateRemovalGuardArmed()).toBe(false);

    const bootDir = fs.mkdtempSync(path.join(tmpDir, "boot-"));
    fs.writeFileSync(path.join(bootDir, "dev-impl.yaml"), devImplYaml({ version: 1 }), "utf8");
    process.env.WORKFLOW_DEF_PATH = path.join(bootDir, "dev-impl.yaml");
    delete process.env.WORKFLOW_DEFS_DIR;
    const policyFile = path.join(bootDir, "capability-policy.yaml");
    fs.writeFileSync(
      policyFile,
      `capabilities:\n  - id: linear:transition\ncontainers:\n  - id: steward\n    grants: [linear:transition]\nroles:\n  - id: steward\n    requires: [linear:transition]\nbodies:\n  - id: astrid\n    container: steward\n    fills_roles: [steward]\n`,
      "utf8",
    );
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    const agentsFile = path.join(bootDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [{ name: "ai", linearUserId: "user-ai", openclawAgent: "ai", accessToken: "tok-ai", host: "local" }] }),
      "utf8",
    );
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_API_KEY = "test-key";
    process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ac3";
    process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ac3";

    const { createApp } = await import("./index.js");
    const { reloadAgents } = await import("./agents.js");
    const { resetPolicyCache } = await import("./escalation-gate.js");
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();

    createApp();
    expect(isDefStateRemovalGuardArmed()).toBe(true);
  });
});
