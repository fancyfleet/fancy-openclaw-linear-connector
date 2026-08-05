/**
 * INF-1273 — Fix 6 silenced `.catch(() => {})` sites: surface comment-posting
 * (and other best-effort) failures instead of discarding them.
 *
 * AC (verbatim, captured at intake):
 *   - Each of the 6 sites logs the caught error (module logger, with enough
 *     context to identify which operation/ticket failed) instead of
 *     discarding it silently.
 *   - For the two `postLinearComment` sites (stale-plain-delegate-sweep.ts),
 *     confirm (or add) that a logged failure is visible in whatever
 *     telemetry/log aggregation the fleet already uses for this file's other
 *     errors — no new alerting pipeline needs to be built.
 *   - No behavior change to control flow — these remain best-effort/
 *     non-blocking operations; only the error visibility changes.
 *   - Full test suite passes.
 *
 * Sites covered (5 of 6 — see note on the 6th below):
 *   1. proposal/apply-pipeline.ts:154  — atomicWrite's temp-file cleanup
 *      (`fs.rm(tmp, ...).catch(() => {})`) after a rename failure.
 *   2. stale-plain-delegate-sweep.ts:365 — postLinearComment on re-dispatch.
 *   3. stale-plain-delegate-sweep.ts:330 — postLinearComment on escalation.
 *   4. admin.ts:1421 — POST /api/set-state audit-comment fetch.
 *   5. admin.ts:1490 — POST /api/recapture-ac audit-comment fetch.
 *
 * NOT independently testable — flagged, not silently dropped:
 *   apply-pipeline.ts:173 (`withKeyLock`'s `_applyLocks.get(key)!.catch(() =>
 *   {})`). The awaited promise (`held`, apply-pipeline.ts:176) is constructed
 *   as `new Promise((resolve) => (release = resolve))` and is only ever
 *   resolved (in the `finally` block) — never rejected — so this catch
 *   handler is structurally unreachable under the current lock design; no
 *   black-box test can drive an error into it. Flagging for the implementer
 *   (Igor): either add defensive logging there (untestable, but harmless)
 *   or simplify by removing the dead `.catch()`. Escalate to Ai if neither
 *   reading is acceptable.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import request from "supertest";

// ═══════════════════════════════════════════════════════════════════════════
// Site 1 — proposal/apply-pipeline.ts:154
// ═══════════════════════════════════════════════════════════════════════════

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function idempotencyKey(targets: Array<{ path: string; diff: string }>): string {
  const sorted = [...targets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256hex(sorted.map((t) => sha256hex(t.path) + sha256hex(t.diff)).join(""));
}

const DEV_IMPL_YAML_V3 = `id: dev-impl
version: 3
entry_state: intake
states:
  - id: write-tests
    owner_role: test-author
  - id: implementation
    owner_role: dev
`;

const GUIDANCE_V1 = `# Step: write-tests

Write failing tests covering all in-scope AC.
`;

interface Rig {
  root: string;
  yamlPath: string;
  yamlRel: string;
  guidancePath: string;
  guidanceRel: string;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inf1273-apply-"));
  const yamlRel = path.join("workflows", "dev-impl.yaml");
  const guidanceRel = path.join("workflows", "dev-impl", "write-tests.md");
  const yamlPath = path.join(root, yamlRel);
  const guidancePath = path.join(root, guidanceRel);
  fs.mkdirSync(path.dirname(guidancePath), { recursive: true });
  fs.writeFileSync(yamlPath, DEV_IMPL_YAML_V3, "utf8");
  fs.writeFileSync(guidancePath, GUIDANCE_V1, "utf8");

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "tdd@fancymatt.local"]);
  git(root, ["config", "user.name", "tdd"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "seed instance config"]);

  return { root, yamlPath, yamlRel, guidancePath, guidanceRel };
}

function makeStore() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    getByIdempotencyKey: (key: string) => rows.get(key) ?? null,
    record: (rec: { idempotencyKey: string }) => {
      rows.set(rec.idempotencyKey, rec);
    },
  };
}

function makeGuidanceProposal(rig: Rig, newContent: string) {
  const snapshot = fs.readFileSync(rig.guidancePath, "utf8");
  const diff = `--- a/${rig.guidanceRel}\n+++ b/${rig.guidanceRel}\n@@\n-${snapshot}\n+${newContent}\n`;
  const targets = [
    {
      kind: "guidance" as const,
      path: rig.guidanceRel,
      oldContent: { hash: sha256hex(snapshot), snapshot },
      newContent,
      diff,
    },
  ];
  return { id: "prop-inf1273-1", idempotencyKey: idempotencyKey(targets), targets };
}

function baseDeps(rig: Rig, store: ReturnType<typeof makeStore>) {
  return {
    configRoot: rig.root,
    store,
    captureMetrics: () => ({ snapshot: {}, window: { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" } }),
    reloadWorkflowDefs: jest.fn(),
    now: () => 1_752_100_000_000,
  };
}

describe("INF-1273 — apply-pipeline.ts:154 (atomicWrite temp-file cleanup on rename failure)", () => {
  let rig: Rig | undefined;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn> | undefined;

  afterEach(() => {
    jest.restoreAllMocks();
    consoleErrorSpy = undefined;
    if (rig) {
      fs.rmSync(rig.root, { recursive: true, force: true });
      rig = undefined;
    }
  });

  it("logs the swallowed rm() cleanup failure instead of dropping it, without changing the apply-failed outcome", async () => {
    const { applyProposal } = await import("./proposal/apply-pipeline.js");
    rig = makeRig();
    const store = makeStore();
    const proposal = makeGuidanceProposal(rig, GUIDANCE_V1 + "\ninf-1273\n");

    const injectedRmError = "INF-1273 injected rm failure";
    jest.spyOn(fsp, "rename").mockRejectedValueOnce(new Error("INF-1273 injected rename failure"));
    jest.spyOn(fsp, "rm").mockRejectedValueOnce(new Error(injectedRmError));
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await applyProposal(proposal, baseDeps(rig, store));

    // Control flow unchanged: the pre-existing rename failure still surfaces
    // as apply-failed/retryable — the cleanup failure must not mask it or
    // change the outcome.
    expect(res.status).toBe("apply-failed");
    expect(res.retryable).toBe(true);

    // The swallowed rm() error must now be surfaced via the module logger
    // (this codebase's convention writes structured logs through
    // console.error — see src/logger.ts componentLogger/createLogger),
    // not silently dropped as it was before this fix.
    const loggedRmFailure = consoleErrorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(injectedRmError)),
    );
    expect(loggedRmFailure).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sites 2 & 3 — stale-plain-delegate-sweep.ts:365 (re-dispatch) and :330
// (escalation) postLinearComment failures.
// ═══════════════════════════════════════════════════════════════════════════

import {
  runStalePlainDelegateSweep,
} from "./stale-plain-delegate-sweep.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import { resetCronRegistryForTest } from "./cron/registry.js";

const STALE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const STALE_TIME = new Date(Date.now() - STALE_TIMEOUT_MS - 60_000).toISOString();

function makeStaleTicket(
  identifier: string,
  stateName: string,
  delegateName: string,
  delegateId: string,
) {
  return {
    id: `issue-${identifier.toLowerCase()}`,
    identifier,
    updatedAt: STALE_TIME,
    state: { name: stateName },
    labels: { nodes: [] as Array<{ name: string }> },
    delegate: { id: delegateId, name: delegateName },
  };
}

function mockLinearFetch(responses: Array<{ query?: string; response: unknown }>): typeof fetch {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const match = responses.find((r) => !r.query || body.includes(r.query));
    const data = match?.response ?? { data: { issues: { nodes: [] } } };
    return { ok: true, status: 200, json: async () => data } as Response;
  };
}

describe("INF-1273 — stale-plain-delegate-sweep.ts postLinearComment failures are logged, not swallowed", () => {
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;
  let alertStore: AlertStore;
  let alertBus: AlertBus;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    alertStore = new AlertStore(":memory:");
    alertBus = new AlertBus(alertStore);
  });

  afterAll(() => {
    alertStore.close();
  });

  beforeEach(() => {
    eventStore = new OperationalEventStore(":memory:");
    ackTracker = new DispatchAckTracker(":memory:");
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    ackTracker.close();
    resetCronRegistryForTest();
    consoleErrorSpy.mockRestore();
  });

  it("site :365 — a failed re-dispatch comment is logged via this file's own logger (component-tagged), and the redispatch still counts", async () => {
    const tickets = [makeStaleTicket("INF-9001", "Thinking", "Ai", "ai-uuid")];
    const fetcher = mockLinearFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
    ]);

    const injectedFailure = "INF-1273 injected postLinearComment failure (redispatch)";
    const failingComment = () => Promise.reject(new Error(injectedFailure));

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      postLinearComment: failingComment,
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    // Control flow unchanged: the redispatch itself must not be affected by
    // the comment-post failure.
    expect(result.redispatched).toBe(1);
    expect(result.errors).toHaveLength(0);

    // The swallowed rejection itself must be surfaced — not merely some
    // unrelated pre-existing info log that happens to mention the ticket id
    // (this file already logs "re-dispatched INF-9001 ..." on success, so
    // matching on ticket id alone is not discriminating). Require the
    // injected failure text AND this file's own component tag (proving it
    // reuses the file's existing logger, per AC2) in the same call.
    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(injectedFailure) &&
          arg.includes("[stale-plain-delegate]"),
      ),
    );
    expect(loggedCall).toBeDefined();
  });

  it("site :330 — a failed escalation comment is logged via this file's own logger (component-tagged), and the escalation still counts", async () => {
    // Seed 2 prior redispatch attempts (outside the 15-min recent-dispatch
    // window) so this pass takes the escalation branch, not re-dispatch.
    const oldTs = new Date(Date.now() - 20 * 60 * 1000)
      .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const db = (ackTracker as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    db.prepare(`
      INSERT INTO dispatch_acks
        (agent_id, ticket_id, dispatched_at, last_signal_at, ack_status, attempt_count)
      VALUES (?, ?, ?, ?, 'pending', 1)
    `).run("Ai", "linear-INF-9002", oldTs, oldTs);
    db.prepare(`
      UPDATE dispatch_acks SET
        ack_status = 'unconfirmed', dispatched_at = ?, last_signal_at = ?,
        attempt_count = 2, redispatch_failure_count = 0
      WHERE agent_id = ? AND ticket_id = ?
    `).run(oldTs, oldTs, "Ai", "linear-INF-9002");

    const tickets = [makeStaleTicket("INF-9002", "Thinking", "Ai", "ai-uuid")];
    const fetcher = mockLinearFetch([
      { query: "StalePlainDelegates", response: { data: { issues: { nodes: tickets } } } },
      { query: "StaleDelegateLabel", response: { data: { organization: { labels: { nodes: [{ id: "sid", name: "stale-delegate" }] } } } } },
      { query: "AddStaleDelegateLabel", response: { data: { issueUpdate: { success: true } } } },
    ]);

    const injectedFailure = "INF-1273 injected postLinearComment failure (escalation)";
    const failingComment = () => Promise.reject(new Error(injectedFailure));

    const result = await runStalePlainDelegateSweep({
      authToken: "tok",
      operationalEventStore: eventStore,
      alertBus,
      ackTracker,
      wakeFn: () => Promise.resolve(),
      postLinearComment: failingComment,
      fetchFn: fetcher,
      staleTimeoutMs: STALE_TIMEOUT_MS,
    });

    // Control flow unchanged: the escalation itself must not be affected by
    // the comment-post failure.
    expect(result.escalated).toBe(1);
    expect(result.redispatched).toBe(0);

    // See the :365 test above for why matching on ticket id alone would be
    // a false positive (this file already logs an escalation info line
    // containing the ticket id on success).
    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes(injectedFailure) &&
          arg.includes("[stale-plain-delegate]"),
      ),
    );
    expect(loggedCall).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sites 4 & 5 — admin.ts:1421 (set-state) and :1490 (recapture-ac) audit
// comment fetch failures.
// ═══════════════════════════════════════════════════════════════════════════

import { createApp } from "./index.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const ADMIN_SECRET = "inf-1273-admin-secret";

function adminTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-1273-admin-"));
}

function writeAdminAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      {
        name: "astrid",
        linearUserId: "user-astrid-linear-id",
        openclawAgent: "astrid",
        clientId: "client-id",
        clientSecret: "client-secret",
        accessToken: "access-token-astrid",
        refreshToken: "refresh-token-astrid",
        host: "local",
      },
    ],
  }), "utf8");
  return file;
}

function writeAdminPolicyYaml(dir: string): string {
  const file = path.join(dir, "capability-policy.yaml");
  const policy = {
    capabilities: [
      { id: "linear:transition" },
      { id: "human:escalate" },
    ],
    containers: [
      { id: "steward", grants: ["linear:transition", "human:escalate"] },
    ],
    roles: [
      { id: "steward", requires: ["human:escalate"] },
    ],
    bodies: [
      { id: "astrid", container: "steward", fills_roles: ["steward"] },
    ],
  };
  fs.writeFileSync(file, yaml.dump(policy), "utf8");
  return file;
}

function writeAdminWorkflowDef(dir: string): string {
  const file = path.join(dir, "dev-impl.yaml");
  const def = {
    id: "dev-impl",
    version: 1,
    entry_state: "intake",
    break_glass: { command: "escape", to: "escape", owner_role: "steward" },
    states: [
      { id: "intake", owner_role: "steward", kind: "normal", native_state: "todo", transitions: [{ command: "accept", to: "implementation" }] },
      { id: "implementation", owner_role: "dev", kind: "normal", native_state: "todo", transitions: [{ command: "submit", to: "done" }] },
      { id: "done", kind: "terminal", native_state: "done" },
      { id: "escape", kind: "terminal", native_state: "invalid" },
    ],
  };
  fs.writeFileSync(file, yaml.dump(def), "utf8");
  return file;
}

const MOCK_TEAM_STATES = [
  { id: "state-todo-uuid", name: "Todo", type: "unstarted" },
  { id: "state-done-uuid", name: "Done", type: "completed" },
];

/**
 * Mock fetch for the admin mutation endpoints. Every Linear call succeeds
 * EXCEPT the final `commentCreate` audit-comment call, which rejects (a
 * network-level failure — the exact case `.catch(() => {})` was masking).
 */
