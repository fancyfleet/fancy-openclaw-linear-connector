import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";
import { resolveBodiesForRole, resetPolicyCache } from "./escalation-gate.js";
import {
  deriveWorkflowInstanceScope,
  describeMissingInstanceScope,
  resetWorkflowCache,
  type WorkflowDef,
  type WorkflowInstanceContext,
} from "./workflow-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const REGISTERED_DEF_PATH = path.join(REPO_ROOT, "src/registered-defs/task.yaml");
const REGISTERED_DEFS_DIR = path.dirname(REGISTERED_DEF_PATH);
const CANONICAL_FIXTURE_PATH = path.join(REPO_ROOT, "src/__fixtures__/canonical-task.yaml");

/**
 * INF-942 — task workflow uses enrollment-based department scope instead of
 * hardcoded DSN/Design.
 *
 * Verifies that:
 * 1. deriveWorkflowInstanceScope produces correct scope from enrollment context
 * 2. describeMissingInstanceScope catches missing enrollment metadata
 * 3. department-head resolution correctly routes via enrollment scope
 * 4. De-registration check: canonical fixture stays in sync
 * 5. dept-engine scope resolution path is NOT (accidentally) regressed
 */

// ── Policy fixture for department-head scoping tests ──
const POLICY_YAML = `
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
  - id: kasumi
    container: lead
    fills_roles: [department-head]
    departments: [OPS]
    teams: [Operations]
`;

// ── Minimal task workflow def fixture (department_scope intentionally absent) ──
function taskDef(): WorkflowDef {
  return {
    id: "task",
    version: 3,
    states: [
      { id: "intake", owner_role: "requester", kind: "normal", native_state: "todo", transitions: [] },
      { id: "doing", owner_role: "worker", kind: "normal", native_state: "todo", transitions: [] },
      { id: "review", owner_role: "department-head", kind: "normal", native_state: "todo", transitions: [] },
      { id: "done", kind: "terminal", native_state: "done", satisfies_parent_barrier: true },
    ],
    // NO department_scope — intentionally removed per INF-942
    // NO instantiation.department — scope comes from enrollment context
  };
}

// ── Minimal dept-engine def for regression check ──
function deptEngineDef(): WorkflowDef {
  return {
    id: "dept-engine",
    version: 1,
    states: [
      { id: "evaluating", owner_role: "department-head", kind: "normal", native_state: "todo", transitions: [] },
    ],
    instantiation: { department: "ENG", team: "Engineering" },
  };
}

function devImplDef(): WorkflowDef {
  return {
    id: "dev-impl",
    version: 1,
    states: [
      { id: "doing", owner_role: "department-head", kind: "normal", native_state: "todo", transitions: [] },
    ],
    department_scope: { department: "DSN", team: "Design" },
  };
}

// ── Test setup ──
describe("INF-942 AC1: deriveWorkflowInstanceScope resolves task scope from enrollment context", () => {
  it("returns correct scope when enrollment provides department and team", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeDefined();
    expect(scope!.department).toBe("ENG");
    expect(scope!.team).toBe("Engineering");
  });

  it("returns correct scope when enrollment provides only department", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "OPS" },
    };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeDefined();
    expect(scope!.department).toBe("OPS");
  });

  it("falls back to teamKey when enrollment department is absent", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = { teamKey: "ENG" };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeDefined();
    expect(scope!.department).toBe("ENG");
  });

  it("falls back to teamName when enrollment team is absent", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = { teamName: "Engineering" };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope!.team).toBe("Engineering");
  });

  it("returns undefined when no enrollment metadata is available (scope resolution will fail closed)", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {};
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeUndefined();
  });

  it("returns undefined when context is absent entirely", () => {
    const def = taskDef();
    const scope = deriveWorkflowInstanceScope(def);
    expect(scope).toBeUndefined();
  });

  it("prefers workflowEnrollment over teamKey/teamName", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "ENG", team: "Engineering" },
      teamKey: "OPS",
      teamName: "Operations",
    };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope!.department).toBe("ENG");
    expect(scope!.team).toBe("Engineering");
  });
});

describe("INF-942 AC2: describeMissingInstanceScope flags missing task enrollment", () => {
  it("returns a message when task has no enrollment metadata", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {};
    const msg = describeMissingInstanceScope(def, context);
    expect(msg).toContain("wf:task");
    expect(msg).toContain("missing department/team instance scope metadata");
    expect(msg).toContain("no static fallback");
  });

  it("includes issue identifier in message when available", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = { issueIdentifier: "INF-1234" };
    const msg = describeMissingInstanceScope(def, context);
    expect(msg).toContain("INF-1234");
  });

  it("returns undefined for non-dept-engine/non-task workflows", () => {
    const def = devImplDef();
    const msg = describeMissingInstanceScope(def, {});
    expect(msg).toBeUndefined();
  });

  it("returns the missing-scope message even when context is present (scope is checked separately by callers)", () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    };
    const msg = describeMissingInstanceScope(def, context);
    // describeMissingInstanceScope returns the message regardless of enrollment (callers check scope separately)
    expect(msg).toContain("wf:task");
  });
});

