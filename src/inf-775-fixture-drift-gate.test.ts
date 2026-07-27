/**
 * INF-775: Release/reload fixture drift gate.
 *
 * AC mapping:
 *   AC1: Release verification runs fixture drift after restart/reload and gates
 *        green on both fixtureDrift.healthy and fixtureDrift.gate.healthy.
 *   AC2: POST /admin/api/workflows/reload re-runs drift/gate and emits a
 *        non-green signal when drift is unhealthy.
 *   AC3: /health.fixtureDrift preserves the existing liveness fields and adds
 *        gate: mode, healthy, refused, served, bootFailure.
 *   AC4: Each fixtureDrift entry exposes gateVerdict, reason, version, and
 *        fixtureVersion per the approved spike contract.
 */

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "@jest/globals";
import { createAdminRouter } from "./admin.js";
import { getFixtureDriftLiveness, resetFixtureDriftStatus, runFixtureDriftCheck } from "./fixture-drift-detector.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const ADMIN_SECRET = "inf-775-admin-secret";

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: test
    grants: [linear:transition]
roles:
  - id: browser-automation
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: deployment
    requires: [linear:transition]
  - id: design-lead
    requires: [linear:transition]
  - id: designer
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: engine
    requires: [linear:transition]
  - id: host-deploy
    requires: [linear:transition]
  - id: requester
    requires: [linear:transition]
  - id: sprint-owner
    requires: [linear:transition]
  - id: steward
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: ui-designer
    requires: [linear:transition]
  - id: ux-researcher
    requires: [linear:transition]
  - id: visual-reviewer
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: igor
    container: test
    fills_roles:
      - browser-automation
      - code-review
      - department-head
      - deployment
      - design-lead
      - designer
      - dev
      - engine
      - host-deploy
      - requester
      - sprint-owner
      - steward
      - test-author
      - ui-designer
      - ux-researcher
      - visual-reviewer
      - worker
