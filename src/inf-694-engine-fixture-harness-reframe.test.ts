/**
 * INF-694 — Engine-tier fixture harness reframe.
 *
 * These are red tests only. They pin the S1 harness contract without changing
 * production behavior: engine fixtures must be synthetic, the frozen primitive
 * list moves 11 -> 12 with commitment-gate, child-dispatch-ack stays composed,
 * and config-regression assertions are isolated from engine liveness.
 */

import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "@jest/globals";
import { validateWorkflowDef } from "./workflow-conformance.js";
import type { WorkflowDef } from "./workflow-gate.js";

const FIXTURE_DIR = path.resolve(process.cwd(), "src/__fixtures__");
const PARENT_FIXTURE = path.join(FIXTURE_DIR, "engine-primitive-parent.yaml");
const COMMITMENT_GATE_FIXTURE = path.join(FIXTURE_DIR, "engine-primitive-commitment-gate.yaml");
const CHILD_DISPATCH_ACK_FIXTURE = path.join(FIXTURE_DIR, "engine-primitive-child-dispatch-ack.yaml");
const HARNESS_MODULE = path.resolve(process.cwd(), "src/test-support/engine-fixture-harness.ts");

const FROZEN_ENGINE_PRIMITIVES_12 = [
  "workflow-registration",
  "governed-transitions",
  "guards",
  "fan-out",
  "barrier-join",
  "terminal-reachability",
  "dispatch-wake",
  "idempotency-mutex",
  "parenting-reparenting",
  "role-delegate-resolution",
  "escape-break-glass",
  "commitment-gate",
] as const;

const FORBIDDEN_ENGINE_FIXTURE_TERMS = [
  /\bsprint\b/i,
  /\bdev-impl\b/i,
  /\bigor\b/i,
  /\btdd\b/i,
  /\bastrid\b/i,
  /\bsprint-spawner\b/i,
  /\bdev-sprint\b/i,
  /\bsprint-arm\b/i,
];

const FORBIDDEN_SYNTHETIC_SPEC_TITLE_PREFIX = /^(scope arm|spike arm|ux arm|design arm)\b/i;

interface ParsedWorkflow {
  id?: string;
  archetype?: string;
  description?: string;
  x_engine_primitives?: unknown;
  states?: Array<{
    id?: string;
    owner_role?: string;
    description?: string;
    fanout?: {
      spec_source?: string;
      child_workflow?: string;
      initial_delegate?: string;
      block_siblings?: boolean;
      [key: string]: unknown;
    };
    transitions?: Array<{ command?: string; to?: string; [key: string]: unknown }>;
  }>;
  [key: string]: unknown;
}

interface HarnessModule {
  runEngineFixtureHarness?: (options?: {
    skipTiers?: string[];
    forceFailures?: Partial<Record<"engine" | "config-regression", string>>;
  }) => Promise<{
    tiers: {
      engine: { tested: boolean; status: "passed" | "failed" | "skipped"; report: string };
      "config-regression": { tested: boolean; status: "passed" | "failed" | "skipped"; report: string };
    };
  }>;
}

