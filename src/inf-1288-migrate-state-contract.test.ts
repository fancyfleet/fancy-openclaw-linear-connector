/**
 * INF-1288 — migrate-state steward verb: contract + delegate-seat fixes.
 *
 * Post-INF-1268 the migrate-state path routed through setStateAtomic and returned
 * `{ data: { migrateState: {...} } }`. That introduced three live defects that
 * forced Astrid's "manual-kick" recipe (bare state name, ignore the client error,
 * observe, then handoff-work to repair delegate drift):
 *
 *   Bug A — misleading client error. The CLI routes migrate-state through
 *     executeTransition → updateIssue, which reads `data.issueUpdate.success` /
 *     `data.issueUpdate.issue.id`. The `migrateState`-only response shape left
 *     `data.issueUpdate` undefined, so the CLI threw `Cannot read properties of
 *     undefined (reading 'success')` even though the write had already landed
 *     server-side. Fix: return the issueUpdate-shaped payload (with the migrate
 *     metadata carried alongside under `migrateState`).
 *
 *   Bug B — `state:<name>` target rejected. Def state ids are bare (`ac-validate`);
 *     a steward naturally passes the label form `state:ac-validate`. The proxy did
 *     no prefix normalization, so every `state:<name>` target was rejected as
 *     "not in live def". Fix: strip a single leading `state:` before validation.
 *
 *   Bug C — delegate drift. migrate-state called setStateAtomic with delegate
 *     undefined, so the atomic write never touched the Linear delegate; the
 *     `redispatched=<owner>` log was only the wake, and the ticket stayed delegated
 *     to the prior body. Fix: seatOwnerRoleDelegate seats the destination
 *     owner_role's singleton body in the same atomic write.
 *
 * These tests exercise the real proxy (`POST /proxy/graphql`).
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// astrid = steward (workflow:break-glass) AND the singleton body for the
// ac-validate owner_role (steward) — so a migrate to ac-validate should seat her.
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
roles:
  - id: steward
    requires: [workflow:break-glass]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

// dev-impl def where ac-validate's owner_role is steward (singleton: astrid).
const WORKFLOW_YAML = `
id: dev-impl
version: 14
entry_state: intake
break_glass:
  command: escape
  to: escape
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
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: merge
    owner_role: steward
    native_state: doing
    transitions:
      - command: continue
        to: deploy
        generic: continue
  - id: deploy
    owner_role: steward
    native_state: doing
    transitions:
      - command: continue
        to: ac-validate
        generic: continue
  - id: ac-validate
    owner_role: steward
    native_state: doing
    transitions:
      - command: validated
        to: done
  - id: done
    native_state: done
    transitions: []
  - id: escape
    native_state: invalid
    transitions: []
`;

// Ticket stranded at state:deployment (defunct), currently delegated to a PRIOR
// body (user-igor) — the drift case. A migrate to ac-validate should re-seat to
// the owner_role singleton (astrid).
const DEFUNCT_ISSUE_WITH_LABELS = {
  data: {
    issue: {
      id: "issue-1288",
      identifier: "INF-1288",
      creator: { id: "user-matt" },
      title: "Stranded ticket",
      description: "",
      team: { id: "team-1", key: "INF", name: "Infra" },
      labels: {
        nodes: [
          { id: "lbl-wf", name: "wf:dev-impl", team: { id: "team-1" } },
          { id: "lbl-deployment", name: "state:deployment", team: { id: "team-1" } },
        ],
      },
      delegate: { id: "user-igor" },
      assignee: null,
      state: { id: "native-doing", name: "In Progress", type: "started" },
    },
  },
};

const MIGRATED_ISSUE_WITH_LABELS = {
  data: {
    issue: {
      ...DEFUNCT_ISSUE_WITH_LABELS.data.issue,
      labels: {
        nodes: [
          { id: "lbl-wf", name: "wf:dev-impl", team: { id: "team-1" } },
          { id: "lbl-acvalidate", name: "state:ac-validate", team: { id: "team-1" } },
        ],
      },
      delegate: { id: "user-astrid" },
    },
  },
};

const MIGRATE_MUTATION = {
  query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
  variables: { id: "issue-1288" },
};

let dir: string;
let appState: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;
let lastUpdateDelegateId: string | null | undefined;
let updateSawDelegateField = false;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1288-migrate-"));
  lastUpdateDelegateId = undefined;
  updateSawDelegateField = false;

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "igor", linearUserId: "user-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const defFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(defFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = defFile;
  delete process.env.WORKFLOW_DEFS_DIR;

  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();

  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
  });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.managingPoller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_FILE;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
});

function makeFetch(): typeof globalThis.fetch {
  let writeLanded = false;
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url as never, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> }) : {};

    if (parsed.query?.includes("IssueWithLabels")) {
      const shape = writeLanded ? MIGRATED_ISSUE_WITH_LABELS : DEFUNCT_ISSUE_WITH_LABELS;
      return new Response(JSON.stringify(shape), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // fetchWorkflowLabels (the proxy's migrate-state def-resolution read) uses the
    // IssueLabels query — return the wf: + state: labels so getWorkflowId resolves.
    if (parsed.query?.includes("IssueLabels")) {
      const src = (writeLanded ? MIGRATED_ISSUE_WITH_LABELS : DEFUNCT_ISSUE_WITH_LABELS).data.issue;
      return new Response(
        JSON.stringify({ data: { issue: { labels: { nodes: src.labels.nodes.map((l) => ({ name: l.name })) } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.query?.includes("VerifyTransitionWrite") || parsed.query?.includes("PreAuthWriteCheck")) {
      const src = (writeLanded ? MIGRATED_ISSUE_WITH_LABELS : DEFUNCT_ISSUE_WITH_LABELS).data.issue;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: src.labels.nodes.map((l) => ({ name: l.name })) },
              delegate: src.delegate ? { id: src.delegate.id } : null,
              assignee: null,
              state: src.state,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.query?.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "lbl-wf", name: "wf:dev-impl", isGroup: false, team: { id: "team-1" }, parent: null },
                  { id: "lbl-deployment", name: "state:deployment", isGroup: false, team: { id: "team-1" }, parent: null },
                  { id: "lbl-acvalidate", name: "state:ac-validate", isGroup: false, team: { id: "team-1" }, parent: null },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.query?.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "native-todo", name: "Todo", type: "unstarted" },
                  { id: "native-doing", name: "In Progress", type: "started" },
                  { id: "native-done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // The atomic issueUpdate mutation — capture the delegate facet so the test can
    // assert the owner_role body was seated, then mark the write landed.
    if (parsed.query?.includes("issueUpdate")) {
      writeLanded = true;
      // issueUpdateAtomic passes delegateId as a TOP-LEVEL mutation variable
      // (variables.delegateId), not nested under input — read it there.
      const vars = (parsed.variables ?? {}) as Record<string, unknown>;
      if ("delegateId" in vars) {
        updateSawDelegateField = true;
        lastUpdateDelegateId = (vars.delegateId as string | null | undefined) ?? null;
      }
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

function postMigrate(target: string, headerName = "X-Openclaw-Migrate-Target") {
  return request(appState.app)
    .post("/proxy/graphql")
    .set("Authorization", "Bearer tok-astrid")
    .set("X-Openclaw-Agent", "astrid")
    .set("X-Openclaw-Linear-Intent", "migrate-state")
    .set(headerName, target)
    .send(MIGRATE_MUTATION);
}

describe("INF-1288 Bug B: state:-prefixed target is normalized", () => {
  it("accepts the label form `state:ac-validate` and migrates (not rejected as not-in-live-def)", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrate("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
  });

  it("still rejects a genuinely unknown state even with a state: prefix", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrate("state:no-such-state");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/not a state in the live workflow def/i);
  });
});

describe("INF-1288 Bug A: success response is issueUpdate-shaped (CLI does not crash)", () => {
  it("returns data.issueUpdate.success + issue.id so updateIssue parses cleanly", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrate("ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The shape the CLI's updateIssue reads: data.issueUpdate.success + .issue.id.
    expect(res.body.data?.issueUpdate?.success).toBe(true);
    expect(res.body.data?.issueUpdate?.issue?.id).toBe("issue-1288");
    // Migrate metadata is preserved alongside for any caller that wants it.
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
  });
});

describe("INF-1288 Bug C: forward migration seats the owner_role delegate atomically", () => {
  it("writes the destination owner_role singleton (astrid) as the Linear delegate", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrate("ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The atomic write must carry the delegate facet, seated to the owner_role body
    // (astrid), not left on the prior body (igor) — the drift that forced handoff-work.
    expect(updateSawDelegateField).toBe(true);
    expect(lastUpdateDelegateId).toBe("user-astrid");
  });
});
