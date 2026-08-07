/**
 * INF-1277 — end-to-end integration coverage for the transition-audit
 * persistence + query feature, driven through the real proxy HTTP layer
 * (not a direct unit call), per the ticket's AC5 mandate:
 *
 *   "The persistence write is invoked from the live emitTransitionAuditRecord
 *    path that runs on every governed transition in production (reachable
 *    from the production entry point, e.g. index.ts), and the query endpoint
 *    is mounted on the production admin API router — both proven by an
 *    integration test that boots the entry point, drives a real governed
 *    transition, and asserts (a) a record was persisted and (b) it is
 *    returned by GET /admin/api/transition-audit. A module-level unit test
 *    that calls the persistence function or route handler directly does NOT
 *    satisfy this."
 *
 * createApp() (src/index.ts) IS the production entry point's app factory —
 * it is the exact function invoked, unmodified, by the `isEntryPoint` bootstrap
 * block at the bottom of index.ts. Driving transitions through
 * `request(appState.app).post("/proxy/graphql")...` and querying through
 * `request(appState.app).get("/admin/api/transition-audit")...` exercises the
 * live wiring end-to-end, not a mocked or directly-invoked function — this is
 * the same technique already established for AI-1808-class bootstrap-wiring
 * proof in this repo (see src/inf-443-optional-transition-comments.test.ts
 * AC1-3). A companion subprocess-boot test
 * (src/inf-1277-bootstrap-wiring.test.ts) additionally proves the store/route
 * are wired at the literal `dist/index.js` entry point and observable at
 * /health without a transition occurring (AC5's liveness bullet).
 *
 * AC mapping:
 *   AC1 — persisted record fields (ticket, intent, from/to, agent, status,
 *         code, detail, gateResults, label-mismatch flag, timestamp).
 *   AC2 — GET /admin/api/transition-audit surfaces what was just persisted.
 *   AC3 — a refused submit's response includes status+code+detail.
 *   AC5 — both proven via a real driven transition through createApp().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { createApp } from "./index.js";

const ADMIN_SECRET = "inf-1277-integration-secret";

const POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]

bodies:
  - id: charles
    container: dev
    fills_roles: [dev]
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 9
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: submit
        to: code-review
        requires_comment: true
  - id: code-review
    owner_role: dev
    kind: normal
    native_state: todo
    transitions: []
`;

const INTAKE_CONTEXT = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] }, delegate: { id: "u-astrid" } } },
};
const INTAKE_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid", identifier: "INF-1277-AC1", team: { id: "team-uuid" },
      labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "intake-lbl", name: "state:intake" }] },
    },
  },
};
const IMPLEMENTATION_CONTEXT = {
  data: { issue: { labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:implementation" }] }, delegate: { id: "u-charles" } } },
};
const IMPLEMENTATION_WITH_IDS = {
  data: {
    issue: {
      id: "internal-uuid", identifier: "INF-1277-AC3", team: { id: "team-uuid" },
      labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }, { id: "impl-lbl", name: "state:implementation" }] },
    },
  },
};
const TEAM_LABELS = {
  data: {
    team: {
      labels: { nodes: [
        { id: "intake-lbl", name: "state:intake" },
        { id: "impl-lbl", name: "state:implementation" },
        { id: "cr-lbl", name: "state:code-review" },
      ] },
    },
  },
};
const TEAM_STATES = {
  data: { team: { states: { nodes: [
    { id: "s-todo", name: "Todo", type: "unstarted" },
    { id: "s-doing", name: "Doing", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
  ] } } },
};

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { name: "charles", linearUserId: "u-charles", openclawAgent: "charles", accessToken: "tok1", host: "local" },
      { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok3", host: "local" },
    ],
  }), "utf8");
  return file;
}

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pollUntil: condition never satisfied within timeout");
}

describe("INF-1277 — transition-audit persistence driven through a real governed transition", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1277-integration-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;
    process.env.ADMIN_SECRET = ADMIN_SECRET;

    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      // AC1/AC4/AC5 — implementer-added option, mirrors operationalEventsDbPath's
      // pattern: a per-test-isolated on-disk SQLite path for the new store.
      transitionAuditDbPath: path.join(dir, "transition-audit.db"),
    } as Parameters<typeof createApp>[0] & { transitionAuditDbPath: string });

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
    // AC1/AC4 — implementer-exposed handle, mirrors operationalEventStore.
    (appState as unknown as { transitionAuditStore?: { close(): void } }).transitionAuditStore?.close();
    delete process.env.ADMIN_SECRET;
  });

  function makeFetch(opts: {
    context?: object; withIds?: object; atomicSuccess?: boolean;
    postVerifyLabel?: string | null;
  }): typeof globalThis.fetch {
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        return originalFetch(url, init);
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
      const q = parsed.query ?? "";
      const json = (payload: object) => new Response(JSON.stringify(payload), {
        status: 200, headers: { "Content-Type": "application/json" },
      });

      if (q.includes("IssueStateLabel")) {
        const label = opts.postVerifyLabel;
        if (label === undefined) {
          // Default: echo back whatever the "to" side of withIds implies —
          // callers that care about mismatch pass postVerifyLabel explicitly.
          return json({ data: { issue: { labels: { nodes: [] } } } });
        }
        return json({
          data: { issue: { labels: { nodes: label === null ? [] : [{ name: label }] } } },
        });
      }
      if ((q.includes("IssueContext") || q.includes("IssueLabels")) && !q.includes("IssueWithLabels")) {
        return json(opts.context ?? INTAKE_CONTEXT);
      }
      if (q.includes("IssueWithLabels")) {
        return json(opts.withIds ?? INTAKE_WITH_IDS);
      }
      if (q.includes("TeamLabels")) return json(TEAM_LABELS);
      if (q.includes("TeamStates")) return json(TEAM_STATES);
      if (q.includes("ApplyAtomicTransition")) {
        return json({ data: { issueUpdate: { success: opts.atomicSuccess ?? true } } });
      }
      return json({ data: { issueUpdate: { success: true, issue: { id: "internal-uuid" } } } });
    };
  }

  function acceptAtIntake(issueId: string) {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "accept")
      .send({
        query: "mutation M($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
        variables: { id: issueId },
      });
  }

  function submitAtImplementation(issueId: string, comment: string) {
    return request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .set("X-Openclaw-Linear-Intent", "submit")
      .send({
        query: `mutation commentCreate($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        variables: { issueId, body: comment },
      });
  }

  // ── AC1 + AC5(a)/(b): applied transition persisted + returned by the query endpoint ──

  it("AC1/AC5: an applied transition is persisted with all AC1 fields and returned by GET /admin/api/transition-audit", async () => {
    const ticket = "INF-1277-AC1";
    globalThis.fetch = makeFetch({
      context: INTAKE_CONTEXT,
      withIds: { data: { issue: { ...INTAKE_WITH_IDS.data.issue, identifier: ticket } } },
      atomicSuccess: true,
      postVerifyLabel: "state:implementation",
    });

    const res = await acceptAtIntake(ticket);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body._workflowTransition?.status).toBe("applied");

    const body = await pollUntil(async () => {
      const q = await request(appState.app)
        .get("/admin/api/transition-audit")
        .query({ ticket })
        .set("x-admin-secret", ADMIN_SECRET);
      return q.body.records?.length > 0 ? q.body : null;
    });

    expect(Array.isArray(body.records)).toBe(true);
    const record = body.records[0];
    expect(record.ticket).toBe(ticket);
    expect(record.intent).toBe("accept");
    expect(record.fromState).toBe("intake");
    expect(record.toState).toBe("implementation");
    expect(record.agent).toBe("astrid");
    expect(record.status).toBe("applied");
    expect(typeof record.code).toBe("string");
    expect(Array.isArray(record.gateResults)).toBe(true);
    expect(typeof record.ts).toBe("string");
    expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
  }, 15_000);

  // ── AC3: a refused submit's response self-documents status+code+detail ──

  it("AC3: a refused submit (atomic write failure) surfaces status+code+detail in the response, and the failure is persisted + queryable", async () => {
    const ticket = "INF-1277-AC3";
    globalThis.fetch = makeFetch({
      context: IMPLEMENTATION_CONTEXT,
      withIds: { data: { issue: { ...IMPLEMENTATION_WITH_IDS.data.issue, identifier: ticket } } },
      atomicSuccess: false,
    });

    const res = await submitAtImplementation(ticket, "Implemented all AC. Ready for review.");

    expect(res.status).toBe(200);
    // The decline itself must self-document its failure type: status+code+detail
    // as distinct, machine-readable fields — not just the "still carries
    // state:implementation" human phrasing.
    expect(res.body._workflowTransition).toBeDefined();
    expect(res.body._workflowTransition.status).toBe("failed");
    expect(res.body._workflowTransition.code).toBe("atomic-mutation-failed");
    expect("detail" in res.body._workflowTransition).toBe(true);

    const body = await pollUntil(async () => {
      const q = await request(appState.app)
        .get("/admin/api/transition-audit")
        .query({ ticket, status: "failed" })
        .set("x-admin-secret", ADMIN_SECRET);
      return q.body.records?.length > 0 ? q.body : null;
    });

    const record = body.records[0];
    expect(record.status).toBe("failed");
    expect(record.code).toBe("atomic-mutation-failed");
    expect(typeof record.detail === "string" || record.detail === null).toBe(true);
  }, 15_000);

  // ── AC1: label-mismatch flag reflects a real post-transition divergence ──

  it("AC1: a post-transition label mismatch is reflected as labelMismatch=true on the persisted record", async () => {
    const ticket = "INF-1277-MISMATCH";
    globalThis.fetch = makeFetch({
      context: INTAKE_CONTEXT,
      withIds: { data: { issue: { ...INTAKE_WITH_IDS.data.issue, identifier: ticket } } },
      atomicSuccess: true,
      // The re-read after the transition claims the label never actually
      // advanced past intake — the exact "still carries state:implementation"
      // signature this ticket exists to make machine-readable.
      postVerifyLabel: "state:intake",
    });

    const res = await acceptAtIntake(ticket);
    expect(res.status).toBe(200);

    const body = await pollUntil(async () => {
      const q = await request(appState.app)
        .get("/admin/api/transition-audit")
        .query({ ticket })
        .set("x-admin-secret", ADMIN_SECRET);
      const rec = q.body.records?.[0];
      return rec && rec.labelMismatch === true ? q.body : null;
    }, 8000);

    expect(body.records[0].labelMismatch).toBe(true);
  }, 15_000);

  // ── AC5 liveness bullet: observable without waiting for a transition ──

  it("AC5: /health exposes transition-audit store liveness without any transition having occurred", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.transitionAudit).toBeDefined();
    const live = res.body.transitionAudit as Record<string, unknown>;
    expect(live.storeInitialized).toBe(true);
    expect(live.queryRouteRegistered).toBe(true);
  });
});
