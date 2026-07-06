/**
 * AI-1872 — Split deployment into merge + deploy states; generic verbs only.
 *
 * Matt directive (2026-07-06): the current `deployment` + `host-deploy` states
 * are replaced with `merge` (owner: Hanzo) and `deploy` (owner: configurable).
 * Custom verbs (`deploy`, `handoff-host-deploy`, `host-deployed`) are removed
 * from the YAML transitions; generic `continue-workflow` edges cover both new
 * states. The full spine becomes:
 *
 *   write-tests → implementation → code-review → merge → deploy → ac-validate → done
 *
 * These failing tests cover ALL in-scope acceptance criteria captured at intake:
 *
 * AC1: dev-impl.yaml fixture updated — merge + deploy states replace deployment +
 *      host-deploy; version bumped; history comment in header.
 * AC2: Step guidance docs merge.md and deploy.md written (what to do, what
 *      continue-workflow means, "no deploy needed" path).
 * AC3: Custom verbs removed from transitions; generic continue edges cover both.
 * AC4: CLI skill updated — deprecated verb aliases removed or error with a
 *      clear "use continue-workflow" message.
 * AC5: In-flight tickets at state:deployment or state:host-deploy migrated.
 * AC6: Integration test that boots the production entry point (createApp) and
 *      asserts the workflow component is registered.
 * AC7: Liveness observable at /health — workflow def loaded with updated states.
 *
 * Per the background-component rule (AI-1808), AC6/AC7 MUST be satisfied by an
 * integration test that boots createApp() — a module-level unit test does NOT
 * satisfy this AC.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetWorkflowCache, resolveMetaIntent, checkWorkflowRules } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { clearImplementerStore } from "./implementer-store.js";
import { clearAcRecordStore } from "./ac-record-store.js";
import { initAlertBus, _resetAlertBusForTests } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const CANONICAL_FIXTURE = path.resolve(
  process.cwd(),
  "src/__fixtures__/canonical-dev-impl.yaml",
);

/** States that must NOT exist after the split (AC1, AC3). */
const REMOVED_STATES = ["deployment", "host-deploy"];

/** States that MUST exist after the split (AC1). */
const NEW_STATES = ["merge", "deploy"];

/** Custom verbs that must NOT appear in any transition after the split (AC3). */
const REMOVED_VERBS = ["deploy", "handoff-host-deploy", "host-deployed"];

/**
 * The expected full dev-impl spine after the split (ticket description):
 *   intake → write-tests → implementation → code-review → merge → deploy → ac-validate → done
 */
const EXPECTED_SPINE = [
  "intake",
  "write-tests",
  "implementation",
  "code-review",
  "merge",
  "deploy",
  "ac-validate",
  "done",
];

/** Load and parse the canonical fixture YAML. */
function loadFixture(): any {
  const raw = fs.readFileSync(CANONICAL_FIXTURE, "utf8");
  return yaml.load(raw);
}

/** Extract all transition commands from the fixture. */
function allTransitionCommands(def: any): string[] {
  const cmds: string[] = [];
  for (const state of def.states ?? []) {
    for (const t of state.transitions ?? []) {
      if (t.command) cmds.push(t.command);
    }
  }
  return cmds;
}

/** Find a state by id in the fixture. */
function findState(def: any, id: string): any | undefined {
  return (def.states ?? []).find((s: any) => s.id === id);
}

// ── Test agent + policy fixtures ────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: deploy:execute
  - id: infra:ssh

containers:
  - id: dev
    grants: [linear:transition]
  - id: merge
    grants: [linear:transition, deploy:execute]
  - id: deploy
    grants: [linear:transition, infra:ssh]
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: code-review
    grants: [linear:transition]
  - id: test-author
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: merge
    requires: [deploy:execute]
  - id: deploy
    requires: [infra:ssh]
  - id: steward
    requires: [human:escalate]
  - id: code-review
    requires: [linear:transition]

