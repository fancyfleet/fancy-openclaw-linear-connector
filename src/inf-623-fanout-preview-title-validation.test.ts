/**
 * INF-623 — fanout preview must validate child title before parent advances.
 *
 * AC mapping:
 * - Preview refuses an invalid wf:dev-sprint child title before posting a
 *   successful preview or advancing the parent to the destination barrier.
 * - Preview and create paths share the same sprint-title shape validation.
 * - Refused preview returns a clear non-satisfying outcome.
 * - LIF-45/INF-619 regression shape: date "Sprint" title refused, Cycle/Theme accepted.
 * - Production entry point registration/liveness is observable without waiting
 *   for a trigger.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeFanout, type Finding } from "./fanout.js";
import { applyStateTransition, resetWorkflowCache, type FanoutConfig } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";

const INVALID_SPRINT_TITLE = "📶 LifeOS 2026-07-25 Sprint";
const VALID_SPRINT_TITLE = "📶 LifeOS Cycle 8 — Signal Layer";

const DEV_SPRINT_FANOUT = {
  spec_source: "findings",
  child_workflow: "wf:dev-sprint",
} as FanoutConfig;

type GqlCall = { query: string; variables: Record<string, unknown> };

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeExecuteFanoutFetch(record: GqlCall[]): typeof globalThis.fetch {
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    record.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("IssueTeamParent")) {
      return json({
        issue: {
          id: "parent-internal-id",
          title: "LifeOS sprint parent",
          description: null,
          team: { id: "team-uuid" },
          parent: null,
        },
      });
    }
    if (query.includes("FanoutChildren")) {
      return json({ issue: { children: { nodes: [] } } });
    }
    if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
      return json({ issue: { parent: null } });
    }
    if (query.includes("TeamLabels")) {
      return json({
        team: {
          labels: {
            nodes: [
              { id: "label-wf-dev-sprint", name: "wf:dev-sprint" },
              { id: "label-state-todo", name: "state:todo" },
            ],
          },
        },
      });
    }
    if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
      const name = String(parsed.variables?.name ?? "unknown");
      return json({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("issueCreate")) {
      const input = parsed.variables?.input as Record<string, unknown>;
      return json({
        issueCreate: {
          success: true,
          issue: {
            id: `child-${String(input.title).replace(/\s+/g, "-")}`,
            identifier: "LIF-623",
          },
        },
      });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "comment-id" } } });
    }

    throw new Error(`unexpected query: ${query.slice(0, 120)}`);
  };
}

function previewCommentBodies(record: GqlCall[]): string[] {
  return record
    .filter((c) => c.query.includes("commentCreate"))
    .map((c) => String(c.variables.body ?? ""));
}

describe("INF-623 preview/create sprint title validation", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("AC: preview path refuses LIF-45 date-shaped wf:dev-sprint title before successful preview or child create", async () => {
    const record: GqlCall[] = [];
    globalThis.fetch = makeExecuteFanoutFetch(record);

    const result = await executeFanout("LIF-45", "Bearer tok", DEV_SPRINT_FANOUT, {
      findingsOverride: [{ title: INVALID_SPRINT_TITLE }],
      existingChildren: [],
    });

    expect(result.created).toBe(0);
    expect(result.childIdentifiers).toEqual([]);
    expect(result.pendingApproval).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.preview).toBeNull();
    expect(result.errors.map((e) => e.message).join("\n")).toMatch(/sprint title|Cycle <N>|theme/i);
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(previewCommentBodies(record).join("\n")).not.toMatch(/Preview generated|fan-out will proceed/i);
  });

  test("AC: create path and preview path share the same sprint-title validator", async () => {
    const previewRecord: GqlCall[] = [];
    globalThis.fetch = makeExecuteFanoutFetch(previewRecord);
    const previewResult = await executeFanout("INF-619", "Bearer tok", DEV_SPRINT_FANOUT, {
      findingsOverride: [{ title: INVALID_SPRINT_TITLE }],
      existingChildren: [],
    });

    const createRecord: GqlCall[] = [];
    globalThis.fetch = makeExecuteFanoutFetch(createRecord);
    const createResult = await executeFanout("INF-619", "Bearer tok", DEV_SPRINT_FANOUT, {
      skipPreview: true,
      findingsOverride: [{ title: INVALID_SPRINT_TITLE }],
      existingChildren: [],
    });

    expect(previewResult.refused).toBe(true);
    expect(createResult.refused).toBe(true);
    expect(previewResult.errors.map((e) => e.message)).toEqual(createResult.errors.map((e) => e.message));
    expect(previewRecord.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(createRecord.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  test("AC regression: Cycle/Theme wf:dev-sprint title is accepted and minted", async () => {
    const record: GqlCall[] = [];
    globalThis.fetch = makeExecuteFanoutFetch(record);

    const result = await executeFanout("LIF-45", "Bearer tok", DEV_SPRINT_FANOUT, {
      findingsOverride: [{ title: VALID_SPRINT_TITLE } satisfies Finding],
      existingChildren: [],
    });

    expect(result.refused).toBe(false);
    expect(result.created).toBe(1);
    expect(result.childIdentifiers).toEqual(["LIF-623"]);
    const createCall = record.find((c) => c.query.includes("issueCreate"));
    expect(createCall).toBeDefined();
    expect((createCall!.variables.input as Record<string, unknown>).title).toBe(VALID_SPRINT_TITLE);
  });
});

const PARENT_WORKFLOW_YAML = `
id: inf-623-parent
version: 1
entry_state: spawning
states:
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:dev-sprint
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: doing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;

const CHILD_WORKFLOW_YAML = `
id: dev-sprint
version: 1
entry_state: todo
states:
  - id: todo
    owner_role: engine
    native_state: todo
    transitions:
      - { command: start, to: doing }
  - id: doing
    owner_role: engine
    native_state: doing
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: engine
    grants: [linear:transition]
roles:
  - id: engine
    requires: [linear:transition]
bodies:
  - id: engine-1
    container: engine
    fills_roles: [engine]
`;

function makeApplyTransitionFetch(parentDescription: string, record: GqlCall[]): typeof globalThis.fetch {
  const parentLabels = [
    { id: "label-parent-wf", name: "wf:inf-623-parent" },
    { id: "label-state-spawning", name: "state:spawning" },
  ];
  return async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected fetch call");
    }
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = parsed.query ?? "";
    record.push({ query, variables: parsed.variables ?? {} });

    if (query.includes("IssueWithLabels")) {
      return json({
        issue: {
          id: "parent-internal-id",
          identifier: "INF-623",
          team: { id: "team-uuid" },
          labels: { nodes: parentLabels },
        },
      });
    }
    if (query.includes("IssueWithComments")) {
      return json({
        issue: {
          id: "parent-internal-id",
          description: parentDescription,
          comments: { nodes: [] },
        },
      });
    }
    if (query.includes("TeamStates")) {
      return json({
        team: {
          states: {
            nodes: [
              { id: "native-todo", name: "Todo", type: "unstarted" },
              { id: "native-doing", name: "Doing", type: "started" },
              { id: "native-done", name: "Done", type: "completed" },
            ],
          },
        },
      });
    }
    if (query.includes("TeamLabels")) {
      return json({
        team: {
          labels: {
            nodes: [
              { id: "label-parent-wf", name: "wf:inf-623-parent" },
              { id: "label-child-wf", name: "wf:dev-sprint" },
              { id: "label-state-spawning", name: "state:spawning" },
              { id: "label-state-managing", name: "state:managing" },
              { id: "label-state-todo", name: "state:todo" },
            ],
          },
        },
      });
    }
    if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
      const name = String(parsed.variables?.name ?? "unknown");
      return json({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
    }
    if (query.includes("ApplyAtomicTransition")) {
      return json({ issueUpdate: { success: true } });
    }
    if (query.includes("VerifyIssueLabels")) {
      return json({
        issue: {
          labels: {
            nodes: [
              { id: "label-parent-wf", name: "wf:inf-623-parent" },
              { id: "label-state-managing", name: "state:managing" },
            ],
          },
          state: { id: "native-doing", name: "Doing" },
          assignee: null,
        },
      });
    }
    if (query.includes("IssueTeamParent")) {
      return json({
        issue: {
          id: "parent-internal-id",
          title: "INF-623 parent",
          description: parentDescription,
          team: { id: "team-uuid" },
          parent: null,
        },
      });
    }
    if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
      return json({ issue: { parent: null } });
    }
    if (query.includes("FanoutChildren")) {
      return json({ issue: { children: { nodes: [] } } });
    }
    if (query.includes("issueCreate")) {
      return json({ issueCreate: { success: true, issue: { id: "child-id", identifier: "LIF-623" } } });
    }
    if (query.includes("commentCreate")) {
      return json({ commentCreate: { success: true, comment: { id: "comment-id" } } });
    }

    throw new Error(`unexpected query: ${query.slice(0, 120)}`);
  };
}

describe("INF-623 parent advance is blocked before managing barrier", () => {
  let dir: string;
  let defsDir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalDefsDir: string | undefined;
  let originalPolicyPath: string | undefined;
  let originalAgentsFile: string | undefined;

  beforeAll(() => {
    originalDefsDir = process.env.WORKFLOW_DEFS_DIR;
    originalPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-623-workflow-"));
    defsDir = path.join(dir, "defs");
    fs.mkdirSync(defsDir);
    fs.writeFileSync(path.join(defsDir, "inf-623-parent.yaml"), PARENT_WORKFLOW_YAML, "utf8");
    fs.writeFileSync(path.join(defsDir, "dev-sprint.yaml"), CHILD_WORKFLOW_YAML, "utf8");
    const policyPath = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyPath, CAPABILITY_POLICY_YAML, "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "engine-1",
            linearUserId: "engine-linear-id",
            clientId: "engine-client",
            clientSecret: "engine-secret",
            accessToken: "engine-token",
            refreshToken: "engine-refresh",
          },
        ],
      }),
      "utf8",
    );
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    process.env.CAPABILITY_POLICY_PATH = policyPath;
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
  });

  afterAll(() => {
    if (originalDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = originalDefsDir;
    if (originalPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = originalPolicyPath;
    if (originalAgentsFile === undefined) delete process.env.AGENTS_FILE;
    else process.env.AGENTS_FILE = originalAgentsFile;
    reloadAgents();
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkflowCache();
    resetPolicyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("AC: invalid sprint title is refused pre-advance, leaving no managing parent with zero children", async () => {
    const record: GqlCall[] = [];
    globalThis.fetch = makeApplyTransitionFetch(`## Findings\n- **${INVALID_SPRINT_TITLE}**\n`, record);

    const result = await applyStateTransition("spawn", "INF-623", "Bearer tok");

    expect(result.status).toBe("failed");
    expect(result.code).toMatch(/fanout|title|invalid|preview/i);
    expect(String(result.detail ?? "")).toMatch(/sprint title|Cycle <N>|theme/i);
    expect(record.some((c) => c.query.includes("ApplyAtomicTransition"))).toBe(false);
    expect(record.some((c) => c.query.includes("issueCreate"))).toBe(false);
    const commentBody = previewCommentBodies(record).join("\n");
    expect(commentBody).toMatch(/refus|invalid|sprint title|Cycle/i);
    expect(commentBody).not.toMatch(/Preview generated|fan-out will proceed/i);
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const PORT = 5100 + (process.pid % 200);

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return (await res.json()) as Record<string, any>;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

describe("INF-623 production bootstrap registration/liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";
  let health: Record<string, any>;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`dist/index.js not found at ${DIST_ENTRY}; run npm run build before jest`);
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-623-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: [
          {
            name: "ai",
            linearUserId: "ai-linear-id",
            openclawAgent: "ai",
            clientId: "ai-client",
            clientSecret: "ai-secret",
            accessToken: "ai-token",
            refreshToken: "ai-refresh",
          },
        ],
      }),
      "utf8",
    );

    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: agentsFile,
        DATA_DIR: path.join(dir, "data"),
        PORT: String(PORT),
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PORT}/noop-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-hooks-token",
        CRON_STARTUP_GRACE_MS: "60000",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });

    try {
      health = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
    } catch (err) {
      throw new Error(
        `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
        `child stderr:\n${childStderr}`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 2000);
        child?.on("exit", () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC: production entry point exposes fanout preview/create registration and liveness before a trigger", () => {
    expect(health).toHaveProperty("fanoutPreviewCreate");
    expect(health.fanoutPreviewCreate).toMatchObject({
      registered: true,
      subscribed: true,
      sprintTitleValidation: {
        preview: true,
        create: true,
      },
    });
  });
});
