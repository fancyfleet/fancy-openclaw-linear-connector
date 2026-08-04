/**
 * INF-1176 — generic fleet role/steward/resolver coverage.
 *
 * AC mapping:
 * - No src/ logic path branches/defaults on agent-name string literals for
 *   role/roster/steward resolution: static source guard below.
 * - index.ts review/merge phase classification resolves from owner_role:
 *   checkWorkflowRules accepts renamed bodies that fill code-review/deployment.
 * - ac-verify-resolver + rescue-sweep resolve code-review body from live config:
 *   rescue-sweep delegates a code-review ticket to a renamed registered body,
 *   and never returns an unregistered fallback id.
 * - Bootstrap addendum: production entry point registers connector sweeps and
 *   liveness is observable through /health.crons.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import ts from "typescript";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { runRescueSweep } from "./rescue-sweep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "index.js");

const AGENTS = [
  { name: "review-unit", linearUserId: "11111111-1111-4111-8111-111111111111", openclawAgent: "review-unit", clientId: "c", clientSecret: "s", accessToken: "tok-review", refreshToken: "r", host: "local" },
  { name: "merge-unit", linearUserId: "22222222-2222-4222-8222-222222222222", openclawAgent: "merge-unit", clientId: "c", clientSecret: "s", accessToken: "tok-merge", refreshToken: "r", host: "local" },
  { name: "steward-unit", linearUserId: "33333333-3333-4333-8333-333333333333", openclawAgent: "steward-unit", clientId: "c", clientSecret: "s", accessToken: "tok-steward", refreshToken: "r", host: "local" },
  { name: "dev-unit", linearUserId: "44444444-4444-4444-8444-444444444444", openclawAgent: "dev-unit", clientId: "c", clientSecret: "s", accessToken: "tok-dev", refreshToken: "r", host: "local" },
] as const;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: deploy:execute
  - id: human:escalate
  - id: workflow:break-glass
containers:
  - id: review-container
    grants: [linear:transition]
  - id: deploy-container
    grants: [linear:transition, deploy:execute]
  - id: steward-container
    grants: [linear:transition, human:escalate, workflow:break-glass]
  - id: dev-container
    grants: [linear:transition]
roles:
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]
  - id: steward
    requires: [human:escalate]
  - id: dev
    requires: [linear:transition]
bodies:
  - id: review-unit
    container: review-container
    fills_roles: [code-review]
  - id: merge-unit
    container: deploy-container
    fills_roles: [deployment]
  - id: steward-unit
    container: steward-container
    fills_roles: [steward]
  - id: dev-unit
    container: dev-container
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1176
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        assign: { mode: required, constraint: not-implementer }
  - id: code-review
    owner_role: code-review
    native_state: todo
    transitions:
      - command: approve
        to: merge
        assign: { mode: auto }
      - command: request-changes
        to: implementation
  - id: merge
    owner_role: deployment
    native_state: todo
    transitions:
      - command: continue
        to: deploy
        generic: continue
        requires_capability: deploy:execute
  - id: deploy
    owner_role: deployment
    native_state: todo
    transitions:
      - command: continue
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
`;

const WORKFLOW_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake", owner_role: "steward" },
    { id: "implementation", owner_role: "dev" },
    { id: "code-review", owner_role: "code-review" },
    { id: "merge", owner_role: "deployment" },
    { id: "deploy", owner_role: "deployment" },
    { id: "done", kind: "terminal" },
  ],
};

function writeConfig(dir: string): void {
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ agents: AGENTS }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(path.join(dir, "dev-impl.yaml"), WORKFLOW_YAML, "utf8");
}

function makeWorkflowFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (bodyText.includes("IssueBranchAndPR")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            attachments: {
              nodes: [{ url: "https://github.com/fancyfleet/example/pull/1", sourceType: "github", metadata: { status: "merged" } }],
            },
          },
        },
      }), { status: 200 });
    }
    if (bodyText.includes("delegate")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            identifier: "INF-1176",
            labels: { nodes: labelNames.map((name) => ({ name })) },
            delegate: null,
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
        },
      },
    }), { status: 200 });
  };
}

function makeRescueFetch(delegateIdsSet: string[]): typeof globalThis.fetch {
  return async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("WorkflowIssues") || query.includes("issues(")) {
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [{
              id: "ticket-uuid",
              identifier: "INF-1176",
              updatedAt: new Date(0).toISOString(),
              labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "cr-lbl", name: "state:code-review" }] },
              delegate: null,
              team: { id: "team-1" },
            }],
          },
        },
      }), { status: 200 });
    }
    if (query.includes("TeamLabels")) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), { status: 200 });
    }
    if (query.includes("issueUpdate") && query.includes("delegateId")) {
      delegateIdsSet.push(String(parsed.variables?.delegateId ?? ""));
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
}

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

describe("INF-1176 AC: role phase classification follows owner_role, not body names", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1176-role-"));
    writeConfig(dir);
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
  });

  it("index/proxy review classification accepts a renamed code-review body from capability-policy", async () => {
    globalThis.fetch = makeWorkflowFetch(["wf:dev-impl", "state:code-review"]);
    await expect(checkWorkflowRules("approve", "INF-1176", "Bearer tok", "review-unit")).resolves.toBeNull();
  });

  it("index/proxy merge classification accepts a renamed deployment body from capability-policy", async () => {
    globalThis.fetch = makeWorkflowFetch(["wf:dev-impl", "state:merge"]);
    await expect(checkWorkflowRules("continue", "INF-1176", "Bearer tok", "merge-unit")).resolves.toBeNull();
  });
});

describe("INF-1176 AC: ac-verify/rescue code-review body comes from live config", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1176-rescue-"));
    writeConfig(dir);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rescue-sweep delegates code-review to the registered role body and never to an unregistered literal", async () => {
    const delegateIdsSet: string[] = [];
    globalThis.fetch = makeRescueFetch(delegateIdsSet);

    const result = await runRescueSweep({
      authToken: "Bearer test",
      workflowRegistry: new Map([["dev-impl", WORKFLOW_DEF]]),
      capabilityPolicyPath: path.join(dir, "capability-policy.yaml"),
      bodyIdToLinearUserId: (bodyId) => AGENTS.find((a) => a.name === bodyId)?.linearUserId ?? null,
    });

    expect(delegateIdsSet).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(delegateIdsSet).not.toContain("cra");
    expect(delegateIdsSet).not.toContain("charles");
    expect(result.rescues[0]?.outcome).toBe("rescued");
  });

  it("rescue-sweep fails closed instead of returning an unregistered body id for code-review", async () => {
    fs.writeFileSync(
      path.join(dir, "capability-policy.yaml"),
      POLICY_YAML.replace("id: review-unit", "id: ghost-reviewer"),
      "utf8",
    );
    const delegateIdsSet: string[] = [];
    globalThis.fetch = makeRescueFetch(delegateIdsSet);

    const result = await runRescueSweep({
      authToken: "Bearer test",
      workflowRegistry: new Map([["dev-impl", WORKFLOW_DEF]]),
      capabilityPolicyPath: path.join(dir, "capability-policy.yaml"),
      bodyIdToLinearUserId: (bodyId) => AGENTS.find((a) => a.name === bodyId)?.linearUserId ?? null,
    });

    expect(delegateIdsSet).toEqual([]);
    expect(result.rescues[0]?.outcome).toBe("failed");
    expect(result.rescues[0]?.action).toMatch(/unregistered|unresolved|no registered/i);
  });
});

describe("INF-1176 AC: no registered fleet agent-name string literals in src logic", () => {
  const registeredFleetNames = new Set([
    "ai", "astrid", "charles", "colette", "felix", "finn", "grover", "hanzo",
    "hodor", "igor", "jiwon", "kana", "ken", "kenji", "lacey", "laren",
    "maren", "mckell", "mika", "noah", "penny", "poe", "sage", "scout",
    "signe", "tdd", "yoshi", "cra",
  ]);

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__fixtures__" || entry.name === "__tests__" || entry.name === "test-support") return [];
        return sourceFiles(full);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
      return [full];
    });
  }

  function stringLiterals(file: string): Array<{ text: string; line: number }> {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const literals: Array<{ text: string; line: number }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        literals.push({ text: node.text, line: line + 1 });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return literals;
  }

  it("fails if any production logic string literal equals a registered fleet agent name", () => {
    const offenders = sourceFiles(path.join(repoRoot, "src")).flatMap((file) =>
      stringLiterals(file)
        .filter((literal) => registeredFleetNames.has(literal.text.toLowerCase()))
        .map((literal) => `${path.relative(repoRoot, file)}:${literal.line} -> ${JSON.stringify(literal.text)}`),
    );

    expect(offenders).toEqual([]);
  });
});

describe("INF-1176 bootstrap AC: touched sweep/event components are registered at production entry", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let stderr = "";
  const port = 4900 + (process.pid % 200);

  beforeAll(() => {
    if (!fs.existsSync(distEntry)) {
      throw new Error(`dist/index.js not found at ${distEntry}; run npm run build before this test`);
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1176-bootstrap-"));
    writeConfig(dir);
    child = spawn(process.execPath, [distEntry], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: path.join(dir, "agents.json"),
        CAPABILITY_POLICY_PATH: path.join(dir, "capability-policy.yaml"),
        WORKFLOW_DEF_PATH: path.join(dir, "dev-impl.yaml"),
        DATA_DIR: path.join(dir, "data"),
        PORT: String(port),
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${port}/hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-hooks-token",
        RESCUE_SWEEP_INTERVAL: "999999h",
        BOOTSTRAP_RECONCILIATION_INTERVAL: "999999h",
        DELEGATION_RECONCILIATION_INTERVAL: "999999h",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
  });

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

  it("boots dist/index.js and exposes connector sweep registrations through /health.crons", async () => {
    let body: Record<string, any>;
    try {
      body = await pollHealth(`http://127.0.0.1:${port}/health`, 30_000);
    } catch (err) {
      throw new Error(`entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n${stderr}`);
    }

    const cronNames = new Set((body.crons as Array<{ name?: string }>).map((cron) => cron.name));
    expect([...cronNames]).toEqual(expect.arrayContaining([
      "rescue-sweep",
      "bootstrap-reconciliation-sweep",
      "delegation-reconciliation-sweep",
      "registry-integrity-check",
    ]));
    expect(body.rescueSweep).toBeDefined();
  }, 60_000);
});
