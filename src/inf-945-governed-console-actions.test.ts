/**
 * INF-945 — governed console/API controls for stale-session levers.
 *
 * AC map:
 * - C1 delegate-set: console + scoped admin API, delegate set/clear/leave via
 *   POST /admin/api/set-state, governed per action, one audit row per mutation,
 *   and no legacy issueUpdateDelegateOnly path.
 * - C2 force-redispatch and promote/park: scoped admin API + console actions,
 *   governed with tier asymmetry, one audit row per mutation, and no shell path.
 * - C3 probe: scoped read-only API + console panel, connector-truth response,
 *   T0/read-only governance, and no audit mutation row.
 * - INF-909 stale-session liveness: observed as non-blocking; no background
 *   bootstrap criterion is added by this ticket.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

const ADMIN_SECRET = "inf-945-admin-secret";
const TICKET = "INF-945";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-945-"));
}

function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({
    agents: [{
      name: "igor",
      linearUserId: "user-igor-12345678",
      openclawAgent: "igor",
      host: "local",
    }],
  }), "utf8");
  return file;
}

function changedSourceFiles(): Array<{ file: string; text: string }> {
  const root = process.cwd();
  const files = [
    "src/admin.ts",
    "src/workflow-gate.ts",
    "src/delegation-reconciliation-sweep.ts",
    "web/src/api.ts",
    "web/src/components/OpsActions.tsx",
    "web/src/pages/TicketDetailView.tsx",
    "web/src/pages/StallsPage.tsx",
  ];
  return files
    .map((file) => ({ file, abs: path.join(root, file) }))
    .filter(({ abs }) => fs.existsSync(abs))
    .map(({ file, abs }) => ({ file, text: fs.readFileSync(abs, "utf8") }));
}

describe("INF-945 scoped admin API routes", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = tempDir();
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.AGENTS_FILE = writeAgents(dir);
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_OAUTH_TOKEN;
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "mutation-audit.db"),
      observationsDbPath: path.join(dir, "observations.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled.db"),
      managingStateDbPath: path.join(dir, "managing.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
      dispatchLeaseDbPath: path.join(dir, "lease.db"),
      dispatchInFlightDbPath: path.join(dir, "inflight.db"),
      proposalsDbPath: path.join(dir, "proposals.db"),
      livenessDispatchDbPath: path.join(dir, "liveness.db"),
      deadLetterQueueDbPath: path.join(dir, "deadletters.db"),
    });
  });

  afterEach(() => {
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.observationStore.close();
    appState.enrolledTicketsStore.close();
    appState.managingStateStore.close();
    appState.mutationAuditStore.close();
    appState.idempotencyStore.close();
    appState.proposalStore.close();
    appState.dispatchLeaseStore.close();
    appState.dispatchInFlightStore.close();
    appState.livenessDispatchStore.close();
    delete process.env.ADMIN_SECRET;
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_OAUTH_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function authedPost(route: string, body: Record<string, unknown>) {
    return request(appState.app)
      .post(route)
      .set("x-admin-secret", ADMIN_SECRET)
      .send(body);
  }

  function authedGet(route: string) {
    return request(appState.app)
      .get(route)
      .set("x-admin-secret", ADMIN_SECRET);
  }

  test("C1 delegate-set: /admin/api/set-state accepts delegate set/clear/leave as delegate-only mutations and audits exactly one row", async () => {
    const cases = [
      { delegateMode: "set", delegate: "igor", expectedField: "delegateId", expectedNewValue: "igor" },
      { delegateMode: "clear", delegate: null, expectedField: "delegateId", expectedNewValue: null },
      { delegateMode: "leave", expectedField: "delegateId", expectedNewValue: "unchanged" },
    ];

    for (const c of cases) {
      const before = appState.mutationAuditStore.byTicket(TICKET).length;
      const res = await authedPost("/admin/api/set-state", {
        action: "delegate-set",
        ticketId: TICKET,
        delegateMode: c.delegateMode,
        delegate: c.delegate,
        invoker: "astrid",
        role: "steward",
        capability: "governed-console:delegate-set",
        reason: `INF-945 ${c.delegateMode}`,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        action: "delegate-set",
        ticketId: TICKET,
        governance: { tier: "T1", capability: "governed-console:delegate-set" },
        auditReceipt: { ticketId: TICKET, action: "delegate-set", mutationCount: 1 },
      });

      const records = appState.mutationAuditStore.byTicket(TICKET);
      expect(records).toHaveLength(before + 1);
      expect(records[0]).toMatchObject({
        source: "proxy",
        ticket: TICKET,
        changeType: "delegate",
        field: c.expectedField,
        actorId: "astrid",
        opName: "governed-console.delegate-set",
        intent: expect.stringContaining(c.delegateMode),
      });
      expect(records[0].newValue).toBe(c.expectedNewValue);
    }
  });

  test("C1 delegate-set: per-action capability denial happens before mutation or audit", async () => {
    const res = await authedPost("/admin/api/set-state", {
      action: "delegate-set",
      ticketId: TICKET,
      delegateMode: "set",
      delegate: "igor",
      invoker: "tdd",
      role: "test-author",
      capability: "governed-console:probe",
      reason: "wrong role must be denied",
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error: expect.stringMatching(/capability|authorized|governance/i),
      governance: { tier: "T1", requiredCapability: "governed-console:delegate-set" },
    });
    expect(appState.mutationAuditStore.byTicket(TICKET)).toHaveLength(0);
  });

  test("C2 force-redispatch: /admin/api/redispatch is governed in-process and writes one audit row", async () => {
    const res = await authedPost("/admin/api/redispatch", {
      ticketId: TICKET,
      invoker: "astrid",
      role: "steward",
      capability: "governed-console:force-redispatch",
      reason: "demo C2 stale-session recovery",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      action: "force-redispatch",
      ticketId: TICKET,
      shellPath: false,
      governance: { tier: "T1", capability: "governed-console:force-redispatch" },
      auditReceipt: { ticketId: TICKET, action: "force-redispatch", mutationCount: 1 },
    });
    expect(appState.mutationAuditStore.byTicket(TICKET)).toEqual([
      expect.objectContaining({
        source: "proxy",
        changeType: "delegate",
        ticket: TICKET,
        opName: "governed-console.force-redispatch",
        actorId: "astrid",
      }),
    ]);
  });

  test("C2 promote/park: Backlog movement uses asymmetric governance tiers and one audit row per mutation", async () => {
    const promote = await authedPost("/admin/api/backlog/promote", {
      ticketId: TICKET,
      invoker: "astrid",
      role: "steward",
      capability: "governed-console:promote",
      reason: "return to active verification",
    });
    expect(promote.status).toBe(200);
    expect(promote.body).toMatchObject({
      ok: true,
      action: "promote",
      from: "Backlog",
      governance: { tier: "T1", capability: "governed-console:promote" },
      auditReceipt: { action: "promote", mutationCount: 1 },
    });

    const parkDenied = await authedPost("/admin/api/backlog/park", {
      ticketId: TICKET,
      invoker: "tdd",
      role: "test-author",
      capability: "governed-console:promote",
      reason: "parking is disruptive and must not share promote capability",
    });
    expect(parkDenied.status).toBe(403);

    const park = await authedPost("/admin/api/backlog/park", {
      ticketId: TICKET,
      invoker: "astrid",
      role: "steward",
      capability: "governed-console:park",
      reason: "operator demonstration of disruptive park",
    });
    expect(park.status).toBe(200);
    expect(park.body).toMatchObject({
      ok: true,
      action: "park",
      to: "Backlog",
      governance: { tier: "T2", capability: "governed-console:park" },
      auditReceipt: { action: "park", mutationCount: 1 },
    });

    const audit = appState.mutationAuditStore.byTicket(TICKET);
    expect(audit.filter((r) => r.opName === "governed-console.promote")).toHaveLength(1);
    expect(audit.filter((r) => r.opName === "governed-console.park")).toHaveLength(1);
  });

  test("C3 probe: read-only route returns connector-truth delegate/dispatch/block state and does not audit", async () => {
    const before = appState.mutationAuditStore.byTicket(TICKET).length;
    const res = await authedGet(`/admin/api/probe/${TICKET}?invoker=astrid&role=steward&capability=governed-console:probe`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: "probe",
      ticketId: TICKET,
      readOnly: true,
      governance: { tier: "T0", capability: "governed-console:probe" },
      connectorTruth: {
        resolvedDelegate: expect.objectContaining({ agent: expect.any(String), source: expect.any(String) }),
        dispatchStatus: expect.objectContaining({ status: expect.any(String) }),
        block: expect.anything(),
      },
    });
    expect(res.body).not.toHaveProperty("auditReceipt");
    expect(appState.mutationAuditStore.byTicket(TICKET)).toHaveLength(before);
  });
});

describe("INF-945 console UI action surface", () => {
  test("C1/C2/C3 actions are exposed through governed console primitives with audit receipts and probe panel", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "web/src/components/OpsActions.tsx"), "utf8");

    const requirements: Array<[string, RegExp]> = [
      ["GovernedControl primitive", /GovernedControl/],
      ["AuditReceipt primitive", /AuditReceipt/],
      ["ProbePanel primitive", /ProbePanel/],
      ["delegate-set action", /delegate-set|Delegate Set/i],
      ["force-redispatch action", /force-redispatch|Force Redispatch/i],
      ["promote action", /promote/i],
      ["park action", /park/i],
      ["probe action", /probe/i],
      ["delegate-set capability", /governed-console:delegate-set/],
      ["force-redispatch capability", /governed-console:force-redispatch/],
      ["promote capability", /governed-console:promote/],
      ["park capability", /governed-console:park/],
      ["probe capability", /governed-console:probe/],
      ["probe T0 tier", /tier:\s*["']T0["'][\s\S]*probe|probe[\s\S]*tier:\s*["']T0["']/],
      ["promote T1 tier", /tier:\s*["']T1["'][\s\S]*promote|promote[\s\S]*tier:\s*["']T1["']/],
      ["park T2 tier", /tier:\s*["']T2["'][\s\S]*park|park[\s\S]*tier:\s*["']T2["']/],
    ];
    const missing = requirements
      .filter(([, pattern]) => !pattern.test(source))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  test("C1/C2 no-shell red line: governed console actions do not call terminal or legacy delegate-only paths", () => {
    const actionSources = changedSourceFiles()
      .filter(({ file }) => /admin|OpsActions|TicketDetail|Stalls|api|delegation-reconciliation|workflow-gate/.test(file));

    for (const { file, text } of actionSources) {
      const shellMatches = text.match(/child_process|execFile|execSync|spawn\(|shell:\s*true|linear\s+(delegate|park|promote|redispatch)/g) ?? [];
      expect(shellMatches).toEqual([]);
    }

    const workflowGate = fs.readFileSync(path.join(process.cwd(), "src/workflow-gate.ts"), "utf8");
    const delegateOnlyCalls = workflowGate
      .split("\n")
      .filter((line) => line.includes("issueUpdateDelegateOnly(") && !line.includes("function issueUpdateDelegateOnly("));
    expect(delegateOnlyCalls).toEqual([]);
  });

  test("INF-909 stale-session liveness stays non-blocking and this ticket adds no background bootstrap criterion", () => {
    const adminSource = fs.readFileSync(path.join(process.cwd(), "src/admin.ts"), "utf8");
    const healthSource = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");

    const staleSessionNonBlocking =
      /INF-909[\s\S]*(done|non-blocking)|stale-session[\s\S]*non-blocking/i.test(adminSource);
    const backgroundCriterionAdded =
      /governedConsole.*scheduled|registerGovernedConsole.*Cron|setInterval\(.*governedConsole/s.test(healthSource);
    expect({ staleSessionNonBlocking, backgroundCriterionAdded }).toEqual({
      staleSessionNonBlocking: true,
      backgroundCriterionAdded: false,
    });
  });
});
