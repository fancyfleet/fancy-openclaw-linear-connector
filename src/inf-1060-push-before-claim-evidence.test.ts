/**
 * INF-1060 — push-before-claim evidence on dev-impl submit.
 *
 * Scope: synchronous validation on the claim-of-implementation transition.
 * The submit path out of active implementation work must not advance a ticket
 * toward code-review unless the caller supplies a branch + commit SHA and the
 * connector verifies that commit is reachable from that branch on origin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { handleProxyRequest } from "./proxy.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { clearAppliedState } from "./store/applied-state-store.js";
import {
  _setTransitionWritePolicyForTests,
  applyStateTransition,
  resetWorkflowCache,
  type ApplyStateTransitionOptions,
} from "./workflow-gate.js";

const ISSUE_UUID = "issue-inf-1060";
const ISSUE_IDENTIFIER = "INF-1060";
const TEAM_ID = "team-ai";
const IGOR_LINEAR_ID = "user-igor";
const CHARLES_LINEAR_ID = "user-charles";
const VALID_BRANCH = "feature/INF-1060-push-before-claim-evidence";
const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";
const MISSING_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTH = "Bearer tok-igor";
const ORIGIN_REPO = "fancyfleet/fancy-openclaw-linear-connector";

const POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
roles:
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
bodies:
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
`;

const DEV_IMPL_YAML = `
id: dev-impl
version: 18
entry_state: implementation
states:
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign:
          mode: required
          constraint: not-implementer
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions: []
  - id: merge
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions: []
  - id: deploy
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions: []
`;

type GraphqlCall = {
  query: string;
  variables?: Record<string, unknown>;
};

type CodeArtifactOptions = ApplyStateTransitionOptions & {
  /** Same user-facing shape as X-Openclaw-Code-Artifact: <branch>@<sha>. */
  codeArtifact?: string | null;
  /** Repository whose origin branch must contain the supplied commit. */
  originRepository?: string | null;
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function writeConfig(dir: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  fs.writeFileSync(path.join(dir, "dev-impl.yaml"), DEV_IMPL_YAML, "utf8");
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        {
          name: "igor",
          linearUserId: IGOR_LINEAR_ID,
          openclawAgent: "igor",
          accessToken: "tok-igor",
          host: "local",
        },
        {
          name: "charles",
          linearUserId: CHARLES_LINEAR_ID,
          openclawAgent: "charles",
          accessToken: "tok-charles",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
}

function makeFetch(reachableShas = new Set<string>()) {
  const calls: GraphqlCall[] = [];
  const originChecks: string[] = [];
  let applied = false;

  const fetch = (async (url: unknown, init?: RequestInit) => {
    const urlText = String(url);

    if (!urlText.includes("api.linear.app")) {
      originChecks.push(urlText);
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const requestText = `${urlText}\n${bodyText}`;
      const branchNamed = requestText.includes(VALID_BRANCH);
      const sha = [...reachableShas].find((candidate) => requestText.includes(candidate));
      return jsonResponse({ ok: Boolean(branchNamed && sha), reachable: Boolean(branchNamed && sha) });
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphqlCall;
    calls.push(parsed);
    const query = parsed.query ?? "";

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            team: { id: TEAM_ID, key: "AI", name: "AI" },
            labels: {
              nodes: [
                { id: "label-wf-dev-impl", name: "wf:dev-impl", team: { id: TEAM_ID } },
                { id: "label-state-implementation", name: "state:implementation", team: { id: TEAM_ID } },
                { id: "label-repo-connector", name: "repo:fancy-openclaw-linear-connector", team: { id: TEAM_ID } },
              ],
            },
            delegate: { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }

    if (query.includes("IssueContext")) {
      return jsonResponse({
        data: {
          issue: {
            identifier: ISSUE_IDENTIFIER,
            labels: {
              nodes: [
                { name: "wf:dev-impl" },
                { name: "state:implementation" },
                { name: "repo:fancy-openclaw-linear-connector" },
              ],
            },
            delegate: { id: IGOR_LINEAR_ID },
            state: { type: "started", name: "Doing" },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({
        data: {
          team: {
            labels: {
              nodes: [
                { id: "label-wf-dev-impl", name: "wf:dev-impl" },
                { id: "label-state-implementation", name: "state:implementation" },
                { id: "label-state-code-review", name: "state:code-review" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("TeamStates")) {
      return jsonResponse({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-todo", name: "To Do", type: "unstarted" },
                { id: "state-doing", name: "Doing", type: "started" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("IssueRepoAttachments")) {
      return jsonResponse({ data: { issue: { attachments: { nodes: [] } } } });
    }

    if (query.includes("ApplyAtomicTransition")) {
      applied = true;
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    if (query.includes("VerifyTransitionWrite")) {
      return jsonResponse({
        data: {
          issue: {
            labels: {
              nodes: [
                { name: "wf:dev-impl" },
                { name: applied ? "state:code-review" : "state:implementation" },
              ],
            },
            delegate: applied ? { id: CHARLES_LINEAR_ID } : { id: IGOR_LINEAR_ID },
            assignee: null,
            state: { id: "state-todo" },
          },
        },
      });
    }

    return jsonResponse({ data: {} });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    originChecks,
    transitionWrites: () => calls.filter((call) => (call.query ?? "").includes("ApplyAtomicTransition")),
  };
}

function submitOptions(overrides: Partial<CodeArtifactOptions> = {}): CodeArtifactOptions {
  return {
    bodyId: "igor",
    cliTarget: "charles",
    sourceStateOverride: "implementation",
    originRepository: ORIGIN_REPO,
    ...overrides,
  };
}

function createProxyApp(): express.Application {
  const app = express();
  app.use(
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        try {
          req.body = JSON.parse(req.body.toString("utf8"));
        } catch {
          // Leave malformed JSON to the proxy parser.
        }
      }
      next();
    },
  );
  app.post("/proxy/graphql", async (req, res) => {
    await handleProxyRequest(req, res);
  });
  return app;
}

function submitMutationBody(): Record<string, unknown> {
  return {
    operationName: "SubmitImplementationClaim",
    query: `
      mutation SubmitImplementationClaim($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }
    `,
    variables: {
      id: ISSUE_UUID,
      input: { description: "Implementation claim" },
    },
  };
}

function postSubmit(app: express.Application, codeArtifact?: string) {
  let req = request(app)
    .post("/proxy/graphql")
    .set("Content-Type", "application/json")
    .set("Authorization", AUTH)
    .set("X-Openclaw-Agent", "igor")
    .set("X-Openclaw-Linear-Intent", "submit")
    .set("X-Openclaw-Linear-Target", "charles")
    .set("X-Openclaw-Linear-Cli-Version", "999.0.0")
    .send(JSON.stringify(submitMutationBody()));
  if (codeArtifact) req = req.set("X-Openclaw-Code-Artifact", codeArtifact);
  return req;
}

describe("INF-1060 push-before-claim evidence gate", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1060-push-before-claim-"));
    for (const key of [
      "AGENTS_FILE",
      "CAPABILITY_POLICY_PATH",
      "WORKFLOW_DEF_PATH",
      "WORKFLOW_DEFS_DIR",
      "ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT",
      "WORKFLOW_DEF_STATE_SNAPSHOT_PATH",
    ]) {
      savedEnv[key] = process.env[key];
    }
    writeConfig(dir);
    process.env.AGENTS_FILE = path.join(dir, "agents.json");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = path.join(dir, "workflow-def-state-snapshot.json");
    process.env.ALLOW_WORKFLOW_DEF_FIXTURE_DRIFT = "1";
    delete process.env.WORKFLOW_DEFS_DIR;
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 0 });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    clearAppliedState(ISSUE_IDENTIFIER);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC1 + AC4: submit from implementation without branch+commit evidence is refused before state advances and names push-before-claim", async () => {
    const transport = makeFetch();
    globalThis.fetch = transport.fetch;

    const result = await applyStateTransition("submit", ISSUE_UUID, AUTH, submitOptions({ codeArtifact: null }));

    expect(result.status).toBe("blocked");
    expect(result.code).toBe("push-before-claim");
    expect(result.detail).toMatch(/push-before-claim/i);
    expect(result.detail).toMatch(/push/i);
    expect(result.detail).toMatch(/branch/i);
    expect(result.detail).toMatch(/commit|sha/i);
    expect(transport.transitionWrites()).toHaveLength(0);
  });

  it("AC2 + AC4: supplied branch+commit evidence is refused when the commit is not reachable on origin", async () => {
    const transport = makeFetch(new Set([VALID_SHA]));
    globalThis.fetch = transport.fetch;

    const result = await applyStateTransition(
      "submit",
      ISSUE_UUID,
      AUTH,
      submitOptions({ codeArtifact: `${VALID_BRANCH}@${MISSING_SHA}` }),
    );

    expect(result.status).toBe("blocked");
    expect(result.code).toBe("push-before-claim");
    expect(result.detail).toMatch(/push-before-claim/i);
    expect(result.detail).toMatch(/not.*origin|origin.*not|unreachable|unpushed/i);
    expect(result.detail).toContain(VALID_BRANCH);
    expect(result.detail).toContain(MISSING_SHA);
    expect(transport.originChecks).toHaveLength(1);
    expect(transport.transitionWrites()).toHaveLength(0);
  });

  it("AC3: stale-recovered repeated submit claims without origin-reachable evidence are refused every time", async () => {
    const transport = makeFetch();
    globalThis.fetch = transport.fetch;

    const attempts = [];
    for (let i = 0; i < 3; i += 1) {
      attempts.push(await applyStateTransition("submit", ISSUE_UUID, AUTH, submitOptions()));
    }

    expect(attempts).toHaveLength(3);
    for (const result of attempts) {
      expect(result).toMatchObject({ status: "blocked", code: "push-before-claim" });
      expect(result.detail).toMatch(/push-before-claim/i);
    }
    expect(transport.transitionWrites()).toHaveLength(0);
  });

  it("AC5: submit with a branch pushed to origin and reachable commit advances unchanged to code-review", async () => {
    const transport = makeFetch(new Set([VALID_SHA]));
    globalThis.fetch = transport.fetch;

    const result = await applyStateTransition(
      "submit",
      ISSUE_UUID,
      AUTH,
      submitOptions({ codeArtifact: `${VALID_BRANCH}@${VALID_SHA}` }),
    );

    expect(result).toMatchObject({
      status: "applied",
      from: "implementation",
      to: "code-review",
    });
    expect(transport.originChecks).toHaveLength(1);
    const [write] = transport.transitionWrites();
    expect(write?.variables).toMatchObject({
      delegateId: CHARLES_LINEAR_ID,
      labelIds: expect.arrayContaining(["label-wf-dev-impl", "label-state-code-review"]),
    });
  });

  it("proxy path: live submit without artifact is refused before the atomic state transition write", async () => {
    const transport = makeFetch();
    globalThis.fetch = transport.fetch;
    const app = createProxyApp();

    const res = await postSubmit(app);

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "blocked",
      code: "push-before-claim",
      from: "implementation",
      to: "code-review",
    });
    expect(res.body._workflowTransition.detail).toMatch(/push-before-claim/i);
    expect(res.body._workflowTransition.detail).toMatch(/push/i);
    expect(transport.transitionWrites()).toHaveLength(0);
  });

  it("proxy path: live submit with a reachable artifact advances through the normal code-review path", async () => {
    const transport = makeFetch(new Set([VALID_SHA]));
    globalThis.fetch = transport.fetch;
    const app = createProxyApp();

    const res = await postSubmit(app, `${VALID_BRANCH}@${VALID_SHA}`);

    expect(res.status).toBe(200);
    expect(res.body._workflowTransition).toMatchObject({
      status: "applied",
      from: "implementation",
      to: "code-review",
    });
    expect(transport.originChecks).toHaveLength(1);
    expect(transport.transitionWrites()).toHaveLength(1);
  });
});