`;

function copyRegisteredDefsWithDrift(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-775-defs-"));
  const sourceDir = path.resolve(process.cwd(), "src", "registered-defs");
  const targetDir = path.join(dir, "defs");
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith(".yaml")) continue;
    const sourcePath = path.join(sourceDir, file);
    const targetPath = path.join(targetDir, file);
    let content = fs.readFileSync(sourcePath, "utf8");
    if (file === "dev-impl.yaml") {
      content = content.replace(/^version:\s*(\d+)/m, (_match, version: string) => `version: ${Number(version) + 1000}`);
    }
    fs.writeFileSync(targetPath, content, "utf8");
  }

  return dir;
}

function pointWorkflowDefsAtRegisteredDefs(): () => void {
  const prior = process.env.WORKFLOW_DEFS_DIR;
  process.env.WORKFLOW_DEFS_DIR = path.resolve(process.cwd(), "src", "registered-defs");
  resetWorkflowCache();
  return () => {
    if (prior === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = prior;
    resetWorkflowCache();
  };
}

describe("INF-775 AC1: release verification consumes fixture drift gate health", () => {
  it("checks /health fixtureDrift.healthy and fixtureDrift.gate.healthy before RESULT: OK", () => {
    const deployScript = fs.readFileSync(path.resolve(process.cwd(), "host-owned/bin/deploy-linear-connector.sh"), "utf8");
    const healthCheckStart = deployScript.indexOf("health check");
    const okResult = deployScript.indexOf("RESULT: OK");
    expect(healthCheckStart).toBeGreaterThanOrEqual(0);
    expect(okResult).toBeGreaterThan(healthCheckStart);

    const verificationBlock = deployScript.slice(healthCheckStart, okResult);
    expect(verificationBlock).toMatch(/fixtureDrift/);
    expect(verificationBlock).toMatch(/fixtureDrift[^]*healthy/);
    expect(verificationBlock).toMatch(/fixtureDrift[^]*gate[^]*healthy/);
    expect(verificationBlock).toMatch(/DRIFT|FIXTURE|NON_GREEN|GATE/i);
  });
});

describe("INF-775 AC2: workflow reload re-runs drift gate and emits non-green drift", () => {
  let tmpRoot: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
    resetPolicyCache();
    resetWorkflowCache();
    resetFixtureDriftStatus();
  });

  it("returns or records a non-green fixtureDrift signal when reloaded defs drift from fixtures", async () => {
    savedEnv.WORKFLOW_DEFS_DIR = process.env.WORKFLOW_DEFS_DIR;
    savedEnv.ADMIN_SECRET = process.env.ADMIN_SECRET;
    savedEnv.CAPABILITY_POLICY_PATH = process.env.CAPABILITY_POLICY_PATH;
    tmpRoot = copyRegisteredDefsWithDrift();
    fs.writeFileSync(path.join(tmpRoot, "capability-policy.yaml"), TEST_POLICY_YAML, "utf8");
    process.env.WORKFLOW_DEFS_DIR = path.join(tmpRoot, "defs");
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpRoot, "capability-policy.yaml");
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    resetPolicyCache();
    resetWorkflowCache();
    resetFixtureDriftStatus();

    const recordedEvents: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use("/admin", createAdminRouter({
      deploymentName: "inf-775-test",
      operationalEventStore: {
        append(event: unknown) {
          recordedEvents.push(event);
        },
      },
    } as any));

    const res = await request(app)
      .post("/admin/api/workflows/reload")
      .set("x-admin-secret", ADMIN_SECRET);

    const responseHasNonGreenFixtureDrift =
      res.status >= 400 ||
      res.body?.ok === false ||
      res.body?.fixtureDrift?.healthy === false ||
      res.body?.fixtureDrift?.gate?.healthy === false ||
      res.body?.releaseVerification?.green === false;
    const recordedNonGreenFixtureDrift = recordedEvents.some((event) =>
      /fixtureDrift|fixture drift/i.test(JSON.stringify(event)) &&
      /non-green|unhealthy|drift|refused/i.test(JSON.stringify(event)),
    );

    expect(responseHasNonGreenFixtureDrift || recordedNonGreenFixtureDrift).toBe(true);
    expect(JSON.stringify({ body: res.body, recordedEvents })).toMatch(/fixtureDrift|fixture drift/i);
  });
});

describe("INF-775 AC3: /health.fixtureDrift adds gate without dropping existing fields", () => {
  let restoreWorkflowDefsDir: (() => void) | null = null;

  afterEach(() => {
    restoreWorkflowDefsDir?.();
    restoreWorkflowDefsDir = null;
    resetWorkflowCache();
    resetFixtureDriftStatus();
  });

  it("preserves lastCheck, healthy, entries, drifted, total and adds gate liveness", async () => {
    restoreWorkflowDefsDir = pointWorkflowDefsAtRegisteredDefs();
    await runFixtureDriftCheck();
    const fixtureDrift = getFixtureDriftLiveness();

    expect(fixtureDrift).toEqual(expect.objectContaining({
      lastCheck: expect.any(String),
      healthy: expect.any(Boolean),
      entries: expect.any(Array),
      drifted: expect.any(Number),
      total: expect.any(Number),
    }));

    expect(fixtureDrift).toHaveProperty("gate");
    const gate = (fixtureDrift as any).gate;
    expect(gate).toEqual(expect.objectContaining({
      mode: expect.any(String),
      healthy: expect.any(Boolean),
      refused: expect.any(Number),
      served: expect.any(Number),
    }));
    expect(gate).toHaveProperty("bootFailure");
  });
});

describe("INF-775 AC4: fixtureDrift entries expose the spike gate contract", () => {
  let restoreWorkflowDefsDir: (() => void) | null = null;

  afterEach(() => {
    restoreWorkflowDefsDir?.();
    restoreWorkflowDefsDir = null;
    resetWorkflowCache();
    resetFixtureDriftStatus();
  });

  it("includes gateVerdict, reason, version, and fixtureVersion on every entry", async () => {
    restoreWorkflowDefsDir = pointWorkflowDefsAtRegisteredDefs();
    const status = await runFixtureDriftCheck();
    expect(status.entries.length).toBeGreaterThan(0);

    for (const entry of status.entries) {
      expect(entry).toEqual(expect.objectContaining({
        workflowId: expect.any(String),
        gateVerdict: expect.any(String),
      }));
      expect(entry).toHaveProperty("reason");
      expect(entry).toHaveProperty("version");
      expect(entry).toHaveProperty("fixtureVersion");
    }
  });
});
