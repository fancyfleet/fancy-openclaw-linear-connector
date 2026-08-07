/**
 * INF-1303 — migrate-state residual client-error + delegate-repair residue.
 *
 * After INF-1288 was treated as retired, engine-watch still observed two residue
 * shapes in the steward environment (2026-08-07 04:04Z):
 *
 *   R1 (AC1/AC2): `migrate-state` STILL printed the old client-side
 *     `success`/undefined error. INF-1288 fixed the no-comment path: the CLI's
 *     `migrateState` → `executeTransition("migrate-state", { omitStateId: true })`
 *     with NO comment has `commentTriggersProxy === false`, so step 9 runs
 *     `updateIssue` and reads `data.issueUpdate.success` — the shape INF-1288
 *     returned. BUT the steward commonly passes `--comment` (the CLI command's
 *     documented option). Then `commentTriggersProxy === true`: the CLI posts the
 *     comment FIRST via `addComment` (a `commentCreate` mutation), the proxy's
 *     migrate-state branch intercepts THAT request, and the proxy returns an
 *     `issueUpdate`-shaped envelope — which has no `commentCreate` field. The CLI's
 *     `addComment` reads `data.commentCreate.success` → throws
 *     `Cannot read properties of undefined (reading 'success')` — the exact old
 *     client error — AFTER the server-side write already applied. The CLI exits
 *     non-zero; step 10/11 verification never runs; the steward sees a crash.
 *
 *   R2 (AC3): because the CLI crashed, the steward ran the old manual repair
 *     (observe → handoff-work) even though setStateAtomic had already seated the
 *     target owner_role delegate atomically — the needless delegate-repair residue.
 *
 *   R3 (AC4/INF-1277 shape): the migrate-state branch returns before the normal
 *     transition path, so it never emits a transition-audit record — a migrate
 *     is invisible in the INF-1277 ledger, so workflow recovery cannot see the
 *     write applied and still demands repair.
 *
 *   R4 (truthful envelope): the proxy intercepts the steward's commentCreate and
 *     never forwards the steward's comment text to Linear (only its own audit
 *     receipt comment is posted). A success envelope for a commentCreate must
 *     not lie: the steward's comment must actually land, and the returned
 *     comment payload must be the real posted comment.
 *
 * These tests exercise the real proxy (`POST /proxy/graphql`) with a
 * commentCreate body — the exact recurrence shape — and assert:
 *   - AC1: the commentCreate request receives a commentCreate-shaped success
 *     envelope (no undefined-read on the deployed CLI),
 *   - AC2: the migrateState metadata is preserved alongside,
 *   - AC3: the atomic write seats the destination owner_role delegate (no
 *     follow-up handoff-work needed),
 *   - AC4: a transition-audit record is persisted for the migrate (ledger
 *     visibility for workflow recovery),
 *   - AC5: deterministic integration fixture (real createApp HTTP layer) proving
 *     the whole path, including the steward's comment text actually landing on
 *     Linear (no dropped comment beside a "success").
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
import { TransitionAuditStore } from "./store/transition-audit-store.js";

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
      id: "issue-1303",
      identifier: "INF-1303",
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

// The commentCreate body — the CLI's comment-first path. The steward ran
// `linear migrate-state INF-1303 --target state:ac-validate --comment "..."`
// which posts the comment FIRST (commentTriggersProxy), carrying the intent.
const COMMENT_CREATE_MUTATION = {
  query:
    "mutation AddComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body createdAt url } } }",
  variables: { issueId: "issue-1303", body: "Migrating to ac-validate" },
};

// The no-comment path (issueUpdate trigger) — the shape INF-1288 already covers,
// kept here to pin the contrast: both bodies must yield a clean client parse.
const ISSUE_UPDATE_MUTATION = {
  query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
  variables: { id: "issue-1303" },
};

let dir: string;
let appState: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;
let auditDbPath: string;
let lastUpdateDelegateId: string | null | undefined;
let updateSawDelegateField = false;
let postedCommentBodies: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1303-migrate-"));
  lastUpdateDelegateId = undefined;
  updateSawDelegateField = false;
  postedCommentBodies = [];
  auditDbPath = path.join(dir, "audit.db");

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
    transitionAuditDbPath: auditDbPath,
  });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.transitionAuditStore.close();
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
    if (parsed.query?.includes("commentCreate")) {
      // Comments the proxy forwards/delivers to Linear (the steward's comment and
      // the proxy's own audit receipt). Capture the body text so the test can
      // prove the steward's comment actually landed — a success envelope must not
      // lie about a dropped comment.
      const vars = (parsed.variables ?? {}) as Record<string, unknown>;
      const bodyText =
        (typeof vars.body === "string" && vars.body) ||
        (vars.input && typeof vars.input === "object" && (vars.input as Record<string, unknown>).body as string) ||
        "";
      postedCommentBodies.push(bodyText);
      const id = `c-${postedCommentBodies.length}`;
      return new Response(
        JSON.stringify({
          data: { commentCreate: { success: true, comment: { id, body: bodyText, createdAt: "2026-08-07T04:04:00Z", url: `https://linear.app/fancymatt/issue/INF-1303#${id}` } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.query?.includes("issueUpdate")) {
      writeLanded = true;
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

function postMigrateCommentFirst(target: string) {
  return request(appState.app)
    .post("/proxy/graphql")
    .set("Authorization", "Bearer tok-astrid")
    .set("X-Openclaw-Agent", "astrid")
    .set("X-Openclaw-Linear-Intent", "migrate-state")
    .set("X-Openclaw-Migrate-Target", target)
    .send(COMMENT_CREATE_MUTATION);
}

function postMigrateUpdate(target: string) {
  return request(appState.app)
    .post("/proxy/graphql")
    .set("Authorization", "Bearer tok-astrid")
    .set("X-Openclaw-Agent", "astrid")
    .set("X-Openclaw-Linear-Intent", "migrate-state")
    .set("X-Openclaw-Migrate-Target", target)
    .send(ISSUE_UPDATE_MUTATION);
}

describe("INF-1303 R1 (AC1/AC2): comment-carried migrate-state returns a commentCreate-shaped envelope", () => {
  it("comment-first steward migrate (`--comment`) does NOT return the issueUpdate-only shape the CLI's addComment cannot parse", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateCommentFirst("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The CLI's addComment reads `data.commentCreate.success` — the envelope must
    // carry it. The INF-1288 issueUpdate-only shape left this undefined and the
    // deployed CLI threw `Cannot read properties of undefined (reading 'success')`
    // even though the server-side write had already applied — the 04:04Z recurrence.
    expect(res.body.data?.commentCreate?.success).toBe(true);
  });

  it("preserves the migrateState metadata alongside the commentCreate envelope (AC2)", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateCommentFirst("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.commentCreate?.success).toBe(true);
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
    expect(res.body.data?.migrateState?.success).toBe(true);
  });

  it("still works for the no-comment issueUpdate trigger (INF-1288 regression guard)", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateUpdate("ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.issueUpdate?.success).toBe(true);
    expect(res.body.data?.issueUpdate?.issue?.id).toBe("issue-1303");
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
  });
});

describe("INF-1303 R2 (AC3): comment-carried migrate seats the owner_role delegate atomically", () => {
  it("seats astrid (ac-validate owner_role singleton) as delegate in the atomic write — no handoff-work", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateCommentFirst("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The atomic issueUpdate must carry the delegate facet, seated to the owner_role
    // body (astrid), not left on the prior body (igor).
    expect(updateSawDelegateField).toBe(true);
    expect(lastUpdateDelegateId).toBe("user-astrid");
  });
});

describe("INF-1303 R4 (AC5): the steward's comment actually lands on Linear (truthful envelope)", () => {
  it("forwards the steward's commentCreate body to Linear beside the migrate write", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateCommentFirst("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.commentCreate?.success).toBe(true);
    // The steward's comment text must be among the delivered comments — the proxy
    // must not swallow the intercepted commentCreate and reply "success" for a
    // comment that never landed.
    expect(postedCommentBodies.some((b) => b.includes("Migrating to ac-validate"))).toBe(true);
    // The returned comment payload must be the real posted comment, not a stub.
    expect(res.body.data?.commentCreate?.comment?.id).toMatch(/^c-/);
  });
});

describe("INF-1303 R3 (AC4): migrate-state is visible in the transition-audit ledger (INF-1277 shape)", () => {
  it("persists a transition-audit record for the migrate so workflow recovery can see the write applied", async () => {
    globalThis.fetch = makeFetch();
    const res = await postMigrateCommentFirst("state:ac-validate");
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();

    // The INF-1277 ledger must contain the migrate — recovery tooling reads this
    // to decide whether a delegate repair is needed. Today the migrate-state
    // branch returns before the normal audit path, so this record is absent.
    const reopened = new TransitionAuditStore(auditDbPath);
    try {
      const records = reopened.query({ ticket: "issue-1303" });
      const migrate = records.find((r) => r.intent === "migrate-state");
      expect(migrate).toBeDefined();
      expect(migrate!.fromState).toBe("deployment");
      expect(migrate!.toState).toBe("ac-validate");
      expect(migrate!.status).toBe("applied");
    } finally {
      reopened.close();
    }
  });
});
