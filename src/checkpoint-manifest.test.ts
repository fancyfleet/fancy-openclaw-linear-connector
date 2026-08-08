/**
 * INF-1329 Slice A — Checkpoint manifest and health identity — failing tests.
 *
 * AC: checkpoint-manifest.json is created for a built artifact — atomic and
 * versioned — binding commit + artifact digest + workflow-def digests +
 * redacted config/secret fingerprints + blessedAt/blessedBy, and is served
 * via GET /health.checkpoint with live recomputation and matchesLive booleans.
 * Tests fail when commit is correct but artifact/workflow-defs/config differ
 * (matchesLive must be false independently — commit-match alone never blesses).
 * Production bootstrap integration proves manifest is registered from the real
 * entry point (not a test-only harness).
 *
 * TDD RED: this file MUST fail before implementation (module/route absent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// ── a) Manifest shape: atomic, versioned, binds required fields, redacts secrets ─

describe("INF-1329: checkpoint manifest shape + atomicity", () => {
  it("manifest module exposes create/write that binds all required fields", async () => {
    const mod = await import("./checkpoint-manifest.js");
    expect(mod).toHaveProperty("createCheckpointManifest");
    expect(typeof (mod as any).createCheckpointManifest).toBe("function");

    const manifest = (mod as any).createCheckpointManifest({
      commit: "abc123def456",
      artifactDigest: "sha256:artifact",
      workflowDefinitionsDigest: "sha256:defs",
      configFingerprint: "sha256:config",
    });

    // Required manifest fields (scope section 2)
    for (const field of [
      "checkpointId",
      "environment",
      "createdAt",
      "blessedAt",
      "blessedBy",
      "promotedFrom",
      "commit",
      "artifactDigest",
      "lockfileDigest",
      "version",
    ]) {
      expect(manifest).toHaveProperty(field);
    }
    expect(manifest.version).toBeDefined();
  });

  it("manifest is versioned and exposes version field", async () => {
    const mod = await import("./checkpoint-manifest.js");
    const m = (mod as any).createCheckpointManifest({
      commit: "abc123",
      artifactDigest: "sha256:a",
      workflowDefinitionsDigest: "sha256:b",
      configFingerprint: "sha256:c",
    });
    expect(typeof m.version).toBe("number");
    expect(m.version).toBeGreaterThanOrEqual(1);
  });

  it("manifest redacts secrets — no raw secret values appear", async () => {
    const mod = await import("./checkpoint-manifest.js");
    const secret = "super-secret-linear-token-xyz-999";
    const m = (mod as any).createCheckpointManifest({
      commit: "abc123",
      artifactDigest: "sha256:a",
      workflowDefinitionsDigest: "sha256:b",
      configFingerprint: "sha256:c",
      secrets: { LINEAR_OAUTH_TOKEN: secret },
    });
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain(secret);
    // Fingerprint/digest for the secret identity should exist instead
    expect(serialized.length).toBeGreaterThan(0);
  });

  it("manifest write is atomic — write-temp-then-rename, no partial file", async () => {
    const mod = await import("./checkpoint-manifest.js");
    expect(mod).toHaveProperty("writeCheckpointManifest");
    expect(typeof (mod as any).writeCheckpointManifest).toBe("function");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chk-manifest-"));
    const dest = path.join(dir, "checkpoint-manifest.json");
    const manifest = (mod as any).createCheckpointManifest({
      commit: "abc123",
      artifactDigest: "sha256:a",
      workflowDefinitionsDigest: "sha256:b",
      configFingerprint: "sha256:c",
    });

    // Spy on fs rename/write pattern: the module must write to a temp then rename
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const origWriteFileSync = fs.writeFileSync;
    const origRenameSync = fs.renameSync;
    let writeCall = 0;
    (fs as any).writeFileSync = (p: string, ...args: any[]) => {
      writes.push(p);
      // Simulate failure on first write is NOT needed — just record that temp was used
      return origWriteFileSync(p, ...args);
    };
    (fs as any).renameSync = (a: string, b: string) => {
      renames.push([a, b]);
      return origRenameSync(a, b);
    };
    try {
      await (mod as any).writeCheckpointManifest(dest, manifest);
      // Must have written to a temp path, then renamed to dest
      expect(writes.some((p) => p !== dest)).toBe(true);
      expect(renames.some(([, b]) => b === dest)).toBe(true);
      // Final file exists and is valid JSON
      const raw = fs.readFileSync(dest, "utf8");
      expect(JSON.parse(raw)).toHaveProperty("checkpointId");
    } finally {
      (fs as any).writeFileSync = origWriteFileSync;
      (fs as any).renameSync = origRenameSync;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── b) HTTP contract: GET /health.checkpoint returns manifest + live recomputation ─

describe("INF-1329: GET /health.checkpoint contract", () => {
  it("GET /health.checkpoint is reachable and returns correct shape with matchesLive", async () => {
    const { createApp } = await import("./index.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chk-health-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [{ name: "ai", linearUserId: "user-ai", openclawAgent: "ai", accessToken: "tok", host: "local" }] }),
      "utf8",
    );
    const prevAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;

    // Minimal valid defs so boot doesn't throw
    const defYaml = `
id: dev-impl
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions: [{ command: accept, to: done }]
  - id: done
    native_state: done
    transitions: []
`;
    const policyYaml = `
capabilities: [{ id: linear:transition }]
containers: [{ id: steward, grants: [linear:transition] }]
roles: [{ id: steward, requires: [linear:transition] }]
bodies: [{ id: astrid, container: steward, fills_roles: [steward] }]
`;
    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), defYaml, "utf8");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
    const prevDef = process.env.WORKFLOW_DEF_PATH;
    const prevCap = process.env.CAPABILITY_POLICY_PATH;
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");

    const { reloadAgents } = await import("./agents.js");
    const { resetPolicyCache } = await import("./escalation-gate.js");
    const { resetWorkflowCache } = await import("./workflow-gate.js");
    resetPolicyCache();
    resetWorkflowCache();
    reloadAgents();

    const state = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    try {
      const res = await request(state.app).get("/health.checkpoint");
      expect(res.status).toBe(200);
      // Must expose manifest + live recomputation with matchesLive booleans
      expect(res.body).toHaveProperty("manifest");
      expect(res.body).toHaveProperty("live");
      expect(res.body).toHaveProperty("matchesLive");
      const ml = res.body.matchesLive;
      for (const k of ["commit", "artifact", "workflowDefinitions", "config", "overall"]) {
        expect(ml).toHaveProperty(k);
        expect(typeof ml[k]).toBe("boolean");
      }
    } finally {
      try {
        state.bag.close();
        state.sessionTracker.close();
        state.agentQueue.close();
        state.operationalEventStore.close();
        state.watchdog.stop();
        state.noActivityDetector.stop();
        state.managingPoller.stop();
      } catch {}
      if (prevAgentsFile === undefined) delete process.env.AGENTS_FILE;
      else process.env.AGENTS_FILE = prevAgentsFile;
      if (prevDef === undefined) delete process.env.WORKFLOW_DEF_PATH;
      else process.env.WORKFLOW_DEF_PATH = prevDef;
      if (prevCap === undefined) delete process.env.CAPABILITY_POLICY_PATH;
      else process.env.CAPABILITY_POLICY_PATH = prevCap;
      reloadAgents();
      resetPolicyCache();
      resetWorkflowCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── c) Negative cases: commit-match alone never blesses ─────────────────────

describe("INF-1329: commit-match alone never blesses — independent mismatches", () => {
  it("commit matches but artifact differs → matchesLive.artifact=false and overall=false", async () => {
    const mod = await import("./checkpoint-manifest.js");
    expect(mod).toHaveProperty("computeLiveMatches");
    const result = (mod as any).computeLiveMatches(
      { commit: "abc123", artifactDigest: "sha256:stored", workflowDefinitionsDigest: "sha256:defs", configFingerprint: "sha256:cfg" },
      { commit: "abc123", artifactDigest: "sha256:DIFFERENT", workflowDefinitionsDigest: "sha256:defs", configFingerprint: "sha256:cfg" },
    );
    expect(result.commit).toBe(true);
    expect(result.artifact).toBe(false);
    expect(result.overall).toBe(false);
  });

  it("commit matches but workflow defs differ → matchesLive.workflowDefinitions=false and overall=false", async () => {
    const mod = await import("./checkpoint-manifest.js");
    const result = (mod as any).computeLiveMatches(
      { commit: "abc123", artifactDigest: "sha256:a", workflowDefinitionsDigest: "sha256:stored-defs", configFingerprint: "sha256:cfg" },
      { commit: "abc123", artifactDigest: "sha256:a", workflowDefinitionsDigest: "sha256:DIFFERENT-defs", configFingerprint: "sha256:cfg" },
    );
    expect(result.commit).toBe(true);
    expect(result.workflowDefinitions).toBe(false);
    expect(result.overall).toBe(false);
  });

  it("commit matches but config differs → matchesLive.config=false and overall=false", async () => {
    const mod = await import("./checkpoint-manifest.js");
    const result = (mod as any).computeLiveMatches(
      { commit: "abc123", artifactDigest: "sha256:a", workflowDefinitionsDigest: "sha256:defs", configFingerprint: "sha256:stored-cfg" },
      { commit: "abc123", artifactDigest: "sha256:a", workflowDefinitionsDigest: "sha256:defs", configFingerprint: "sha256:DIFFERENT-cfg" },
    );
    expect(result.commit).toBe(true);
    expect(result.config).toBe(false);
    expect(result.overall).toBe(false);
  });
});

// ── e) Production bootstrap integration: manifest component registered at real entry point ─

describe("INF-1329: production bootstrap registers checkpoint manifest (not test-only harness)", () => {
  it("src/index.ts wires the checkpoint manifest (string presence check)", async () => {
    const indexSrc = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "index.ts"),
      "utf8",
    );
    // Must import/register checkpoint-manifest at bootstrap — mirrors AI-1914 pattern
    expect(indexSrc).toMatch(/checkpoint-manifest/i);
    expect(indexSrc).toMatch(/health\.checkpoint/i);
  });

  it("createApp() exposes GET /health.checkpoint without a test-only harness", async () => {
    const { createApp } = await import("./index.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chk-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({ agents: [{ name: "ai", linearUserId: "user-ai", openclawAgent: "ai", accessToken: "tok", host: "local" }] }),
      "utf8",
    );
    const prevAgentsFile = process.env.AGENTS_FILE;
    process.env.AGENTS_FILE = agentsFile;

    const defYaml = `
id: dev-impl
version: 1
entry_state: intake
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions: [{ command: accept, to: done }]
  - id: done
    native_state: done
    transitions: []
`;
    const policyYaml = `
capabilities: [{ id: linear:transition }]
containers: [{ id: steward, grants: [linear:transition] }]
roles: [{ id: steward, requires: [linear:transition] }]
bodies: [{ id: astrid, container: steward, fills_roles: [steward] }]
`;
    fs.writeFileSync(path.join(dir, "dev-impl.yaml"), defYaml, "utf8");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), policyYaml, "utf8");
    const prevDef = process.env.WORKFLOW_DEF_PATH;
    const prevCap = process.env.CAPABILITY_POLICY_PATH;
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");

    const { reloadAgents } = await import("./agents.js");
    const { resetPolicyCache } = await import("./escalation-gate.js");
    const { resetWorkflowCache } = await import("./workflow-gate.js");
    resetPolicyCache();
    resetWorkflowCache();
    reloadAgents();

    const state = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    try {
      const res = await request(state.app).get("/health.checkpoint");
      // Must be registered at the real entry point — 404 proves it's not wired
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("matchesLive");
      expect(typeof res.body.matchesLive.overall).toBe("boolean");
    } finally {
      try {
        state.bag.close();
        state.sessionTracker.close();
        state.agentQueue.close();
        state.operationalEventStore.close();
        state.watchdog.stop();
        state.noActivityDetector.stop();
        state.managingPoller.stop();
      } catch {}
      if (prevAgentsFile === undefined) delete process.env.AGENTS_FILE;
      else process.env.AGENTS_FILE = prevAgentsFile;
      if (prevDef === undefined) delete process.env.WORKFLOW_DEF_PATH;
      else process.env.WORKFLOW_DEF_PATH = prevDef;
      if (prevCap === undefined) delete process.env.CAPABILITY_POLICY_PATH;
      else process.env.CAPABILITY_POLICY_PATH = prevCap;
      reloadAgents();
      resetPolicyCache();
      resetWorkflowCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