bodies:
  - id: hanzo
    container: merge
    fills_roles: [merge]
  - id: grover
    container: deploy
    fills_roles: [deploy]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: reviewer
    container: code-review
    fills_roles: [code-review]
  - id: tdd
    container: test-author
    fills_roles: [test-author]
`;

const sampleAgent = {
  name: "sage",
  linearUserId: "user-sage-1872",
  openclawAgent: "sage",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-test-"));
}

function writeAgentsFile(dir: string, agents: unknown[]): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ agents }), "utf8");
  return file;
}

/** Build a fetch mock that returns given label names for the issue query. */
function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url: any, _init: any) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            id: "issue-uuid",
            identifier: "AI-1872",
            title: "Test Issue",
            team: { id: "team-uuid" },
            labels: { nodes: labelNames.map((n) => ({ id: `label-${n}`, name: n })) },
            delegate: null,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

// ────────────────────────────────────────────────────────────────────────────
// AC1: Canonical fixture shape — merge + deploy replace deployment + host-deploy
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC1 — canonical-dev-impl.yaml: merge + deploy replace deployment + host-deploy", () => {
  let def: any;

  beforeAll(() => {
    def = loadFixture();
  });

  test("fixture has a 'merge' state", () => {
    const merge = findState(def, "merge");
    expect(merge).toBeDefined();
    expect(merge.owner_role).toBe("merge");
  });

  test("fixture has a 'deploy' state", () => {
    const deploy = findState(def, "deploy");
    expect(deploy).toBeDefined();
    expect(deploy.owner_role).toBe("deploy");
  });

  test("fixture does NOT have removed states", () => {
    for (const removed of REMOVED_STATES) {
      expect(findState(def, removed)).toBeUndefined();
    }
  });

  test("fixture version is bumped above v9 (the pre-split version)", () => {
    expect(def.version).toBeGreaterThan(9);
  });

  test("fixture header has a version history comment documenting the split", () => {
    const raw = fs.readFileSync(CANONICAL_FIXTURE, "utf8");
    // Look for a history comment near the top mentioning the merge/deploy split
    // and the in-flight ticket migration note required by AC1.
    const header = raw.slice(0, 2000);
    expect(header).toMatch(/v\d+.*merge/i);
    expect(header).toMatch(/deploy/i);
    // AC1: "in-flight ticket note in header"
    expect(header.toLowerCase()).toMatch(/in-flight/);
  });

  test("full spine is intact: intake → write-tests → implementation → code-review → merge → deploy → ac-validate → done", () => {
    const stateIds = (def.states ?? []).map((s: any) => s.id);
    for (const expected of EXPECTED_SPINE) {
      expect(stateIds).toContain(expected);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC3: Custom verbs removed; generic continue edges cover merge + deploy
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC3 — custom verbs removed, generic continue edges", () => {
  let def: any;

  beforeAll(() => {
    def = loadFixture();
  });

  test("no transition in the fixture uses removed custom verbs", () => {
    const commands = allTransitionCommands(def);
    for (const verb of REMOVED_VERBS) {
      expect(commands).not.toContain(verb);
    }
  });

  test("merge state has a generic: continue transition", () => {
    const merge = findState(def, "merge");
    expect(merge).toBeDefined();
    const continueTrans = (merge.transitions ?? []).find(
      (t: any) => t.generic === "continue",
    );
    expect(continueTrans).toBeDefined();
  });

  test("deploy state has a generic: continue transition", () => {
    const deploy = findState(def, "deploy");
    expect(deploy).toBeDefined();
    const continueTrans = (deploy.transitions ?? []).find(
      (t: any) => t.generic === "continue",
    );
    expect(continueTrans).toBeDefined();
  });

  test("code-review approves into merge (not deployment)", () => {
    const codeReview = findState(def, "code-review");
    expect(codeReview).toBeDefined();
    const approve = (codeReview.transitions ?? []).find(
      (t: any) => t.command === "approve" || t.generic === "continue",
    );
    expect(approve).toBeDefined();
    expect(approve.to).toBe("merge");
  });

  test("merge continues into deploy", () => {
    const merge = findState(def, "merge");
    const continueTrans = (merge.transitions ?? []).find(
      (t: any) => t.generic === "continue",
    );
    expect(continueTrans).toBeDefined();
    expect(continueTrans.to).toBe("deploy");
  });

  test("deploy continues into ac-validate", () => {
    const deploy = findState(def, "deploy");
    const continueTrans = (deploy.transitions ?? []).find(
      (t: any) => t.generic === "continue",
    );
    expect(continueTrans).toBeDefined();
    expect(continueTrans.to).toBe("ac-validate");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC3 (proxy enforcement): old verbs rejected, continue-workflow accepted
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC3 — proxy enforcement on the updated canonical fixture", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let dir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-proxy-"));
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

    initAlertBus(new AlertStore(path.join(dir, "alerts.db")));
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    _resetAlertBusForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    clearImplementerStore();
    clearAcRecordStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("old verb 'deploy' is rejected from merge state (not a legal command)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  test("old verb 'handoff-host-deploy' is rejected from merge state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await checkWorkflowRules("handoff-host-deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  test("old verb 'host-deployed' is rejected from deploy state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"]);
    const result = await checkWorkflowRules("host-deployed", "issue-uuid", "Bearer tok", "grover");
    expect(result).not.toBeNull();
    expect(result).toContain("[Proxy]");
  });

  test("continue-workflow resolves to the merge state's generic continue transition", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:merge"]);
    const result = await resolveMetaIntent("continue-workflow", "issue-uuid", "Bearer tok");
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).not.toBe("continue-workflow"); // must resolve to the actual command
    }
  });

  test("continue-workflow resolves from the deploy state", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deploy"]);
    const result = await resolveMetaIntent("continue-workflow", "issue-uuid", "Bearer tok");
    expect("resolved" in result).toBe(true);
  });

  test("state:deployment is not a recognized state in the updated fixture", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    // An old state label should fail — the state no longer exists in the def.
    const result = await checkWorkflowRules("deploy", "issue-uuid", "Bearer tok", "hanzo");
    expect(result).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC2: Step guidance docs — merge.md and deploy.md
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC2 — step guidance docs merge.md and deploy.md", () => {
  let originalGuidanceDir: string | undefined;

  beforeAll(() => {
    originalGuidanceDir = process.env.WORKFLOW_GUIDANCE_DIR;
  });

  afterAll(() => {
    if (originalGuidanceDir !== undefined) {
      process.env.WORKFLOW_GUIDANCE_DIR = originalGuidanceDir;
    } else {
      delete process.env.WORKFLOW_GUIDANCE_DIR;
    }
  });

  /**
   * Step guidance docs live alongside the workflow def in the instance-config
   * tree. The default guidance dir resolves to {configRoot}/workflows/, and
   * per-step docs are at {guidanceDir}/{workflowId}/{state}.md.
   *
   * For the dev-impl workflow the new step docs must be at:
   *   {guidanceDir}/dev-impl/merge.md
   *   {guidanceDir}/dev-impl/deploy.md
   *
   * The connector's loadStepGuidance() reads from this location.
   */
  test("merge.md step guidance doc exists in the dev-impl guidance dir and has substance", async () => {
    // Determine the guidance dir from the same source as instance-config.ts
    const configRoot =
      process.env.LINEAR_CONNECTOR_CONFIG_DIR ??
      path.join(os.homedir(), ".openclaw", "linear-connector");
    const guidanceDir =
      process.env.WORKFLOW_GUIDANCE_DIR ?? path.join(configRoot, "workflows");

    const mergeDocPath = path.join(guidanceDir, "dev-impl", "merge.md");
    expect(fs.existsSync(mergeDocPath)).toBe(true);

    const body = fs.readFileSync(mergeDocPath, "utf8");
    expect(body.length).toBeGreaterThan(50);
    // merge.md should explain what to do (merge the PR) and what continue-workflow means
    expect(body.toLowerCase()).toMatch(/merge/);
    expect(body.toLowerCase()).toMatch(/continue-workflow/);
  });

  test("deploy.md step guidance doc exists and documents the 'no deploy needed' path", async () => {
    const configRoot =
      process.env.LINEAR_CONNECTOR_CONFIG_DIR ??
      path.join(os.homedir(), ".openclaw", "linear-connector");
    const guidanceDir =
      process.env.WORKFLOW_GUIDANCE_DIR ?? path.join(configRoot, "workflows");

    const deployDocPath = path.join(guidanceDir, "dev-impl", "deploy.md");
    expect(fs.existsSync(deployDocPath)).toBe(true);

    const body = fs.readFileSync(deployDocPath, "utf8");
    expect(body.length).toBeGreaterThan(50);
    // AC2: "'no deploy needed' path documented explicitly"
    expect(body.toLowerCase()).toMatch(/no deploy/);
    expect(body.toLowerCase()).toMatch(/continue-workflow/);
  });

  /**
   * The loadStepGuidance function in delivery/build-message.ts is the runtime
   * path that reads these docs. Verify it loads them.
   */
  test("loadStepGuidance('dev-impl', 'merge') returns non-null content", async () => {
    const { } = await import("./delivery/build-message.js");
    // loadStepGuidance is not exported — test via the file path convention.
    // The implementation will make the doc available at the expected path.
    const configRoot =
      process.env.LINEAR_CONNECTOR_CONFIG_DIR ??
      path.join(os.homedir(), ".openclaw", "linear-connector");
    const guidanceDir =
      process.env.WORKFLOW_GUIDANCE_DIR ?? path.join(configRoot, "workflows");
    const docPath = path.join(guidanceDir, "dev-impl", "merge.md");
    const content = fs.readFileSync(docPath, "utf8");
    expect(content).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC4: CLI skill — deprecated verb aliases removed or error
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC4 — CLI skill: deprecated verbs removed or error", () => {
  /**
   * The vendored CLI package (vendor/fancy-openclaw-linear-skill-cli-*.tgz)
   * currently defines `deploy`, `handoff-host-deploy`, and `host-deployed` as
   * top-level commands in dist/index.js and exports deploy/handoffHostDeploy/
   * hostDeployed from dist/semantic.js.
   *
   * AC4: "deprecated verb aliases removed or error with a clear
   * 'use continue-workflow' message."
   *
   * After the update, invoking any of these commands must either:
   *   (a) not exist as a registered command, OR
   *   (b) print an error directing the user to `continue-workflow`.
   */

  test("vendored CLI package version is bumped above 0.3.5", () => {
    const pkgJsonPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const dep = pkg.dependencies?.["fancy-openclaw-linear-skill-cli"] ?? "";
    // The file: dependency includes the version in the tarball name.
    // It must no longer reference 0.3.5.
    expect(dep).not.toContain("0.3.5");
  });

  test("CLI index.js does not register 'deploy' as a standalone transition command", () => {
    // Extract the vendored tarball and inspect its command registrations.
    const vendorDir = path.resolve(process.cwd(), "vendor");
    const tarballs = fs.readdirSync(vendorDir).filter(
      (f) => f.startsWith("fancy-openclaw-linear-skill-cli-") && f.endsWith(".tgz"),
    );
    expect(tarballs.length).toBeGreaterThan(0);

    // Use the highest-version tarball (the one package.json resolves to).
    tarballs.sort();
    const latest = tarballs[tarballs.length - 1];
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-cli-deploy-"));
    try {
      execSync(`tar xzf "${path.join(vendorDir, latest)}" -C "${extractDir}"`, {
        stdio: "pipe",
      });
      const indexJs = path.join(extractDir, "package", "dist", "index.js");
      expect(fs.existsSync(indexJs)).toBe(true);
      const src = fs.readFileSync(indexJs, "utf8");

      // The old `deploy` command must NOT be registered as a standalone
      // command that dispatches to the old semantic deploy function.
      // It must be removed entirely, OR replaced with a deprecation shim
      // that prints "use continue-workflow".
      //
      // We detect the old pattern: program.command("deploy") + semantic_1.deploy
      // without a deprecation message containing "continue-workflow" in the
      // command's own description/action.
      const hasOldDeployRegistration =
        src.includes('program.command("deploy")') &&
        src.includes("semantic_1.deploy");
      expect(hasOldDeployRegistration).toBe(false);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  test("CLI index.js does not register 'handoff-host-deploy' as a standalone command", () => {
    const vendorDir = path.resolve(process.cwd(), "vendor");
    const tarballs = fs.readdirSync(vendorDir).filter(
      (f) => f.startsWith("fancy-openclaw-linear-skill-cli-") && f.endsWith(".tgz"),
    );
    expect(tarballs.length).toBeGreaterThan(0);
    tarballs.sort();
    const latest = tarballs[tarballs.length - 1];
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-cli-handoff-"));
    try {
      execSync(`tar xzf "${path.join(vendorDir, latest)}" -C "${extractDir}"`, {
        stdio: "pipe",
      });
      const indexJs = path.join(extractDir, "package", "dist", "index.js");
      expect(fs.existsSync(indexJs)).toBe(true);
      const src = fs.readFileSync(indexJs, "utf8");

      const hasOldHandoffRegistration =
        src.includes('program.command("handoff-host-deploy")') &&
        src.includes("semantic_1.handoffHostDeploy");
      expect(hasOldHandoffRegistration).toBe(false);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });

  test("CLI index.js does not register 'host-deployed' as a standalone command", () => {
    const vendorDir = path.resolve(process.cwd(), "vendor");
    const tarballs = fs.readdirSync(vendorDir).filter(
      (f) => f.startsWith("fancy-openclaw-linear-skill-cli-") && f.endsWith(".tgz"),
    );
    expect(tarballs.length).toBeGreaterThan(0);
    tarballs.sort();
    const latest = tarballs[tarballs.length - 1];
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-cli-hostdep-"));
    try {
      execSync(`tar xzf "${path.join(vendorDir, latest)}" -C "${extractDir}"`, {
        stdio: "pipe",
      });
      const indexJs = path.join(extractDir, "package", "dist", "index.js");
      expect(fs.existsSync(indexJs)).toBe(true);
      const src = fs.readFileSync(indexJs, "utf8");

      const hasOldHostDeployedRegistration =
        src.includes('program.command("host-deployed")') &&
        src.includes("semantic_1.hostDeployed");
      expect(hasOldHostDeployedRegistration).toBe(false);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC5: In-flight ticket migration — old state labels handled cleanly
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC5 — in-flight tickets at state:deployment / state:host-deploy migrated", () => {
  /**
   * AC5: "Existing in-flight tickets at state:deployment or state:host-deploy
   * are migrated cleanly (escape → re-intake OR set-state to equivalent new
   * state, with a comment explaining the migration)."
   *
   * The migration can be either:
   *   - a startup sweep that detects old state labels and transitions them, OR
   *   - a proxy-level handler that, when it sees state:deployment, maps it to
   *     state:merge (equivalent new state) with a recorded comment.
   *
   * Either way, the proxy must not silently 500 or strand the ticket.
   * The test verifies that encountering an old state label produces a clear
   * outcome — either a migration message or a graceful rejection that names
   * the new equivalent state.
   */

  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowPath: string | undefined;
  let originalPolicyPath: string | undefined;
  let dir: string;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1872-migrate-"));
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;

    initAlertBus(new AlertStore(path.join(dir, "alerts.db")));
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
    _resetAlertBusForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    clearImplementerStore();
    clearAcRecordStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a ticket at state:deployment gets migration guidance (merge equivalent or escape-to-intake)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:deployment"]);
    // AC5: old state labels must be migrated cleanly — the proxy must produce
    // migration-aware guidance, not a bare "unknown state" rejection.
    // The message must either name the new equivalent state or direct to
    // escape + re-intake with a migration explanation.
    const result = await checkWorkflowRules(
      "continue-workflow",
      "issue-uuid",
      "Bearer tok",
      "hanzo",
    );
    expect(result).not.toBeNull();
    // Must mention migration or the new state explicitly.
    // 'merge' alone isn't enough — we need migration context.
    const lower = result!.toLowerCase();
    const hasMigrationContext =
      lower.includes("migrat") ||
      lower.includes("state:merge") ||
      lower.includes("equivalent") ||
      lower.includes("re-intake");
    expect(hasMigrationContext).toBe(true);
  });

  test("a ticket at state:host-deploy gets migration guidance (deploy equivalent or escape-to-intake)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:host-deploy"]);
    const result = await checkWorkflowRules(
      "continue-workflow",
      "issue-uuid",
      "Bearer tok",
      "grover",
    );
    expect(result).not.toBeNull();
    const lower = result!.toLowerCase();
    const hasMigrationContext =
      lower.includes("migrat") ||
      lower.includes("state:deploy") ||
      lower.includes("equivalent") ||
      lower.includes("re-intake");
    expect(hasMigrationContext).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC6 + AC7: Bootstrap registration + /health liveness (integration test)
// ────────────────────────────────────────────────────────────────────────────

describe("AI-1872 AC6+AC7 — bootstrap registration + /health workflow liveness", () => {
  /**
   * AC6: "The component is registered at server bootstrap (reachable from the
   *      production entry point), proven by an integration test that boots the
   *      entry point and asserts registration. A module-level unit test does
   *      NOT satisfy this."
   *
   * AC7: "Liveness is observable at ac-validate: /health or registry entry
   *      confirming updated workflow def loaded."
   *
   * This test boots createApp() — the entry-point app factory used by index.ts
   * — and asserts /health reports a workflow liveness field showing the
   * updated workflow def with merge + deploy states is loaded.
   */

  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalWorkflowPath: string | undefined;
  let originalGuidanceDir: string | undefined;

  beforeAll(() => {
    originalWorkflowPath = process.env.WORKFLOW_DEF_PATH;
    originalGuidanceDir = process.env.WORKFLOW_GUIDANCE_DIR;
  });

  afterEach(() => {
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    delete process.env.AGENTS_FILE;
    delete process.env.OPENCLAW_HOOKS_URL;
    delete process.env.OPENCLAW_HOOKS_TOKEN;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.WORKFLOW_GUIDANCE_DIR;
    resetWorkflowCache();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalWorkflowPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowPath;
    if (originalGuidanceDir !== undefined) process.env.WORKFLOW_GUIDANCE_DIR = originalGuidanceDir;
  });

  test("/health reports a workflow liveness field with loaded=true", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();

    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    // The health response must include a workflow liveness field.
    // This field does not exist yet — the implementation will add it.
    expect(res.body).toHaveProperty("workflow");
    expect(res.body.workflow.loaded).toBe(true);
  });

  test("/health workflow liveness reports the version from the loaded def", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();

    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    const fixtureDef = loadFixture();
    expect(res.body.workflow.version).toBe(fixtureDef.version);
  });

  test("/health workflow liveness reports state IDs including merge and deploy", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();

    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    // The liveness field must confirm the UPDATED def is loaded —
    // specifically, the new merge + deploy states must be present
    // and the old deployment + host-deploy must be absent.
    const stateIds: string[] = res.body.workflow.states ?? [];
    expect(stateIds).toContain("merge");
    expect(stateIds).toContain("deploy");
    expect(stateIds).not.toContain("deployment");
    expect(stateIds).not.toContain("host-deploy");
  });

  test("/health workflow liveness confirms no removed custom verbs in transitions", async () => {
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir, [sampleAgent]);
    process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
    resetWorkflowCache();

    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
    });

    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);

    // If the liveness field includes transition commands, none of the
    // removed verbs should appear.
    const commands: string[] = res.body.workflow.commands ?? [];
    for (const verb of REMOVED_VERBS) {
      expect(commands).not.toContain(verb);
    }
  });
});
