/**
 * INF-1304 — xfn/intake recovery must preserve true workflow position.
 *
 * Verbatim AC of record (captured 2026-08-07T04:14:36.866Z):
 *   1. When recovering a `wf:*` ticket from xfn/intake residue, the connector
 *      must not blindly restart from intake if the timeline/labels/ledger
 *      identify a later true workflow position.
 *   2. Recovery must preserve the correct next owner role for the true state:
 *      review-ready artifacts route to code-review/Charles;
 *      implementation blockers route to implementation/dev owner;
 *      deploy proof/blockers route to deploy/Grover;
 *      AC-ready deployed artifacts route to ac-validate/Astrid.
 *   3. Illegal routing targets must fail loudly with the expected legal owner
 *      roles and must not clear a valid delegate without a repair path.
 *   4. Add regression coverage using the 04:04Z watch examples: INF-1292,
 *      INF-1281, and INF-1277 shapes.
 *   5. The watch/cron summary must report the recovered true state and owner,
 *      not merely that xfn/intake residue was moved.
 *
 * All tests in this file are RED until the recovery path is implemented.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── New module under test (does not exist yet — import must fail until impl) ──
// The implementer creates src/xfn-intake-recovery.ts exporting these symbols.
// Tests remain RED while the module is absent or ignores history.
type TruePosition = {
  stateId: string;
  ownerRole: string;
  evidence: string;
};

type RecoverXfnIntakeOptions = {
  authToken: string;
  workflowRegistry: Map<string, { id?: string; entry_state?: string; states: Array<{ id: string; owner_role?: string }> }>;
  capabilityPolicyPath?: string;
  fetchTicketHistory?: (ticketId: string) => Promise<Array<{ from?: string; to?: string; state?: string; comment?: string; createdAt?: string; actor?: string }>>;
  fetchTransitionAudit?: (ticketId: string) => Promise<Array<{ from: string; to: string; createdAt: string }>>;
  bodyIdToLinearUserId?: (bodyId: string) => string | null;
  labelNameToId?: (name: string) => string | null;
};

// We use a dynamic import helper so the suite is still collectible when the file is absent.
// Each test does: const mod = await loadRecoveryModule(); — throws / fails until impl exists.
async function loadRecoveryModule(): Promise<{
  resolveTruePosition: (ticket: { labels: string[]; identifier?: string; id?: string }, history: Array<{ state?: string; to?: string; comment?: string }>, opts?: unknown) => TruePosition | null;
  recoverXfnIntakeTicket: (ticket: { id: string; identifier: string; labels: string[]; delegateId: string | null; labelNodes: Array<{ id: string; name: string }>; teamId: string }, opts: RecoverXfnIntakeOptions) => Promise<{ recovered: boolean; stateId?: string; delegateId?: string; action: string; outcome: string }>;
  isXfnIntakeResidue: (labels: string[]) => boolean;
}> {
  // The module must exist at this path after implementation
  const mod = await import("./xfn-intake-recovery.js");
  return mod as unknown as ReturnType<typeof loadRecoveryModule> extends Promise<infer T> ? T : never;
}

import {
  runRescueSweep,
  classifyTicket,
} from "./rescue-sweep.js";

// ── Shared fixtures ────────────────────────────────────────────────────────

const DEV_IMPL_DEF = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake", owner_role: "steward" },
    { id: "write-tests", owner_role: "test-author" },
    { id: "implementation", owner_role: "dev" },
    { id: "code-review", owner_role: "code-review" },
    { id: "merge", owner_role: "deployment" },
    { id: "deploy", owner_role: "host-deploy" },
    { id: "ac-validate", owner_role: "steward" },
    { id: "done", owner_role: undefined },
    { id: "escape", owner_role: undefined },
  ],
};

function makeRegistry() {
  return new Map<string, typeof DEV_IMPL_DEF>([["dev-impl", DEV_IMPL_DEF]]);
}

// Minimal Linear mock for runRescueSweep integration
function makeLinearMock(opts: {
  issues?: Array<{ id: string; identifier: string; labels: string[]; delegateId: string | null; updatedAt?: string }>;
  historyById?: Map<string, Array<{ state?: string; to?: string; comment?: string }>>;
  delegateUpdateSuccess?: boolean;
  labelUpdateSuccess?: boolean;
}) {
  const delegateCalls: Array<{ id: string; delegateId: string }> = [];
  const labelCalls: Array<{ id: string; labelIds: string[] }> = [];
  let historyCalls = 0;

  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("WorkflowIssues") || query.includes("issues(")) {
      const nodes = (opts.issues ?? []).map((iss) => ({
        id: iss.id,
        identifier: iss.identifier,
        updatedAt: iss.updatedAt ?? new Date().toISOString(),
        team: { id: "team-test" },
        state: { name: "Todo" },
        labels: { nodes: iss.labels.map((name, i) => ({ id: `lbl-${i}-${name}`, name })) },
        delegate: iss.delegateId ? { id: iss.delegateId, name: iss.delegateId } : null,
      }));
      return new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (query.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "uuid-lbl-wf-dev-impl", name: "wf:dev-impl" },
                  { id: "uuid-lbl-state-intake", name: "state:intake" },
                  { id: "uuid-lbl-state-write-tests", name: "state:write-tests" },
                  { id: "uuid-lbl-state-implementation", name: "state:implementation" },
                  { id: "uuid-lbl-state-code-review", name: "state:code-review" },
                  { id: "uuid-lbl-state-merge", name: "state:merge" },
                  { id: "uuid-lbl-state-deploy", name: "state:deploy" },
                  { id: "uuid-lbl-state-ac-validate", name: "state:ac-validate" },
                  { id: "uuid-lbl-state-done", name: "state:done" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Issue history / timeline fetch (used by xfn-intake recovery)
    if (query.includes("history") || query.includes("History") || query.includes("comments") || query.includes("Comment")) {
      historyCalls++;
      const ticketId = (parsed.variables as Record<string, unknown> | undefined)?.["id"] as string | undefined;
      const hist = ticketId ? opts.historyById?.get(ticketId) ?? [] : [];
      return new Response(JSON.stringify({ data: { issue: { history: hist, comments: { nodes: hist } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (query.includes("issueUpdate")) {
      const vars = parsed.variables as Record<string, unknown> | undefined;
      if (vars?.["delegateId"] !== undefined) delegateCalls.push({ id: vars["id"] as string, delegateId: vars["delegateId"] as string });
      if (vars?.["labelIds"] !== undefined) labelCalls.push({ id: vars["id"] as string, labelIds: vars["labelIds"] as string[] });
      const success = query.includes("delegateId")
        ? (opts.delegateUpdateSuccess ?? true)
        : (opts.labelUpdateSuccess ?? true);
      return new Response(JSON.stringify({ data: { issueUpdate: { success } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Single issue fetch for live guard
    if (query.includes("issue(") || query.includes("Issue(")) {
      return new Response(JSON.stringify({ data: { issue: { id: "live", labels: { nodes: [] }, delegate: null } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`inf-1304-test: unexpected Linear query: ${query.slice(0, 200)}`);
  };

  return { fetch: mockFetch, delegateCalls, labelCalls, getHistoryCalls: () => historyCalls };
}

// ── AC1: history-aware recovery — must not blindly restart from intake ─────

describe("INF-1304 AC1 — xfn/intake residue: history-aware recovery, not blind intake restart", () => {
  it("resolveTruePosition: timeline with PR-ready at code-review resolves to code-review, not intake", async () => {
    const mod = await loadRecoveryModule();
    const ticket = { labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], identifier: "INF-1292", id: "id-1292" };
    const history = [
      { state: "code-review", to: "code-review", comment: "PR #704 ready for review" },
      { state: "implementation", to: "implementation" },
      { state: "intake", to: "intake" },
    ];
    const pos = mod.resolveTruePosition(ticket, history);
    expect(pos).not.toBeNull();
    expect(pos!.stateId).toBe("code-review");
    expect(pos!.ownerRole).toBe("code-review");
  });

  it("recoverXfnIntakeTicket: ticket with xfn/intake label but later true position recovers to true state, not intake", async () => {
    const mod = await loadRecoveryModule();
    const ticket = {
      id: "id-1292",
      identifier: "INF-1292",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: "u-astrid",
      labelNodes: [
        { id: "lbl-wf", name: "wf:dev-impl" },
        { id: "lbl-intake", name: "state:intake" },
        { id: "lbl-xfn", name: "xfn:workflow" },
      ],
      teamId: "team-test",
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac1-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: astrid\n    fills_roles: [steward]\n  - id: charles\n    fills_roles: [code-review]\n  - id: igor\n    fills_roles: [dev]\n",
      "utf8",
    );
    const history = [{ state: "code-review", to: "code-review", comment: "PR #704 ready for review" }];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const result = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => history,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(result.recovered).toBe(true);
      expect(result.stateId).toBe("code-review");
      expect(result.stateId).not.toBe("intake");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runRescueSweep: xfn/intake ticket with PR evidence is NOT bootstrapped to intake (integration)", async () => {
    // A ticket at state:intake with xfn residue but history showing code-review
    // must be rescued to code-review, not re-bootstrapped to intake.
    const historyById = new Map<string, Array<{ state?: string; to?: string; comment?: string }>>([
      ["id-1292", [{ state: "code-review", to: "code-review", comment: "PR #704 ready for review at 23:11Z" }]],
    ]);
    const mock = makeLinearMock({
      issues: [{ id: "id-1292", identifier: "INF-1292", labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], delegateId: "u-astrid" }],
      historyById,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fetch;
    try {
      const registry = makeRegistry();
      const result = await runRescueSweep({
        authToken: "tok",
        workflowRegistry: registry,
        operationalEventStore: { append: () => {} },
        labelNameToId: (name: string) => `uuid-${name}`,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
      });
      // Must have a rescue that routes to code-review, not intake
      const rescue = result.rescues.find((r) => r.identifier === "INF-1292");
      expect(rescue).toBeDefined();
      expect(rescue!.action.toLowerCase()).toContain("code-review");
      expect(rescue!.action.toLowerCase()).not.toMatch(/bootstrap.*intake|applied state:intake/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("isXfnIntakeResidue: identifies wf:* + state:intake + xfn as residue shape", async () => {
    const mod = await loadRecoveryModule();
    expect(mod.isXfnIntakeResidue(["wf:dev-impl", "state:intake", "xfn:workflow"])).toBe(true);
    expect(mod.isXfnIntakeResidue(["wf:dev-impl", "state:code-review"])).toBe(false);
    expect(mod.isXfnIntakeResidue(["wf:dev-impl", "state:intake"])).toBe(false);
  });
});

// ── AC2: correct next owner role per true state ───────────────────────────

describe("INF-1304 AC2 — recovery preserves correct next owner role per true state", () => {
  it("review-ready artifact routes to code-review/Charles", async () => {
    const mod = await loadRecoveryModule();
    const pos = mod.resolveTruePosition(
      { labels: ["wf:dev-impl", "state:intake"] },
      [{ state: "code-review", to: "code-review", comment: "PR #704 ready for review" }],
    );
    expect(pos).not.toBeNull();
    expect(pos!.stateId).toBe("code-review");
    expect(pos!.ownerRole).toBe("code-review");
    // The delegate for code-review must be Charles (the sole code-review body)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac2a-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n", "utf8");
    const ticket = {
      id: "id-r1",
      identifier: "INF-1292",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "code-review", to: "code-review" }],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.delegateId).toBe("u-charles");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("implementation blocker routes to implementation/dev owner (Igor)", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac2b-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: igor\n    fills_roles: [dev]\n  - id: charles\n    fills_roles: [code-review]\n",
      "utf8",
    );
    const ticket = {
      id: "id-1277",
      identifier: "INF-1277",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "implementation", to: "implementation", comment: "PR #698 needs rebase" }],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("implementation");
      expect(res.delegateId).toBe("u-igor");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deploy proof/blocker routes to deploy/Grover", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac2c-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: grover\n    fills_roles: [host-deploy]\n", "utf8");
    const ticket = {
      id: "id-deploy",
      identifier: "INF-1304-DEPLOY",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "deploy", to: "deploy", comment: "deployed 87447aa4" }],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("deploy");
      expect(res.delegateId).toBe("u-grover");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("AC-ready deployed artifact routes to ac-validate/Astrid", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac2d-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: astrid\n    fills_roles: [steward]\n", "utf8");
    const ticket = {
      id: "id-ac",
      identifier: "INF-1304-AC",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "ac-validate", to: "ac-validate", comment: "deployed, AC ready" }],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("ac-validate");
      expect(res.delegateId).toBe("u-astrid");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── AC3: illegal routing targets must fail loudly ─────────────────────────

describe("INF-1304 AC3 — illegal routing targets fail loudly with legal owner roles", () => {
  it("recovering to an illegal delegate throws with expected legal owner roles", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac3-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n", "utf8");
    const ticket = {
      id: "id-bad",
      identifier: "INF-1304-BAD",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: "u-charles",
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    let threw = false;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
      await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "code-review", to: "code-review" }],
        // Simulate missing mapping for the legal body → candidate UUID unresolvable → illegal routing
        bodyIdToLinearUserId: () => null,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
    } catch (err) {
      threw = true;
      const msg = (err as Error).message;
      expect(msg).toMatch(/illegal.*routing|legal.*owner|expected.*owner/i);
      expect(msg).toMatch(/charles/i);
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(threw).toBe(true);
  });

  it("must not clear a valid delegate without a repair path when routing is illegal", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac3b-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n", "utf8");
    const ticket = {
      id: "id-preserve",
      identifier: "INF-1304-PRESERVE",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: "u-charles",
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    let fetchCallCount = 0;
    let clearedDelegate: string | null | undefined = undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      fetchCallCount++;
      const body = JSON.parse((init?.body as string) ?? "{}") as { variables?: Record<string, unknown> };
      if (body.variables?.["delegateId"] !== undefined) clearedDelegate = body.variables["delegateId"] as string | null;
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => {
          throw new Error("force illegal routing path");
        },
        bodyIdToLinearUserId: () => "u-tdd",
        labelNameToId: (name: string) => `uuid-${name}`,
      }).catch(() => {});
      // AC3 guarantee is structural: no write on failure → delegate never cleared.
      expect(fetchCallCount).toBe(0);
      expect(clearedDelegate).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("error message lists legal owner role candidates for the true state", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac3c-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: igor\n    fills_roles: [dev]\n  - id: sage\n    fills_roles: [dev]\n",
      "utf8",
    );
    let caught: Error | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      await mod.recoverXfnIntakeTicket(
        {
          id: "id-illegal",
          identifier: "INF-1304-ILLEGAL",
          labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
          delegateId: "u-igor",
          labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
          teamId: "team-test",
        },
        {
          authToken: "tok",
          workflowRegistry: makeRegistry(),
          capabilityPolicyPath: policyPath,
          fetchTicketHistory: async () => [{ state: "implementation", to: "implementation" }],
          // Missing mapping for the legal dev owners → candidate UUID unresolvable → illegal routing with legal owners listed
          bodyIdToLinearUserId: () => null,
          labelNameToId: (name: string) => `uuid-${name}`,
        },
      );
    } catch (e) {
      caught = e as Error;
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/dev|igor|sage/i);
  });
});

// ── AC4: 04:04Z watch regression shapes ───────────────────────────────────

describe("INF-1304 AC4 — regression coverage: INF-1292, INF-1281, INF-1277 shapes", () => {
  it("INF-1292 shape: xfn/intake residue with PR #704 ready routes to code-review/Charles", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-inf1292-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n  - id: astrid\n    fills_roles: [steward]\n", "utf8");
    const ticket = {
      id: "id-inf1292",
      identifier: "INF-1292",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow", "cross-functional-request"],
      delegateId: "u-astrid",
      labelNodes: [
        { id: "lbl-wf", name: "wf:dev-impl" },
        { id: "lbl-intake", name: "state:intake" },
        { id: "lbl-xfn", name: "xfn:workflow" },
      ],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [
          { state: "code-review", to: "code-review", comment: "PR #704 ready for review at 23:11Z — Grover" },
        ],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("code-review");
      expect(res.delegateId).toBe("u-charles");
      expect(res.action.toLowerCase()).toContain("code-review");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("INF-1281 shape: xfn/intake residue with PR #705 CI evidence routes to code-review/Charles", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-inf1281-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n  - id: astrid\n    fills_roles: [steward]\n", "utf8");
    const ticket = {
      id: "id-inf1281",
      identifier: "INF-1281",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: "u-astrid",
      labelNodes: [
        { id: "lbl-wf", name: "wf:dev-impl" },
        { id: "lbl-intake", name: "state:intake" },
      ],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [
          { state: "code-review", to: "code-review", comment: "PR #705 CI scope evidence at 23:18Z/23:36Z" },
        ],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("code-review");
      expect(res.delegateId).toBe("u-charles");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("INF-1277 shape: intake/write-tests residue with prior tests+impl done routes to implementation/Igor", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-inf1277-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: igor\n    fills_roles: [dev]\n  - id: tdd\n    fills_roles: [test-author]\n",
      "utf8",
    );
    const ticket = {
      id: "id-inf1277",
      identifier: "INF-1277",
      labels: ["wf:dev-impl", "state:write-tests"],
      delegateId: "u-tdd",
      labelNodes: [
        { id: "lbl-wf", name: "wf:dev-impl" },
        { id: "lbl-wt", name: "state:write-tests" },
      ],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [
          { state: "implementation", to: "implementation", comment: "PR #698 implementation done — tsc clean, needs rebase" },
          { state: "write-tests", to: "write-tests", comment: "tests written and handed off to Igor" },
        ],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.stateId).toBe("implementation");
      expect(res.delegateId).toBe("u-igor");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runRescueSweep integration: the three 04:04Z tickets are rescued to their true states in one sweep", async () => {
    const historyById = new Map<string, Array<{ state?: string; to?: string; comment?: string }>>([
      ["id-1292", [{ state: "code-review", to: "code-review", comment: "PR #704 ready" }]],
      ["id-1281", [{ state: "code-review", to: "code-review", comment: "PR #705 ready" }]],
      ["id-1277", [{ state: "implementation", to: "implementation", comment: "PR #698 rebase needed" }]],
    ]);
    const mock = makeLinearMock({
      issues: [
        { id: "id-1292", identifier: "INF-1292", labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], delegateId: "u-astrid" },
        { id: "id-1281", identifier: "INF-1281", labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], delegateId: "u-astrid" },
        { id: "id-1277", identifier: "INF-1277", labels: ["wf:dev-impl", "state:write-tests"], delegateId: "u-tdd" },
      ],
      historyById,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fetch;
    let res: Awaited<ReturnType<typeof runRescueSweep>>;
    try {
      res = await runRescueSweep({
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        operationalEventStore: { append: () => {} },
        labelNameToId: (name: string) => `uuid-${name}`,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const r1292 = res!.rescues.find((r) => r.identifier === "INF-1292");
    const r1281 = res!.rescues.find((r) => r.identifier === "INF-1281");
    const r1277 = res!.rescues.find((r) => r.identifier === "INF-1277");
    expect(r1292).toBeDefined();
    expect(r1292!.action.toLowerCase()).toContain("code-review");
    expect(r1281).toBeDefined();
    expect(r1281!.action.toLowerCase()).toContain("code-review");
    expect(r1277).toBeDefined();
    expect(r1277!.action.toLowerCase()).toContain("implementation");
  });
});

// ── AC5: watch/cron summary reports recovered true state and owner ─────────

describe("INF-1304 AC5 — watch/cron summary reports recovered true state and owner", () => {
  it("runRescueSweep rescues[].action reports the recovered true state, not just 'moved from intake'", async () => {
    const historyById = new Map<string, Array<{ state?: string; to?: string; comment?: string }>>([
      ["id-1292", [{ state: "code-review", to: "code-review", comment: "PR #704 ready" }]],
    ]);
    const mock = makeLinearMock({
      issues: [{ id: "id-1292", identifier: "INF-1292", labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], delegateId: "u-astrid" }],
      historyById,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fetch;
    try {
      const result = await runRescueSweep({
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        operationalEventStore: { append: () => {} },
        labelNameToId: (name: string) => `uuid-${name}`,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
      });
      const rescue = result.rescues.find((r) => r.identifier === "INF-1292");
      expect(rescue).toBeDefined();
      // Must mention the recovered true state and owner — not generic "moved from intake"
      expect(rescue!.action.toLowerCase()).toMatch(/code-review/);
      expect(rescue!.action.toLowerCase()).toMatch(/charles|u-charles|code-review/);
      expect(rescue!.action.toLowerCase()).not.toMatch(/^.*moved.*intake.*$/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("recoverXfnIntakeTicket action string includes recovered state and owner role", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ac5-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(policyPath, "bodies:\n  - id: charles\n    fills_roles: [code-review]\n", "utf8");
    const ticket = {
      id: "id-ac5",
      identifier: "INF-1304-AC5",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => [{ state: "code-review", to: "code-review" }],
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.action.toLowerCase()).toContain("code-review");
      expect(res.action.toLowerCase()).toMatch(/charles|code-review/);
      // Must NOT be a generic "moved xfn/intake residue" string
      expect(res.action.toLowerCase()).not.toBe("moved xfn/intake residue");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sweep summary distinguishes recovered true-position rescues from plain bootstraps", async () => {
    // Plain malformed must be old enough to exit the grace window, otherwise it is deferred not rescued
    const oldTs = new Date(Date.now() - 600_000).toISOString();
    const mock = makeLinearMock({
      issues: [
        { id: "id-truepos", identifier: "INF-1304-TRUE", labels: ["wf:dev-impl", "state:intake", "xfn:workflow"], delegateId: "u-astrid" },
        { id: "id-plain", identifier: "INF-1304-PLAIN", labels: ["wf:dev-impl"], delegateId: null, updatedAt: oldTs },
      ],
      historyById: new Map([
        ["id-truepos", [{ state: "code-review", to: "code-review", comment: "PR ready" }]],
        ["id-plain", []],
      ]),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fetch;
    try {
      const result = await runRescueSweep({
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        operationalEventStore: { append: () => {} },
        labelNameToId: (name: string) => `uuid-${name}`,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
      });
      const truePos = result.rescues.find((r) => r.identifier === "INF-1304-TRUE");
      const plain = result.rescues.find((r) => r.identifier === "INF-1304-PLAIN");
      expect(truePos).toBeDefined();
      expect(plain).toBeDefined();
      // True-position rescue action must name the recovered state
      expect(truePos!.action.toLowerCase()).toContain("code-review");
      // Plain bootstrap should mention intake/entry state
      expect(plain!.action.toLowerCase()).toMatch(/intake|bootstrap|entry.state/);
      // They must not be identical strings
      expect(truePos!.action).not.toBe(plain!.action);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── R3 REGRESSION: blocked/failed ledger poison ───────────────────────────

describe("INF-1304 R3 — ledger poisoned by blocked/failed attempts", () => {
  it("fetchLedgerHistory filters to status applied — blocked latest row not used as true position", async () => {
    const mod = await loadRecoveryModule() as unknown as {
      fetchLedgerHistory: (id: string, fn: (id: string) => Promise<Array<{ from: string | null; to: string | null; createdAt: string; status?: string }>>) => Promise<Array<{ to?: string; from?: string; createdAt: string }>>;
      resolveTruePosition: (ticket: { labels: string[] }, history: Array<{ to?: string; from?: string; createdAt: string }>) => { stateId: string; ownerRole: string } | null;
    };
    const ledgerRows = [
      { from: "intake", to: "implementation", createdAt: "2026-08-07T03:00:00.000Z", status: "applied" },
      { from: "implementation", to: "code-review", createdAt: "2026-08-07T04:00:00.000Z", status: "blocked" },
    ];
    const filtered = await mod.fetchLedgerHistory("id-ledger-poison", async () => ledgerRows);
    // Only the applied row should survive
    expect(filtered.length).toBe(1);
    expect(filtered[0].to).toBe("implementation");
    const pos = mod.resolveTruePosition({ labels: ["wf:dev-impl", "state:intake"] }, filtered as unknown as Parameters<typeof mod.resolveTruePosition>[1]);
    expect(pos).not.toBeNull();
    expect(pos!.stateId).toBe("implementation");
    expect(pos!.stateId).not.toBe("code-review");
  });

  it("recoverXfnIntakeTicket via fetchTransitionAudit with blocked latest entry does NOT route to blocked target", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-ledger-blocked-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: igor\n    fills_roles: [dev]\n  - id: charles\n    fills_roles: [code-review]\n",
      "utf8",
    );
    const ticket = {
      id: "id-ledger-blocked",
      identifier: "INF-1304-LEDGER",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    const ledgerRows = [
      { from: "intake", to: "implementation", createdAt: "2026-08-07T03:00:00.000Z", status: "applied" },
      { from: "implementation", to: "code-review", createdAt: "2026-08-07T04:00:00.000Z", status: "blocked" },
    ];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTransitionAudit: async () => ledgerRows,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
      });
      expect(res.recovered).toBe(true);
      expect(res.stateId).toBe("implementation");
      expect(res.delegateId).toBe("u-igor");
      expect(res.stateId).not.toBe("code-review");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── R3 REGRESSION: real Linear nested node shape + rollback ─────────────────

describe("INF-1304 R3 — real Linear history fallback (nested node shape + UUID fallback)", () => {
  it("resolveTruePosition via addedLabelIds UUID fallback resolves correct state and owner", async () => {
    const mod = await loadRecoveryModule();
    const labelIdToName = new Map<string, string>([["uuid-lbl-state-code-review", "state:code-review"]]);
    // Simulate real Linear node shape: toStateId is an opaque UUID (not parseable), addedLabelIds carries the state label UUID
    const history = [
      { toStateId: "uuid-state-opaque-1", addedLabelIds: ["uuid-lbl-state-code-review"], createdAt: "2026-08-07T03:00:00.000Z" } as unknown as Parameters<typeof mod.resolveTruePosition>[1][number],
    ];
    const pos = mod.resolveTruePosition({ labels: ["wf:dev-impl", "state:intake"] }, history, { labelIdToName } as unknown as Parameters<typeof mod.resolveTruePosition>[2]);
    expect(pos).not.toBeNull();
    expect(pos!.stateId).toBe("code-review");
    expect(pos!.ownerRole).toBe("code-review");
  });

  it("rollback sequence (code-review → implementation) via real nested shape + UUIDs: chronological-last wins not max-rank", async () => {
    const mod = await loadRecoveryModule();
    const labelIdToName = new Map<string, string>([
      ["uuid-lbl-state-code-review", "state:code-review"],
      ["uuid-lbl-state-implementation", "state:implementation"],
    ]);
    const history = [
      { toStateId: "uuid-state-opaque-cr", addedLabelIds: ["uuid-lbl-state-code-review"], createdAt: "2026-08-07T03:00:00.000Z" } as unknown as Parameters<typeof mod.resolveTruePosition>[1][number],
      { toStateId: "uuid-state-opaque-impl", addedLabelIds: ["uuid-lbl-state-implementation"], createdAt: "2026-08-07T04:00:00.000Z" } as unknown as Parameters<typeof mod.resolveTruePosition>[1][number],
    ];
    const pos = mod.resolveTruePosition({ labels: ["wf:dev-impl", "state:intake"] }, history, { labelIdToName } as unknown as Parameters<typeof mod.resolveTruePosition>[2]);
    expect(pos).not.toBeNull();
    // Chronological-last is implementation (04:00), even though code-review ranks higher in ORDER
    expect(pos!.stateId).toBe("implementation");
    expect(pos!.ownerRole).toBe("dev");
  });

  it("recoverXfnIntakeTicket with real nested Linear shape via labelIdToName routes correctly including rollback", async () => {
    const mod = await loadRecoveryModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1304-real-nested-"));
    const policyPath = path.join(tmpDir, "cap.yaml");
    fs.writeFileSync(
      policyPath,
      "bodies:\n  - id: igor\n    fills_roles: [dev]\n  - id: charles\n    fills_roles: [code-review]\n",
      "utf8",
    );
    const ticket = {
      id: "id-real-nested",
      identifier: "INF-1304-REAL",
      labels: ["wf:dev-impl", "state:intake", "xfn:workflow"],
      delegateId: null,
      labelNodes: [{ id: "lbl-wf", name: "wf:dev-impl" }, { id: "lbl-intake", name: "state:intake" }],
      teamId: "team-test",
    };
    // History mimics real Linear fetch: opaque UUIDs + addedLabelIds, with rollback: code-review at 03:00 then bounce-back to implementation at 04:00
    const historyWithUUIDs = [
      { toStateId: "uuid-state-opaque-cr", addedLabelIds: ["uuid-lbl-state-code-review"], createdAt: "2026-08-07T03:00:00.000Z" },
      { toStateId: "uuid-state-opaque-impl", addedLabelIds: ["uuid-lbl-state-implementation"], createdAt: "2026-08-07T04:00:00.000Z" },
    ];
    const labelIdToName = new Map<string, string>([
      ["uuid-lbl-state-code-review", "state:code-review"],
      ["uuid-lbl-state-implementation", "state:implementation"],
    ]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      const res = await mod.recoverXfnIntakeTicket(ticket, {
        authToken: "tok",
        workflowRegistry: makeRegistry(),
        capabilityPolicyPath: policyPath,
        fetchTicketHistory: async () => historyWithUUIDs as unknown as Array<{ from?: string; to?: string; state?: string; comment?: string; createdAt?: string }>,
        bodyIdToLinearUserId: (id: string) => `u-${id}`,
        labelNameToId: (name: string) => `uuid-${name}`,
        labelIdToName,
      } as unknown as Parameters<typeof mod.recoverXfnIntakeTicket>[1]);
      expect(res.recovered).toBe(true);
      expect(res.stateId).toBe("implementation");
      expect(res.delegateId).toBe("u-igor");
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Bootstrap wiring: xfn recovery component registered at startup ─────────

describe("INF-1304 bootstrap wiring — xfn-intake recovery is registered at server bootstrap", () => {
  it("index.ts imports the xfn-intake recovery wiring (static check)", async () => {
    const indexSrc = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "index.ts"), "utf8");
    const hasImport =
      indexSrc.includes("xfn-intake-recovery") ||
      indexSrc.includes("recoverXfnIntake") ||
      indexSrc.includes("resolveTruePosition");
    expect(hasImport).toBe(true);
  });
});
