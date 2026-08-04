import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";

const CANONICAL_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: workflow:break-glass
  - id: workflow:force-deploy
  - id: infra:ssh

containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass, workflow:force-deploy]
  - id: host-deploy
    grants: [linear:transition, infra:ssh]
  - id: dev
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: host-deploy
    requires: [infra:ssh]
  - id: dev
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
    linearUserId: u-astrid
  - id: grover
    container: host-deploy
    fills_roles: [host-deploy]
    linearUserId: u-grover
  - id: igor
    container: dev
    fills_roles: [dev]
    linearUserId: u-igor
`;

let dir: string;
let savedFetch: typeof globalThis.fetch;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-867-"));
  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", clientId: "a", clientSecret: "a", accessToken: "a", refreshToken: "a" },
        { name: "grover", linearUserId: "u-grover", clientId: "g", clientSecret: "g", accessToken: "g", refreshToken: "g" },
        { name: "igor", linearUserId: "u-igor", clientId: "i", clientSecret: "i", accessToken: "i", refreshToken: "i" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;
  process.env.WORKFLOW_DEF_PATH = CANONICAL_FIXTURE;
  reloadAgents();
  savedFetch = globalThis.fetch;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_FILE;
  delete process.env.WORKFLOW_DEF_PATH;
  globalThis.fetch = savedFetch;
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
  globalThis.fetch = makeContextFetch("u-tdd");
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function loadFixture(): { states: Array<{ id: string; transitions?: Array<{ command: string; to: string; generic?: string }> }> } {
  return yaml.load(fs.readFileSync(CANONICAL_FIXTURE, "utf8")) as ReturnType<typeof loadFixture>;
}

function makeContextFetch(delegateId: string | null): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("IssueContext")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "INF-867",
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
              delegate: delegateId ? { id: delegateId } : null,
              state: { id: "state-todo", name: "Todo", type: "unstarted" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (body.includes("IssueBranchAndPR")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              description: "",
              comments: { nodes: [] },
              attachments: {
                nodes: [
                  {
                    url: "https://github.com/fancyfleet/life-os/pull/92",
                    sourceType: "github",
                    metadata: { status: "merged" },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("INF-867: post-escape recovery from dev-impl intake", () => {
  it("adds an explicit force-deploy edge from intake to deploy", () => {
    const def = loadFixture();
    const intake = def.states.find((s) => s.id === "intake");
    const recovery = intake?.transitions?.find((t) => t.command === "force-deploy");
    expect(recovery).toBeDefined();
    expect(recovery?.to).toBe("deploy");
  });

  it("does not make ordinary intake continuation skip test authoring", () => {
    const def = loadFixture();
    const intake = def.states.find((s) => s.id === "intake");
    const accept = intake?.transitions?.find((t) => t.command === "accept");
    expect(accept?.to).toBe("write-tests");
    expect(intake?.transitions?.some((t) => t.command === "continue" || t.generic === "continue")).toBe(false);
  });

  it("blocks force-deploy from intake without an evidence comment", async () => {
    const result = await checkWorkflowRules(
      "force-deploy",
      "issue-uuid",
      "Bearer tok",
      "astrid",
      null,
      "u-astrid",
      null,
      false,
      false,
      false,
      undefined,
      undefined,
      null,
    );
    expect(result).toMatch(/requires a comment/i);
  });

  it("blocks force-deploy from intake when the comment lacks a merge reference", async () => {
    const result = await checkWorkflowRules(
      "force-deploy",
      "issue-uuid",
      "Bearer tok",
      "astrid",
      null,
      "u-astrid",
      null,
      false,
      false,
      true,
      undefined,
      undefined,
      "deployment looks fine",
    );
    expect(result).toMatch(/merge evidence reference/i);
  });

  it("allows steward force-deploy from intake with PR/SHA evidence", async () => {
    const result = await checkWorkflowRules(
      "force-deploy",
      "issue-uuid",
      "Bearer tok",
      "astrid",
      null,
      "u-astrid",
      null,
      false,
      false,
      true,
      undefined,
      undefined,
      "Recovered after verified squash merge: https://github.com/fancyfleet/life-os/pull/92 at f01b45cbadd1744a7218cd13bcd04e94a802a4b1.",
    );
    expect(result).toBeNull();
  });

  it("does not allow a non-steward implementer to use the recovery edge", async () => {
    globalThis.fetch = makeContextFetch("u-igor");
    const result = await checkWorkflowRules(
      "force-deploy",
      "issue-uuid",
      "Bearer tok",
      "igor",
      null,
      "u-igor",
      null,
      false,
      false,
      true,
      undefined,
      undefined,
      "Recovered after verified squash merge: https://github.com/fancyfleet/life-os/pull/92 at f01b45cbadd1744a7218cd13bcd04e94a802a4b1.",
    );
    expect(result).toMatch(/workflow:force-deploy/i);
  });
});
