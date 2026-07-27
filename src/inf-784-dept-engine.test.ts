/**
 * INF-784 — wf:dept-engine archetype, department engine.
 *
 * Red-test mapping:
 *   AC1/AC7: registered def + canonical fixture parity, continuous loop shape,
 *     first-N human theme-confirm gate, and no embedded charter content.
 *   AC2: department-head role resolution is scoped by department/team.
 *   AC3: managing barrier waits only on owned-infra children.
 *   AC4/AC6: three output classes, provenance, no cross-team prioritization,
 *     and foundation-first product-output gate.
 *   AC5: per-department terminal predicates, including non-PR head approval.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { evaluateBarrier } from "./barrier.js";
import { resolveBodiesForRole, resetPolicyCache } from "./escalation-gate.js";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const REGISTERED_DEF_PATH = path.join(REPO_ROOT, "src/registered-defs/dept-engine.yaml");
const CANONICAL_FIXTURE_PATH = path.join(REPO_ROOT, "src/__fixtures__/canonical-dept-engine.yaml");
const RUNTIME_MODULE = path.join(REPO_ROOT, "src/dept-engine.ts");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/index.js");

type LooseRecord = Record<string, any>;

function readYaml(file: string): LooseRecord {
  return loadYaml(fs.readFileSync(file, "utf8")) as LooseRecord;
}

function state(def: LooseRecord, id: string): LooseRecord {
  const found = (def.states ?? []).find((candidate: LooseRecord) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function transition(from: LooseRecord, command: string, to: string): LooseRecord {
  const found = (from.transitions ?? []).find(
    (candidate: LooseRecord) => candidate.command === command && candidate.to === to,
  );
  expect(found).toBeDefined();
  return found;
}

function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function pathToFileUrl(file: string): string {
  return `file://${file.replace(/\\/g, "/").replace(/\.ts$/, ".js")}`;
}

async function pollHealth(url: string, timeoutMs: number): Promise<LooseRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = (await res.json()) as LooseRecord;
      if (body && typeof body === "object") return body;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.on("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

async function loadDeptEngineRuntime(): Promise<LooseRecord> {
  expect(fs.existsSync(RUNTIME_MODULE)).toBe(true);
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport(pathToFileUrl(RUNTIME_MODULE)) as Promise<LooseRecord>;
}

describe("INF-784 AC1/AC7: wf:dept-engine def registration and fixture canary", () => {
  afterEach(() => {
    resetWorkflowCache();
  });

  it("registers wf:dept-engine and keeps registered def in exact parity with canonical fixture", async () => {
    expect(fs.existsSync(REGISTERED_DEF_PATH)).toBe(true);
    expect(fs.existsSync(CANONICAL_FIXTURE_PATH)).toBe(true);

    const registered = readYaml(REGISTERED_DEF_PATH);
    const fixture = readYaml(CANONICAL_FIXTURE_PATH);
    expect(stable(registered)).toEqual(stable(fixture));

    const registry = await loadWorkflowRegistry();
    expect(registry.has("dept-engine")).toBe(true);
    expect(stable(registry.get("dept-engine"))).toEqual(stable(registered));
  });

  it("authors the required continuous loop with first-N theme-confirm gate and no embedded charter", () => {
    const def = readYaml(REGISTERED_DEF_PATH);

    expect(def).toMatchObject({
      id: "dept-engine",
      archetype: "continuous-loop",
      entry_state: "evaluating",
    });
    expect(def.charter).toBeUndefined();
    expect(def.description ?? "").not.toMatch(/department charter|charter content/i);
    expect(def.instantiation).toEqual(expect.objectContaining({
      charter_ref: expect.any(String),
      department: expect.any(String),
      foundation_milestone: expect.any(String),
    }));

    const expectedStates = [
      "evaluating",
      "theme-proposal",
      "theme-confirm",
      "solicit",
      "synthesize-scope",
      "managing",
      "validation",
      "done",
    ];
    expect((def.states ?? []).map((s: LooseRecord) => s.id)).toEqual(expectedStates);

    expect(transition(state(def, "evaluating"), "propose-theme", "theme-proposal").generic).toBe("continue");
    expect(transition(state(def, "theme-proposal"), "confirm-theme", "theme-confirm")).toEqual(expect.objectContaining({
      generic: "continue",
      human_confirm: expect.objectContaining({ first_cycles: expect.any(Number) }),
    }));
    expect(transition(state(def, "theme-confirm"), "solicit", "solicit").generic).toBe("continue");
    expect(state(def, "solicit").fanout).toEqual(expect.objectContaining({
      spec_source: "solicitations",
      barrier: "all-responded",
    }));
    expect(transition(state(def, "solicit"), "synthesize", "synthesize-scope").generic).toBe("continue");
    expect(transition(state(def, "synthesize-scope"), "spawn", "managing").generic).toBe("continue");
    expect(state(def, "managing").barrier).toBe(true);
    expect(transition(state(def, "managing"), "validate", "validation")).toBeDefined();
    expect(transition(state(def, "validation"), "complete-cycle", "done").generic).toBe("continue");
    expect(transition(state(def, "done"), "loop", "evaluating").generic).toBe("continue");
  });

  it("boots the production entry point and exposes wf:dept-engine in /health.workflowRegistry without launching a cycle", async () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);

    const port = 49_000 + (process.pid % 500);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-784-bootstrap-"));
    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "charles",
            linearUserId: "user-charles-inf784",
            openclawAgent: "charles",
            clientId: "client-id",
            clientSecret: "client-secret",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            host: "local",
          },
        ],
      }),
      "utf8",
    );

    let child: ChildProcess | undefined;
    let childStderr = "";
    try {
      child = spawn(process.execPath, [DIST_ENTRY], {
        cwd: tmpDir,
        env: {
          ...process.env,
          AGENTS_FILE: agentsFile,
          DATA_DIR: path.join(tmpDir, "data"),
          PORT: String(port),
          LOG_LEVEL: "error",
          LINEAR_CONNECTOR_SECRET: "test-secret-inf784",
          LINEAR_WEBHOOK_SECRET: "test-webhook-inf784",
          LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
          OPENCLAW_HOOKS_URL: `http://127.0.0.1:${port}/unused-hooks`,
          OPENCLAW_HOOKS_TOKEN: "test-hooks-token",
          CRON_STARTUP_GRACE_MS: "60000",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        childStderr += chunk.toString("utf8");
      });

      let body: LooseRecord;
      try {
        body = await pollHealth(`http://127.0.0.1:${port}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `production entry point never exposed /health: ${err instanceof Error ? err.message : String(err)}\n` +
          `child stderr:\n${childStderr}`,
        );
      }

      expect(body.workflowRegistry).toBeDefined();
      expect(body.workflowRegistry["dept-engine"]).toEqual(expect.objectContaining({
        id: "dept-engine",
        states: expect.arrayContaining(["evaluating", "theme-proposal", "solicit", "managing", "validation", "done"]),
      }));
      expect(child.exitCode).toBeNull();
    } finally {
      await stopChild(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("INF-784 AC2: department-head resolution is scoped", () => {
  let tmpDir: string;
  const oldPolicyPath = process.env.CAPABILITY_POLICY_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-784-policy-"));
    fs.writeFileSync(
      path.join(tmpDir, "policy.yaml"),
      `
capabilities:
  - id: linear:transition
containers:
  - id: lead
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition]
roles:
  - id: department-head
    requires: [linear:transition]
  - id: steward
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: lead
    fills_roles: [department-head]
    departments: [ENG]
    teams: [Engineering]
  - id: laren
    container: lead
    fills_roles: [department-head]
    departments: [DSN]
    teams: [Design]
`,
      "utf8",
    );
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    resetPolicyCache();
  });

  afterEach(() => {
    if (oldPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = oldPolicyPath;
    resetPolicyCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves ENG to charles and DSN to laren instead of global steward or all heads", async () => {
    const scopedResolver = resolveBodiesForRole as unknown as (
      roleId: string,
      scope: { department?: string; team?: string },
    ) => Promise<string[]>;

    await expect(scopedResolver("department-head", { department: "ENG", team: "Engineering" })).resolves.toEqual(["charles"]);
    await expect(scopedResolver("department-head", { department: "DSN", team: "Design" })).resolves.toEqual(["laren"]);
    await expect(scopedResolver("steward", { department: "ENG", team: "Engineering" })).resolves.toEqual(["astrid"]);
    await expect(scopedResolver("department-head", { department: "ENG", team: "Design" })).resolves.toEqual([]);
    await expect(scopedResolver("department-head", { department: "DSN", team: "Engineering" })).resolves.toEqual([]);
    await expect(scopedResolver("department-head", { department: "OPS", team: "Operations" })).resolves.toEqual([]);
    await expect(scopedResolver("department-head", {})).rejects.toThrow(/department|team|scope/i);
  });
});

describe("INF-784 AC3: managing barrier scope is owned-infra only", () => {
  const oldFetch = global.fetch;

  afterEach(() => {
    global.fetch = oldFetch;
  });

  it("excludes product handoff/proposal children from managing barrier evaluation", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            children: {
              nodes: [
                {
                  identifier: "ENG-101",
                  labels: {
                    nodes: [
                      { name: "wf:dev-impl" },
                      { name: "state:done" },
                      { name: "dept-output:owned-infra" },
                    ],
                  },
                },
                {
                  identifier: "PROD-44",
                  labels: {
                    nodes: [
                      { name: "wf:task" },
                      { name: "state:implementation" },
                      { name: "dept-output:product-backlog-proposal" },
                    ],
                  },
                },
                {
                  identifier: "PROD-45",
                  labels: {
                    nodes: [
                      { name: "wf:task" },
                      { name: "state:implementation" },
                      { name: "dept-output:standards-proposal" },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    } as Response)) as typeof fetch;

    const result = await evaluateBarrier("ENG-DEPT-1", "token", {
      workflow: "dept-engine",
      barrierScope: "owned-infra",
    } as any);

    expect(result.allTerminal).toBe(true);
    expect(result.children.map((child) => child.identifier)).toEqual(["ENG-101"]);
    expect(result.totalChildren).toBe(1);
  });
});

describe("INF-784 AC4/AC6: output routing, provenance, and foundation-first gate", () => {
  it("declares owned-infra, product-backlog, and standards-proposal output classes with barrier membership", () => {
    const def = readYaml(REGISTERED_DEF_PATH);
    const outputs = def.output_classes ?? def.x_dept_output_classes;

    expect(outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owned-infra", barrier: true }),
      expect.objectContaining({ id: "product-backlog-proposal", barrier: false }),
      expect.objectContaining({ id: "standards-proposal", barrier: false, continuous_rule: true }),
    ]));
  });

  it("routes proposed product outputs with provenance while refusing cross-team priority/sprint/state writes", async () => {
    const runtime = await loadDeptEngineRuntime();
    expect(typeof runtime.planDeptEngineOutputs).toBe("function");

    const result = runtime.planDeptEngineOutputs({
      department: "ENG",
      cycle: 3,
      foundation: { milestone: "runtime-dispatch-hardened", met: true },
      proposals: [
        { class: "owned-infra", title: "Own the dispatch circuit breaker", team: "ENG", priority: "High", state: "todo" },
        { class: "product-backlog-proposal", title: "Expose retry status in product UI", team: "GEN", priority: "High", state: "todo" },
        { class: "standards-proposal", title: "Adopt retry evidence in PM bar", team: "GEN", sprint: "Current" },
      ],
    });

    expect(result.children).toEqual([
      expect.objectContaining({
        class: "owned-infra",
        barrier: true,
        team: "ENG",
        priority: "High",
        state: "todo",
        labels: expect.arrayContaining(["dept-proposed: ENG, cycle 3"]),
      }),
      expect.objectContaining({
        class: "product-backlog-proposal",
        barrier: false,
        team: "GEN",
        labels: expect.arrayContaining(["dept-proposed: ENG, cycle 3"]),
      }),
      expect.objectContaining({
        class: "standards-proposal",
        barrier: false,
        team: "GEN",
        labels: expect.arrayContaining(["dept-proposed: ENG, cycle 3"]),
      }),
    ]);
    for (const child of result.children.filter((c: LooseRecord) => c.team !== "ENG")) {
      expect(child.priority).toBeUndefined();
      expect(child.sprint).toBeUndefined();
      expect(child.state).toBeUndefined();
    }
  });

  it("keeps product backlog and standards proposals locked until the named foundation milestone is met", async () => {
    const runtime = await loadDeptEngineRuntime();
    expect(typeof runtime.planDeptEngineOutputs).toBe("function");

    expect(() =>
      runtime.planDeptEngineOutputs({
        department: "ENG",
        cycle: 1,
        foundation: { milestone: "runtime-dispatch-hardened", met: false },
        proposals: [
          { class: "owned-infra", title: "Internal dispatch hardening", team: "ENG" },
          { class: "product-backlog-proposal", title: "Product request before foundation", team: "GEN" },
          { class: "standards-proposal", title: "Rule before foundation", team: "GEN" },
        ],
      }),
    ).toThrow(/foundation.*runtime-dispatch-hardened.*product-backlog-proposal.*standards-proposal/i);
  });
});

describe("INF-784 AC5: per-department terminal predicates", () => {
  it("requires ENG owned-infra PR work to be tests-green plus merged", async () => {
    const runtime = await loadDeptEngineRuntime();
    expect(typeof runtime.isDeptOwnedInfraTerminal).toBe("function");

    expect(runtime.isDeptOwnedInfraTerminal({
      department: "ENG",
      artifactType: "pull-request",
      checks: { tests: "green" },
      pullRequest: { merged: true },
    })).toBe(true);
    expect(runtime.isDeptOwnedInfraTerminal({
      department: "ENG",
      artifactType: "pull-request",
      checks: { tests: "green" },
      pullRequest: { merged: false },
    })).toBe(false);
    expect(runtime.isDeptOwnedInfraTerminal({
      department: "ENG",
      artifactType: "pull-request",
      checks: { tests: "red" },
      pullRequest: { merged: true },
    })).toBe(false);
  });

  it("supports a non-PR owned-infra artifact whose terminal signal is department-head approval", async () => {
    const runtime = await loadDeptEngineRuntime();
    expect(typeof runtime.isDeptOwnedInfraTerminal).toBe("function");

    expect(runtime.isDeptOwnedInfraTerminal({
      department: "DSN",
      artifactType: "standards-document",
      headReview: { reviewer: "laren", approved: true, authoredByDepartmentHead: true },
    })).toBe(true);
    expect(runtime.isDeptOwnedInfraTerminal({
      department: "DSN",
      artifactType: "standards-document",
      headReview: { reviewer: "astrid", approved: true, authoredByDepartmentHead: false },
    })).toBe(false);
  });
});