function makeFailingCommentFetch(opts: {
  fromLabels?: string[];
  consistencyLabels?: string[];
  descriptionWithAc?: string;
}): typeof globalThis.fetch {
  const {
    fromLabels = ["wf:dev-impl", "state:intake"],
    descriptionWithAc = "## Acceptance Criteria\n* AC1: does a thing",
  } = opts;
  const consistencyLabels = opts.consistencyLabels ?? fromLabels;
  let issueCallCount = 0;

  return async (_url, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString()
          : "";
    const parsed = JSON.parse(bodyText) as { query?: string };
    const query = parsed.query ?? "";

    if (query.includes("commentCreate")) {
      throw new Error("INF-1273 injected commentCreate network failure");
    }
    if (query.includes("TeamStates")) {
      return new Response(
        JSON.stringify({ data: { team: { states: { nodes: MOCK_TEAM_STATES } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "label-state-done-uuid", name: "state:done" },
                  { id: "label-state-implementation-uuid", name: "state:implementation" },
                  { id: "label-wf-dev-impl-uuid", name: "wf:dev-impl" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("IssueWithLabels")) {
      const labels = issueCallCount++ === 0 ? fromLabels : consistencyLabels;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "internal-issue-uuid",
              team: { id: "team-uuid" },
              labels: { nodes: labels.map((name) => ({ id: `label-${name.replace(/[:/]/g, "-")}-uuid`, name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("ApplyAtomicTransition") || (query.includes("issueUpdate") && query.includes("labelIds"))) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("VerifyTransitionWrite")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: consistencyLabels.map((name) => ({ name })) },
              delegate: null,
              state: { id: "state-todo-uuid" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (query.includes("IssueDescription") || query.includes("issue(id:")) {
      return new Response(
        JSON.stringify({ data: { issue: { description: descriptionWithAc } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("INF-1273 — admin.ts audit-comment fetch failures are logged, not swallowed", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    dir = adminTempDir();
    const policyFile = writeAdminPolicyYaml(dir);
    const agentsFile = writeAdminAgents(dir);
    const wfDir = path.join(dir, "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    writeAdminWorkflowDef(wfDir);

    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    process.env.AGENTS_FILE = agentsFile;
    process.env.WORKFLOW_DEF_DIR = wfDir;
    process.env.AC_RECORDS_PATH = path.join(dir, "ac-records.json");

    reloadAgents();
    resetPolicyCache();
    resetWorkflowCache();
    originalFetch = globalThis.fetch;
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    resetPolicyCache();
    resetWorkflowCache();
    delete process.env.ADMIN_SECRET;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.WORKFLOW_DEF_DIR;
    delete process.env.AC_RECORDS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("site :1421 — set-state still returns 200 when the audit-comment post fails, and the failure is logged with the ticket id", async () => {
    globalThis.fetch = makeFailingCommentFetch({
      fromLabels: ["wf:dev-impl", "state:intake"],
      consistencyLabels: ["wf:dev-impl", "state:implementation"],
    });

    const res = await request(appState.app)
      .post("/admin/api/set-state")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({
        ticketId: "INF-9101",
        targetState: "implementation",
        invoker: "astrid",
        reason: "INF-1273 regression check",
      });

    // Control flow unchanged: the state mutation must succeed regardless of
    // the (now-logged, previously silent) audit-comment failure.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The injected commentCreate rejection itself must be surfaced — not
    // merely some unrelated log line that happens to mention the ticket id
    // (workflow-gate/ac-record-store already log info/warn lines carrying
    // the ticket id on the success path, so matching on ticket id alone is
    // not discriminating). Require both the failure text and the ticket id
    // together, for the "which operation/ticket failed" context the AC asks
    // for.
    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("INF-1273 injected commentCreate network failure") &&
          arg.includes("INF-9101"),
      ),
    );
    expect(loggedCall).toBeDefined();
  });

  it("site :1490 — recapture-ac still returns 200 when the audit-comment post fails, and the failure is logged with the ticket id", async () => {
    globalThis.fetch = makeFailingCommentFetch({});

    const res = await request(appState.app)
      .post("/admin/api/recapture-ac")
      .set("x-admin-secret", ADMIN_SECRET)
      .send({
        ticketId: "INF-9102",
        callerBodyId: "astrid",
        invoker: "astrid",
        reason: "INF-1273 regression check",
      });

    // Control flow unchanged: recapture-ac must succeed regardless of the
    // (now-logged, previously silent) audit-comment failure.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // See the set-state test above for why matching on ticket id alone
    // would be a false positive (ac-record-store already logs an info line
    // containing the ticket id on the recaptureAc success path).
    const loggedCall = consoleErrorSpy.mock.calls.find((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("INF-1273 injected commentCreate network failure") &&
          arg.includes("INF-9102"),
      ),
    );
    expect(loggedCall).toBeDefined();
  });
});