function readRaw(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function readWorkflow(file: string): ParsedWorkflow {
  return yamlLoad(readRaw(file)) as ParsedWorkflow;
}

function assertNoForbiddenTerms(file: string): void {
  const raw = readRaw(file);
  for (const forbidden of FORBIDDEN_ENGINE_FIXTURE_TERMS) {
    expect(raw).not.toMatch(forbidden);
  }
}

function engineSuiteFiles(): string[] {
  return [
    path.resolve(process.cwd(), "src/inf-520-engine-primitive-fixtures.test.ts"),
    PARENT_FIXTURE,
    path.join(FIXTURE_DIR, "engine-primitive-child.yaml"),
    COMMITMENT_GATE_FIXTURE,
    CHILD_DISPATCH_ACK_FIXTURE,
  ].filter((file) => fs.existsSync(file));
}

async function loadHarness(): Promise<HarnessModule> {
  expect(fs.existsSync(HARNESS_MODULE)).toBe(true);
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport(pathToFileUrl(HARNESS_MODULE.replace(/\.ts$/, ".js"))) as Promise<HarnessModule>;
}

function pathToFileUrl(file: string): string {
  return `file://${file.replace(/\\/g, "/")}`;
}

describe("INF-694 AC1.1: frozen engine primitive matrix is 12-wide", () => {
  it("adds commitment-gate as the 12th primitive on the synthetic parent matrix", () => {
    const parent = readWorkflow(PARENT_FIXTURE);

    expect(parent.x_engine_primitives).toEqual([...FROZEN_ENGINE_PRIMITIVES_12]);
    expect(parent.x_engine_primitives).not.toContain("child-dispatch-ack");
  });

  it("has a synthetic role-a/agent-1 commitment-gate fixture and passes the forbidden-term guard", () => {
    expect(fs.existsSync(COMMITMENT_GATE_FIXTURE)).toBe(true);
    assertNoForbiddenTerms(COMMITMENT_GATE_FIXTURE);

    const fixture = readWorkflow(COMMITMENT_GATE_FIXTURE);
    const states = fixture.states ?? [];
    const ownerRoles = states.map((state) => state.owner_role).filter(Boolean);
    const serialized = JSON.stringify(fixture);

    expect(fixture.id).toBe("synthetic-commitment-gate");
    expect(fixture.x_engine_primitives).toContain("commitment-gate");
    expect(ownerRoles).toContain("role-a");
    expect(serialized).toContain("agent-1");
  });

  it("authors child-dispatch-ack as a composed fixture over fan-out plus per-child dispatch/wake, not a primitive", () => {
    expect(fs.existsSync(CHILD_DISPATCH_ACK_FIXTURE)).toBe(true);
    assertNoForbiddenTerms(CHILD_DISPATCH_ACK_FIXTURE);

    const fixture = readWorkflow(CHILD_DISPATCH_ACK_FIXTURE);
    const states = fixture.states ?? [];
    const fanoutStates = states.filter((state) => state.fanout);
    const serialized = JSON.stringify(fixture);

    expect(fixture.x_engine_primitives).not.toContain("child-dispatch-ack");
    expect(fixture.x_engine_primitives).toEqual(expect.arrayContaining(["fan-out", "dispatch-wake"]));
    expect(fanoutStates).toHaveLength(1);
    expect(serialized).toMatch(/per-child|child.*dispatch|dispatch.*child/i);
  });
});

describe("INF-694 AC1.2: engine and config-regression tiers report liveness independently", () => {
  it("reports engine tested when config-regression is skipped", async () => {
    const harness = await loadHarness();
    expect(typeof harness.runEngineFixtureHarness).toBe("function");

    const result = await harness.runEngineFixtureHarness!({ skipTiers: ["config-regression"] });

    expect(result.tiers.engine).toEqual(expect.objectContaining({
      tested: true,
      status: "passed",
      report: expect.stringMatching(/engine tested/i),
    }));
    expect(result.tiers["config-regression"]).toEqual(expect.objectContaining({
      tested: false,
      status: "skipped",
    }));
  });

  it("does not let a config-regression failure mark engine untested, or an engine failure mark config untested", async () => {
    const harness = await loadHarness();

    const configFails = await harness.runEngineFixtureHarness!({
      forceFailures: { "config-regression": "INF-475 synthetic config regression" },
    });
    expect(configFails.tiers.engine.tested).toBe(true);
    expect(configFails.tiers.engine.report).toMatch(/engine tested/i);
    expect(configFails.tiers["config-regression"].status).toBe("failed");

    const engineFails = await harness.runEngineFixtureHarness!({
      forceFailures: { engine: "synthetic engine failure" },
    });
    expect(engineFails.tiers.engine.status).toBe("failed");
    expect(engineFails.tiers["config-regression"].tested).toBe(true);
    expect(engineFails.tiers["config-regression"].report).toMatch(/config-regression tested/i);
  });
});

describe("INF-694 AC1.3: engine tier is mechanically third-party and synthetic", () => {
  it("contains zero references to production sprint, workflow, or agent names", () => {
    const offenders: string[] = [];

    for (const file of engineSuiteFiles()) {
      const raw = readRaw(file);
      for (const forbidden of FORBIDDEN_ENGINE_FIXTURE_TERMS) {
        if (forbidden.test(raw)) offenders.push(`${path.relative(process.cwd(), file)} :: ${forbidden}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("extends the forbidden-term guard to the two new fixtures", () => {
    expect(engineSuiteFiles()).toEqual(expect.arrayContaining([COMMITMENT_GATE_FIXTURE, CHILD_DISPATCH_ACK_FIXTURE]));
    assertNoForbiddenTerms(COMMITMENT_GATE_FIXTURE);
    assertNoForbiddenTerms(CHILD_DISPATCH_ACK_FIXTURE);
  });
});

describe("INF-694 AC1.4: S1 fixture fan-out contract is minimal and cannot infer production arms", () => {
  it("uses only FanoutConfig { spec_source, child_workflow } and keeps child_workflow to /^wf:.+/", () => {
    expect(fs.existsSync(CHILD_DISPATCH_ACK_FIXTURE)).toBe(true);
    const fixture = readWorkflow(CHILD_DISPATCH_ACK_FIXTURE);
    const fanoutState = (fixture.states ?? []).find((state) => state.fanout);

    expect(fanoutState).toBeDefined();
    expect(Object.keys(fanoutState!.fanout!).sort()).toEqual(["child_workflow", "spec_source"]);
    expect(fanoutState!.fanout!.child_workflow).toMatch(/^wf:.+/);
  });

  it("names a parent description section by spec_source and resolves team labels to the wf:<child> label", () => {
    expect(fs.existsSync(CHILD_DISPATCH_ACK_FIXTURE)).toBe(true);
    const fixture = readWorkflow(CHILD_DISPATCH_ACK_FIXTURE);
    const fanoutState = (fixture.states ?? []).find((state) => state.fanout);
    const specSource = fanoutState?.fanout?.spec_source;
    const childWorkflow = fanoutState?.fanout?.child_workflow;
    const description = String(fixture.description ?? fanoutState?.description ?? "");
    const teamLabels = (fixture.x_synthetic_team_labels ?? []) as string[];

    expect(specSource).toBeTruthy();
    expect(description).toMatch(new RegExp(`^##\\s+${String(specSource).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im"));
    expect(teamLabels).toContain(childWorkflow);
  });

  it("fails if any synthetic spec entry title can trigger dev-sprint arm inference into production child workflows", () => {
    expect(fs.existsSync(CHILD_DISPATCH_ACK_FIXTURE)).toBe(true);
    const fixture = readWorkflow(CHILD_DISPATCH_ACK_FIXTURE);
    const serialized = JSON.stringify(fixture);
    const entries = (fixture.x_synthetic_spec_entries ?? []) as Array<{ title?: string }>;

    expect(serialized).not.toMatch(/wf:sprint-arm-/i);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.title ?? "").not.toMatch(FORBIDDEN_SYNTHETIC_SPEC_TITLE_PREFIX);
    }
  });

  it("hard-refuses a synthetic fixture whose child_workflow lacks the wf: prefix", () => {
    expect(fs.existsSync(CHILD_DISPATCH_ACK_FIXTURE)).toBe(true);
    const fixture = readWorkflow(CHILD_DISPATCH_ACK_FIXTURE);
    const fanoutState = (fixture.states ?? []).find((state) => state.fanout);
    const broken = JSON.parse(JSON.stringify(fixture)) as ParsedWorkflow;
    const brokenFanout = (broken.states ?? []).find((state) => state.id === fanoutState?.id)?.fanout;
    if (brokenFanout) brokenFanout.child_workflow = "synthetic-child";

    const result = validateWorkflowDef(broken as WorkflowDef);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invariant: "child-workflow-resolution",
        message: expect.stringMatching(/child_workflow.*wf:/i),
      }),
    ]));
  });
});