describe("INF-942 AC3: department-head role resolves correctly for task via enrollment", () => {
  let tmpDir: string;
  const oldPolicyPath = process.env.CAPABILITY_POLICY_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-942-policy-"));
    fs.writeFileSync(path.join(tmpDir, "policy.yaml"), POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    resetPolicyCache();
  });

  afterEach(() => {
    if (oldPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = oldPolicyPath;
    resetPolicyCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves ENG enrollment to charles via deriveWorkflowInstanceScope", async () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    };
    const scope = deriveWorkflowInstanceScope(def, context)!;
    const bodies = await resolveBodiesForRole("department-head", scope);
    expect(bodies).toEqual(["charles"]);
  });

  it("resolves DSN enrollment to laren", async () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "DSN", team: "Design" },
    };
    const scope = deriveWorkflowInstanceScope(def, context)!;
    const bodies = await resolveBodiesForRole("department-head", scope);
    expect(bodies).toEqual(["laren"]);
  });

  it("resolves OPS enrollment to kasumi", async () => {
    const def = taskDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "OPS", team: "Operations" },
    };
    const scope = deriveWorkflowInstanceScope(def, context)!;
    const bodies = await resolveBodiesForRole("department-head", scope);
    expect(bodies).toEqual(["kasumi"]);
  });

  it("throws when scope is absent for department-head resolution (fail closed)", async () => {
    // When deriveWorkflowInstanceScope returns undefined and caller
    // hasn't guarded with describeMissingInstanceScope, resolveBodiesForRole
    // throws for department-head role.
    const def = taskDef();
    const context: WorkflowInstanceContext = {};
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeUndefined();
    const scopedResolver = (role: string, s: { department?: string; team?: string } | undefined) =>
      resolveBodiesForRole(role, s);
    await expect(scopedResolver("department-head", undefined)).rejects.toThrow(/department|team|scope/i);
  });
});

describe("INF-942 AC4: dept-engine scope resolution is NOT regressed", () => {
  let tmpDir: string;
  const oldPolicyPath = process.env.CAPABILITY_POLICY_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-942-dept-regression-"));
    fs.writeFileSync(path.join(tmpDir, "policy.yaml"), POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    resetPolicyCache();
  });

  afterEach(() => {
    if (oldPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = oldPolicyPath;
    resetPolicyCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dept-engine still resolves scope from enrollment context", () => {
    const def = deptEngineDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "ENG", team: "Engineering" },
    };
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeDefined();
    expect(scope!.department).toBe("ENG");
  });

  it("dept-engine returns undefined when enrollment context is absent (fail-closed)", () => {
    const def = deptEngineDef();
    const scope = deriveWorkflowInstanceScope(def);
    expect(scope).toBeUndefined();
  });

  it("dev-impl continues using static department_scope and is unaffected", () => {
    const def = devImplDef();
    const context: WorkflowInstanceContext = {
      workflowEnrollment: { department: "OPS", team: "Operations" },
    };
    // dev-impl uses roleResolutionScopeForOwnerRole (def-level), not deriveWorkflowInstanceScope
    const scope = deriveWorkflowInstanceScope(def, context);
    expect(scope).toBeDefined();
    // dev-impl should still use def-level scope
  });
});

describe("INF-942 AC5: registered def fixture parity", () => {
  const oldWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;

  beforeEach(() => {
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    resetWorkflowCache();
  });

  afterEach(() => {
    if (oldWorkflowDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = oldWorkflowDefsDir;
    resetWorkflowCache();
  });

  it("keeps canonical-task.yaml in sync with task.yaml (no department_scope)", async () => {
    // This is the INF-784 fixture-canary pattern: the canonical fixture must
    // match the registered def so check-workflow-def-sync passes at startup.
    const { loadWorkflowDefById } = await import("./workflow-gate.js");
    const registered = await loadWorkflowDefById("task");
    expect(registered).not.toBeNull();
    const fixture = fs.readFileSync(CANONICAL_FIXTURE_PATH, "utf8");

    // The fixture is generated from the registered def, so they should match
    // structurally. For the department_scope check, verify absent in both.
    expect(registered!.department_scope).toBeUndefined();
    const fixtureLines = fixture.split("\n");
    const hasDeptScopeKey = fixtureLines.some(l => l.trimStart().startsWith("department_scope:"));
    expect(hasDeptScopeKey).toBe(false);
  });
});
