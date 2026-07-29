/**
 * INF-1023 — wf:task code guardrail.
 *
 * AC-to-test mapping:
 *   AC1: Code signals at `wf:task` intake are refused/redirected to `dev-impl`;
 *        they do not enter `routing` on `wf:task`.
 *   AC2: Redirect/refusal is loud: either the ticket lands on `dev-impl` entry
 *        state or a refusal names `dev-impl` as the correct track.
 *   AC3: Non-code Design/media requests still flow through `wf:task` unchanged.
 *   AC4: INF-995 regression: a PR-bearing request never reaches
 *        `wf:task/review`.
 *   AC5: `wf:task` remains Design-scoped; code signals must not be handled by
 *        adding an Engineering-head route inside `wf:task`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "@jest/globals";
import {
  applyBootstrapToIssue,
  referencesCodeChange,
  type BootstrapResult,
  type IssueContext,
} from "./workflow-bootstrap.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const TASK_YAML = `
id: task
version: 2
entry_state: intake
states:
  - id: intake
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: request
        to: routing
        generic: continue
        assign: { mode: auto }
  - id: routing
    owner_role: design-head
    kind: normal
    native_state: todo
    transitions:
      - command: assign
        to: doing
        generic: continue
        assign: { mode: required }
  - id: doing
    owner_role: designer
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: review
        generic: continue
        assign: { mode: auto }
  - id: review
    owner_role: design-head
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: sign-off
        generic: continue
        assign: { mode: auto }
  - id: sign-off
    owner_role: requester
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
`;

const DEV_IMPL_YAML = `
id: dev-impl
version: 17
entry_state: intake
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: write-tests
        capture_ac: true
        assign: { mode: auto }
  - id: write-tests
    owner_role: test-author
    kind: normal
    native_state: todo
    transitions:
      - command: tests-ready
        to: implementation
        assign: { mode: required }
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
        generic: continue
        assign: { mode: required }
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: merge
        generic: continue
  - id: merge
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: merged
        to: deploy
        generic: continue
  - id: deploy
    owner_role: host-deploy
    kind: normal
    native_state: todo
    transitions:
      - command: deployed
        to: ac-validate
        generic: continue
  - id: ac-validate
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: validated
        to: done
        generic: continue
  - id: done
    kind: terminal
    native_state: done
`;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: design
    grants: [linear:transition]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition]

roles:
  - id: requester
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: design-head
    requires: [linear:transition]
  - id: designer
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [linear:transition]
  - id: host-deploy
    requires: [linear:transition]

bodies:
  - id: ai
    container: steward
    fills_roles: [requester]
  - id: laren
    container: design
    fills_roles: [design-head]
  - id: penny
    container: design
    fills_roles: [designer]
  - id: tdd
    container: dev
    fills_roles: [test-author]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: grover
    container: deployment
    fills_roles: [host-deploy]
`;

const AGENTS_JSON = JSON.stringify({
  agents: [
    { name: "ai", linearUserId: "agent-ai-user" },
    { name: "laren", linearUserId: "agent-laren-user" },
    { name: "penny", linearUserId: "agent-penny-user" },
    { name: "tdd", linearUserId: "agent-tdd-user" },
    { name: "igor", linearUserId: "agent-igor-user" },
    { name: "charles", linearUserId: "agent-charles-user" },
    { name: "hanzo", linearUserId: "agent-hanzo-user" },
    { name: "grover", linearUserId: "agent-grover-user" },
  ],
});

const ISSUE_INTERNAL_ID = "issue-internal-inf-1023";
const TEAM_ID = "team-inf-1023";
const WF_TASK_LABEL_ID = "label-wf-task";
const WF_DEV_IMPL_LABEL_ID = "label-wf-dev-impl";
const STATE_INTAKE_LABEL_ID = "label-state-intake";
const STATE_ROUTING_LABEL_ID = "label-state-routing";
const STATE_REVIEW_LABEL_ID = "label-state-review";
const CREATOR_USER_ID = "requester-user";

let tmpDir: string;
let savedFetch: typeof globalThis.fetch;
let capturedBodies: string[];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inf1023-task-code-guardrail-"));
  const defsDir = path.join(tmpDir, "defs");
  await fs.mkdir(defsDir);
  await fs.writeFile(path.join(defsDir, "task.yaml"), TASK_YAML);
  await fs.writeFile(path.join(defsDir, "dev-impl.yaml"), DEV_IMPL_YAML);
  await fs.writeFile(path.join(tmpDir, "policy.yaml"), POLICY_YAML);
  await fs.writeFile(path.join(tmpDir, "agents.json"), AGENTS_JSON);

  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
  process.env.AGENTS_PATH = path.join(tmpDir, "agents.json");
});

afterAll(async () => {
  delete process.env.WORKFLOW_DEFS_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.AGENTS_PATH;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedFetch = globalThis.fetch;
  capturedBodies = [];
  resetWorkflowCache();
  resetPolicyCache();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

function installFetch(): void {
  const teamLabels = [
    { id: WF_TASK_LABEL_ID, name: "wf:task" },
    { id: WF_DEV_IMPL_LABEL_ID, name: "wf:dev-impl" },
    { id: STATE_INTAKE_LABEL_ID, name: "state:intake" },
    { id: STATE_ROUTING_LABEL_ID, name: "state:routing" },
    { id: STATE_REVIEW_LABEL_ID, name: "state:review" },
  ];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    capturedBodies.push(body);

    if (body.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } });
    }
    if (body.includes("labels") && body.includes(TEAM_ID)) {
      return json({ data: { team: { labels: { nodes: teamLabels } } } });
    }
    if (body.includes("issueUpdate") || body.includes("ApplyAtomicTransition")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    return json({ data: {} });
  }) as typeof globalThis.fetch;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTaskIssue(opts: { title?: string; description?: string | null }): IssueContext {
  return {
    id: ISSUE_INTERNAL_ID,
    teamId: TEAM_ID,
    identifier: "INF-995",
    title: opts.title ?? "Design request",
    description: opts.description ?? "",
    creatorId: CREATOR_USER_ID,
    labels: [{ id: WF_TASK_LABEL_ID, name: "wf:task" }],
  };
}

function issueUpdateVariables(): Record<string, unknown> | undefined {
  const raw = capturedBodies.find((b) => b.includes("issueUpdate"));
  if (!raw) return undefined;
  return JSON.parse(raw).variables as Record<string, unknown>;
}

function commentText(): string {
  return capturedBodies
    .filter((b) => b.includes("commentCreate"))
    .map((b) => JSON.stringify(JSON.parse(b).variables ?? {}))
    .join("\n");
}

function expectLoudDevImplRedirectOrRefusal(result: BootstrapResult | null): void {
  const variables = issueUpdateVariables();
  const labelIds = (variables?.labelIds ?? []) as string[];
  const text = `${result?.rejectionReason ?? ""}\n${commentText()}`;

  const landedOnDevImplEntry =
    result?.action === "bootstrapped" &&
    result.workflowId === "dev-impl" &&
    result.entryState === "intake" &&
    labelIds.includes(WF_DEV_IMPL_LABEL_ID) &&
    labelIds.includes(STATE_INTAKE_LABEL_ID) &&
    !labelIds.includes(WF_TASK_LABEL_ID);

  const loudlyRefused =
    result?.action === "rejected" &&
    /dev-impl/i.test(text) &&
    !labelIds.includes(WF_TASK_LABEL_ID) &&
    !labelIds.includes(STATE_ROUTING_LABEL_ID) &&
    !labelIds.includes(STATE_REVIEW_LABEL_ID);

  expect({
    landedOnDevImplEntry,
    loudlyRefused,
    action: result?.action,
    workflowId: result?.workflowId,
    entryState: result?.entryState,
    labelIds,
    commentOrReason: text,
  }).toMatchObject({
    landedOnDevImplEntry: expect.any(Boolean),
    loudlyRefused: expect.any(Boolean),
  });
  expect(landedOnDevImplEntry || loudlyRefused).toBe(true);
}

describe("INF-1023 AC1/AC2/AC5: code-signaled wf:task intake is redirected or refused", () => {
  it.each([
    [
      "PR link",
      "Connector fix",
      "Implementation is already up at https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/512.",
    ],
    [
      "diff",
      "Apply bootstrap patch",
      "diff --git a/src/workflow-bootstrap.ts b/src/workflow-bootstrap.ts\n+guard wf:task code intake",
    ],
    [
      "repo/source path",
      "Fix connector source",
      "Please update fancyfleet/fancy-openclaw-linear-connector src/workflow-bootstrap.ts.",
    ],
    [
      "explicit engineering-domain marker",
      "Backend workflow fix",
      "engineering-domain: backend\nimplementer: igor\nNeeds connector code changes.",
    ],
  ])("AC1/AC2/AC5: %s signal never bootstraps as wf:task or routes to an Engineering head inside task", async (_signal, title, description) => {
    const result = await applyBootstrapToIssue(makeTaskIssue({ title, description }), "test-token");

    expectLoudDevImplRedirectOrRefusal(result);
  });
});

describe("INF-1023 AC3: non-code Design/media requests still use wf:task unchanged", () => {
  it("bootstraps an ordinary Design request at wf:task intake with no dev-impl refusal", async () => {
    const result = await applyBootstrapToIssue(
      makeTaskIssue({
        title: "Design social launch images",
        description: "Create three composited media concepts for the launch announcement.",
      }),
      "test-token",
    );

    expect(result).toMatchObject({
      action: "bootstrapped",
      workflowId: "task",
      entryState: "intake",
      delegateAgentName: "ai",
    });
    expect(commentText()).toBe("");
    expect(issueUpdateVariables()).toMatchObject({
      labelIds: expect.arrayContaining([WF_TASK_LABEL_ID, STATE_INTAKE_LABEL_ID]),
      delegateId: "agent-ai-user",
    });
  });
});

describe("INF-1023 AC4: INF-995 PR-bearing shape never reaches wf:task/review", () => {
  it("refuses or redirects a PR-bearing task intake before it can become wf:task/review", async () => {
    const result = await applyBootstrapToIssue(
      makeTaskIssue({
        title: "Review connector PR",
        description: "INF-995 shape: PR #512 is ready for review.",
      }),
      "test-token",
    );
    const labelIds = ((issueUpdateVariables()?.labelIds ?? []) as string[]);

    expectLoudDevImplRedirectOrRefusal(result);
    expect(result?.workflowId).not.toBe("task");
    expect(labelIds).not.toContain(STATE_REVIEW_LABEL_ID);
  });
});

describe("INF-1023 code-signal classifier coverage", () => {
  it.each([
    ["PR link", "see https://github.com/fancyfleet/fancy-openclaw-linear-connector/pull/512"],
    ["diff", "diff --git a/src/workflow-bootstrap.ts b/src/workflow-bootstrap.ts"],
    ["repo/source path", "fancyfleet/fancy-openclaw-linear-connector src/workflow-bootstrap.ts"],
    ["explicit engineering-domain marker", "engineering-domain: backend"],
  ])("AC1 signal detector recognizes %s as code", (_signal, text) => {
    expect(referencesCodeChange("Task request", text)).toBe(true);
  });

  it("AC3 signal detector does not flag ordinary design/media wording", () => {
    expect(
      referencesCodeChange(
        "Design social launch images",
        "Create three composited media concepts for the launch announcement.",
      ),
    ).toBe(false);
  });
});
