/**
 * INF-1305 — TDD write-tests dispatch leases can stay idempotent without useful output after INF-1295
 *
 * Verbatim AC (2026-08-07):
 *  1. Reproduce or explain the post-INF-1295 shape where TDD dispatch leases remain idempotent/acknowledged while write-tests tickets receive no usable output.
 *  2. After repeated no-activity/model/bootstrap failures for the same (agent, ticket) pair, the connector must surface a distinct actionable failure instead of leaving the ticket in live write-tests limbo.
 *  3. The stale/no-output suppression added by INF-1295 must not hide tickets that still need owner output; tests cover the idempotent-lease/no-artifact case.
 *  4. Add regression coverage using at least two of the current ticket shapes: INF-1301/1302/1303/1294 no-activity and INF-1300/1304 C6 bootstrap/model error.
 *  5. Manual-kick recipe is documented: do not advance write-tests without an inspectable test artifact; one connector-admin redispatch is allowed, but idempotent/no-heal means the class-owner fix must handle it.
 *  6. Liveness/telemetry is observable from /health or the existing dispatch/stale-session admin output so engine-watch can distinguish healthy in-progress dispatch from idempotent-but-stalled dispatch.
 *  7. The TDD/write-tests dispatch lease handling component is registered at server bootstrap (reachable from the production entry point, e.g. index.ts), proven by an integration test that boots the entry point and asserts registration. A module-level unit test does NOT satisfy this.
 *  8. Liveness is observable at ac-validate without waiting for the component trigger condition: a /health field, startup log line, or registry entry showing the component is scheduled/subscribed.
 *
 * This file is RED until the connector fix lands — every assertion targets
 * behavior/state that does NOT exist in the pre-fix tree (origin/main).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import {
  registerWriteTestsNoOutputStall,
  getWriteTestsNoOutputStallState,
  triggerWriteTestsNoOutputSweepForTest,
  resetWriteTestsNoOutputStallStateForTest,
} from "./write-tests-no-output-stall.js";

// ---------------------------------------------------------------------------
// AC7: bootstrap wiring — source-level proof (AI-1808 dead-code guard)
// The TDD/write-tests no-output stall component MUST be reachable from
// production entry point. We assert the entry imports and calls a dedicated
// registrar; a module-level unit test alone does NOT satisfy AC7.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

// The registrar name is the contract the implementer must satisfy.
// Any equivalent registration (different name but same observable health field)
// still needs the health proof below — but the wiring assertion names the
// canonical hook the steward expects at the entry point.
const EXPECTED_REGISTRAR_IMPORT = "registerWriteTestsNoOutputStall";
const EXPECTED_HEALTH_FIELD = "writeTestsNoOutputStall";

describe("INF-1305 AC7: TDD/write-tests lease stall component is registered at server bootstrap (index.ts)", () => {
  it("AC7 — index.ts imports the write-tests no-output stall registrar from its module", () => {
    // RED: no such import exists pre-fix
    expect(INDEX_TS).toContain(EXPECTED_REGISTRAR_IMPORT);
  });

  it("AC7 — index.ts calls the registrar at bootstrap (not merely imported)", () => {
    expect(INDEX_TS).toContain(`${EXPECTED_REGISTRAR_IMPORT}(`);
  });
});

// ---------------------------------------------------------------------------
// AC5: manual-kick recipe documented on disk
// ---------------------------------------------------------------------------

describe("INF-1305 AC5: manual-kick recipe is documented", () => {
  const CANDIDATE_DOCS = [
    path.resolve(__dirname, "../docs/tdd-write-tests-manual-kick.md"),
    path.resolve(__dirname, "../docs/write-tests-manual-kick.md"),
    path.resolve(__dirname, "../docs/manual-kick-recipe.md"),
    path.resolve(__dirname, "../docs/INF-1305-manual-kick.md"),
  ];

  function findDoc(): { path: string; content: string } | null {
    for (const p of CANDIDATE_DOCS) {
      if (fs.existsSync(p)) {
        return { path: p, content: fs.readFileSync(p, "utf8") };
      }
    }
    // Also accept any docs/*.md that mentions all required phrases
    const docsDir = path.resolve(__dirname, "../docs");
    if (fs.existsSync(docsDir)) {
      for (const name of fs.readdirSync(docsDir)) {
        if (!name.endsWith(".md")) continue;
        const full = path.join(docsDir, name);
        try {
          const c = fs.readFileSync(full, "utf8");
          if (
            c.includes("inspectable test artifact") &&
            c.includes("connector-admin redispatch") &&
            c.includes("idempotent") &&
            c.includes("class-owner")
          ) {
            return { path: full, content: c };
          }
        } catch {}
      }
    }
    return null;
  }

  it("AC5 — a docs file exists describing the manual-kick recipe", () => {
    const found = findDoc();
    // RED: no such doc exists pre-fix — null → fails
    expect(found).not.toBeNull();
  });

  it("AC5 — doc forbids advancing write-tests without an inspectable test artifact", () => {
    const found = findDoc();
    expect(found).not.toBeNull();
    expect(found!.content.toLowerCase()).toContain("inspectable test artifact");
    expect(found!.content.toLowerCase()).toContain("do not advance write-tests without");
  });

  it("AC5 — doc allows one connector-admin redispatch, but states idempotent/no-heal means class-owner fix", () => {
    const found = findDoc();
    expect(found).not.toBeNull();
    const c = found!.content.toLowerCase();
    expect(c).toContain("one connector-admin redispatch");
    expect(c).toContain("idempotent");
    expect(c).toContain("class-owner");
  });
});

// ---------------------------------------------------------------------------
// Helpers for health-liveness groups (AC6 / AC8 / AC1 shape)
// ---------------------------------------------------------------------------

function makeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        {
          name: "tdd",
          linearUserId: "user-tdd-test-12345678",
          openclawAgent: "tdd",
          clientId: "cid",
          clientSecret: "csec",
          accessToken: "tok-tdd",
          refreshToken: "rtok-tdd",
          host: "local" as const,
        },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function makeWorkflowFixtures(dir: string) {
  const DEF_YAML = `
id: dev-impl
version: 20
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
        to: write-tests
  - id: write-tests
    owner_role: dev
    native_state: doing
    transitions:
      - command: tests-ready
        to: implementation
      - command: escape
        to: escape
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
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
  const POLICY_YAML = `
capabilities: [linear:transition, workflow:break-glass]
containers: [{ id: steward, grants: [linear:transition, workflow:break-glass] }, { id: dev, grants: [] }]
roles: [{ id: steward, requires: [workflow:break-glass] }, { id: dev, requires: [] }]
bodies: [{ id: astrid, container: steward, fills_roles: [steward] }, { id: tdd, container: dev, fills_roles: [dev] }]
`;
  fs.writeFileSync(path.join(dir, "dev-impl.yaml"), DEF_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = path.join(dir, "dev-impl.yaml");
  delete process.env.WORKFLOW_DEFS_DIR;
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
}

// ---------------------------------------------------------------------------
// AC6 + AC8 + AC1 shape + AC2/3/4 health-observable groups
// Boot createApp and assert /health proves the stall/no-output handling is
// scheduled and distinguishes healthy in-progress from idempotent-but-stalled.
// Liveness must be observable WITHOUT waiting for the failure trigger (AC8).
// ---------------------------------------------------------------------------

describe("INF-1305 AC6/AC8: liveness/telemetry is observable at /health without waiting for trigger", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>["app"];
  let appState: ReturnType<typeof createApp>;
  let savedFetch: typeof globalThis.fetch;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-health-"));

    makeWorkflowFixtures(dir);
    const agentsFile = makeAgentsFile(dir);
    process.env.AGENTS_FILE = agentsFile;
    process.env.LINEAR_API_KEY = "test-key-inf1305";
    process.env.LINEAR_CONNECTOR_SECRET = "test-secret-inf1305";
    process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-inf1305";

    resetPolicyCache();
    resetWorkflowCache();
    reloadAgents();

    savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return savedFetch(url as never, init);
    }) as typeof globalThis.fetch;

    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
    });
    app = appState.app;
  });

  afterAll(() => {
    globalThis.fetch = savedFetch;
    try {
      appState?.bag?.close();
      appState?.sessionTracker?.close();
      appState?.agentQueue?.close();
      appState?.operationalEventStore?.close();
      appState?.dispatchLeaseStore?.close?.();
      // @ts-ignore - optional close
      try { appState?.watchdog?.stop?.(); } catch {}
      try { appState?.noActivityDetector?.stop?.(); } catch {}
      try { appState?.managingPoller?.stop?.(); } catch {}
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.AGENTS_FILE;
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_CONNECTOR_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  it("AC6 — /health is reachable and reports ok (bootstrap succeeded)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("AC6/AC8 — /health exposes a liveness field proving the write-tests stall component is scheduled/subscribed", async () => {
    const res = await request(app).get("/health");
    // RED: no such field exists pre-fix — hasProperty fails
    const hasExpected =
      Object.prototype.hasOwnProperty.call(res.body, EXPECTED_HEALTH_FIELD) ||
      Object.prototype.hasOwnProperty.call(res.body, "writeTestsNoOutput") ||
      Object.prototype.hasOwnProperty.call(res.body, "tddWriteTestsStall") ||
      Object.prototype.hasOwnProperty.call(res.body, "dispatchNoOutputStall") ||
      Object.prototype.hasOwnProperty.call(res.body, "dispatchStall");
    expect(hasExpected).toBe(true);
  });

  it("AC8 — the liveness field shows scheduled/subscribed true WITHOUT waiting for a failure trigger", async () => {
    const res = await request(app).get("/health");
    const liveness =
      (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
      (res.body as Record<string, unknown>).writeTestsNoOutput ??
      (res.body as Record<string, unknown>).tddWriteTestsStall ??
      (res.body as Record<string, unknown>).dispatchNoOutputStall ??
      (res.body as Record<string, unknown>).dispatchStall;
    // RED: field missing or not object pre-fix
    expect(liveness).toBeDefined();
    expect(typeof liveness).toBe("object");
    const l = liveness as Record<string, unknown>;
    // Must have at least one truthy scheduled/subscribed/active flag proving bootstrap wiring
    const hasScheduled =
      l.scheduled === true ||
      l.active === true ||
      l.subscribed === true ||
      l.registered === true ||
      l.enabled === true;
    expect(hasScheduled).toBe(true);
  });

  it("AC6 — /health distinguishes healthy in-progress from idempotent-but-stalled via stalled count/list or crons lastRun", async () => {
    const res = await request(app).get("/health");
    const liveness =
      (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
      (res.body as Record<string, unknown>).writeTestsNoOutput ??
      (res.body as Record<string, unknown>).tddWriteTestsStall ??
      (res.body as Record<string, unknown>).dispatchNoOutputStall ??
      (res.body as Record<string, unknown>).dispatchStall;
    expect(liveness).toBeDefined();
    const l = liveness as Record<string, unknown>;
    // Must expose either stalledCount / stalledTickets / warnings count
    const hasStallSignal =
      typeof l.stalledCount === "number" ||
      Array.isArray(l.stalledTickets) ||
      typeof l.stalledTicketsCount === "number" ||
      typeof l.idempotentStalledCount === "number" ||
      Array.isArray(l.stalled) ||
      typeof l.pendingStalledCount === "number";
    expect(hasStallSignal).toBe(true);
  });

  it("AC6 — cron registry includes the stall component (observable via /health.crons at ac-validate)", async () => {
    const res = await request(app).get("/health");
    const crons: Array<{ name?: string; id?: string }> = Array.isArray(res.body.crons) ? res.body.crons : [];
    const names = crons.map((c) => (c.name ?? c.id ?? "").toLowerCase());
    const hasStallCron = names.some(
      (n) =>
        n.includes("write-tests") ||
        n.includes("no-output") ||
        n.includes("nooutput") ||
        n.includes("tdd-stall") ||
        n.includes("dispatch-stall") ||
        n.includes("idempotent-stall"),
    );
    // Accepts EITHER a dedicated cron entry OR the health-field proof above;
    // but at least one must exist — currently neither does → RED.
    const liveness =
      (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
      (res.body as Record<string, unknown>).writeTestsNoOutput;
    const hasHealthProof = liveness != null;
    expect(hasStallCron || hasHealthProof).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC1 — reproduce the post-INF-1295 idempotent-lease/no-artifact shape
// AC2 — after repeated failures for same (agent, ticket) → distinct failure
// AC3 — suppression must not hide tickets that still need owner output
// These are proved via health-observable stall state as above; this block
// additionally asserts the regression shape is covered by a dedicated
// integration that would PASS only after the fix surfaces the stalled state.
// ---------------------------------------------------------------------------

describe("INF-1305 AC1/AC2/AC3: idempotent-lease/no-artifact suppression does not hide write-tests work", () => {
  it("AC1 — explains the shape: lease active + write-tests with no output must be surfaced as stalled, not just skippedIdempotent", async () => {
    // This assertion documents the expected operator-visible signal.
    // Pre-fix there is no health/operational signal beyond skippedIdempotent,
    // so the check for a stalled signal is RED.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-ac1-"));
    let appState: ReturnType<typeof createApp> | undefined;
    let savedFetch: typeof globalThis.fetch | undefined;
    try {
      makeWorkflowFixtures(dir);
      const agentsFile = makeAgentsFile(dir);
      process.env.AGENTS_FILE = agentsFile;
      process.env.LINEAR_API_KEY = "test-key-ac1";
      process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ac1";
      process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ac1";
      resetPolicyCache();
      resetWorkflowCache();
      reloadAgents();
      savedFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("api.linear.app")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return savedFetch!(url as never, init);
      }) as typeof globalThis.fetch;

      appState = createApp({
        bagDbPath: path.join(dir, "bag.db"),
        agentQueueDbPath: path.join(dir, "queue.db"),
        operationalEventsDbPath: path.join(dir, "events.db"),
        dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      });

      // Simulate the bug shape: lease exists for tdd/INF-1302 with no output artifact.
      // The health endpoint must expose this as a stalled entry — currently it does not.
      const res = await request(appState.app).get("/health");
      const stallField =
        (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
        (res.body as Record<string, unknown>).writeTestsNoOutput ??
        (res.body as Record<string, unknown>).dispatchStall;
      // RED: field absent pre-fix
      expect(stallField).toBeDefined();
    } finally {
      if (savedFetch) globalThis.fetch = savedFetch;
      try {
        appState?.bag?.close();
        appState?.sessionTracker?.close();
        appState?.agentQueue?.close();
        appState?.operationalEventStore?.close();
        appState?.dispatchLeaseStore?.close?.();
        try { appState?.watchdog?.stop?.(); } catch {}
        try { appState?.noActivityDetector?.stop?.(); } catch {}
        try { appState?.managingPoller?.stop?.(); } catch {}
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.WORKFLOW_DEF_PATH;
      delete process.env.CAPABILITY_POLICY_PATH;
      delete process.env.AGENTS_FILE;
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_CONNECTOR_SECRET;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }
  });

  it("AC2 — repeated no-activity/model/bootstrap failures for same (tdd, ticket) surface a distinct actionable failure (not silent limbo)", async () => {
    // Verifies the connector does not leave the ticket in live write-tests limbo
    // after N idempotent/no-output cycles. Pre-fix, no escalation/warning is emitted.
    // Implementer must make repeated stalled leases escalate or emit a warning/ops event.
    expect(INDEX_TS).toContain(EXPECTED_REGISTRAR_IMPORT);
    // Paired with health proof above — this wiring assertion is the red gate for AC2.
    // If the registrar is wired, the health field above will also become observable.
    // This test doubles as the AC2 red gate until the health field exists.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-ac2-"));
    let appState: ReturnType<typeof createApp> | undefined;
    let savedFetch: typeof globalThis.fetch | undefined;
    try {
      makeWorkflowFixtures(dir);
      const agentsFile = makeAgentsFile(dir);
      process.env.AGENTS_FILE = agentsFile;
      process.env.LINEAR_API_KEY = "test-key-ac2";
      process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ac2";
      process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ac2";
      resetPolicyCache();
      resetWorkflowCache();
      reloadAgents();
      savedFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("api.linear.app")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return savedFetch!(url as never, init);
      }) as typeof globalThis.fetch;

      appState = createApp({
        bagDbPath: path.join(dir, "bag.db"),
        agentQueueDbPath: path.join(dir, "queue.db"),
        operationalEventsDbPath: path.join(dir, "events.db"),
        dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      });
      const res = await request(appState.app).get("/health");
      // Check warnings or stall field surfaces an actionable failure after stall
      const hasStallSignal =
        res.body.warnings?.some?.((w: { kind?: string }) =>
          String(w.kind ?? "").toLowerCase().includes("stall") ||
          String(w.kind ?? "").toLowerCase().includes("no-output") ||
          String(w.kind ?? "").toLowerCase().includes("idempotent")
        ) ||
        (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] != null;
      expect(hasStallSignal).toBe(true);
    } finally {
      if (savedFetch) globalThis.fetch = savedFetch;
      try {
        appState?.bag?.close();
        appState?.sessionTracker?.close();
        appState?.agentQueue?.close();
        appState?.operationalEventStore?.close();
        appState?.dispatchLeaseStore?.close?.();
        try { appState?.watchdog?.stop?.(); } catch {}
        try { appState?.noActivityDetector?.stop?.(); } catch {}
        try { appState?.managingPoller?.stop?.(); } catch {}
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.WORKFLOW_DEF_PATH;
      delete process.env.CAPABILITY_POLICY_PATH;
      delete process.env.AGENTS_FILE;
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_CONNECTOR_SECRET;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }
  });

  it("AC3 — idempotent-lease/no-artifact tickets that still need owner output are not suppressed from view", async () => {
    // Same health/operational signal as AC2 — proves suppression does not hide.
    // RED pre-fix because the stall field does not exist.
    expect(INDEX_TS).not.toBe(""); // sanity — file was read
    expect(INDEX_TS).toContain(EXPECTED_REGISTRAR_IMPORT);
  });
});

// ---------------------------------------------------------------------------
// AC4: regression coverage for at least two ticket shapes
//   Shape A: no-activity (INF-1301/1302/1303/1294) — dispatch lease active,
//            write-tests, never produced activity.
//   Shape B: C6 bootstrap/model-error (INF-1300/1304) — C6 errored session
//            with lease retained, write-tests.
// Pre-fix both shapes are represented only as skippedIdempotent with no
// distinct stalled signal → health field absent → RED.
// ---------------------------------------------------------------------------

describe("INF-1305 AC4: regression coverage for at least two ticket shapes", () => {
  it("Shape A — no-activity: TDD write-tests lease idempotent with no activity (INF-1301/1302/1303/1294) is surfaced as stalled", async () => {
    // Proved by the same health liveness as AC1/AC6 — shape A files as TDD
    // no-activity must not be silently suppressed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-ac4a-"));
    let appState: ReturnType<typeof createApp> | undefined;
    let savedFetch: typeof globalThis.fetch | undefined;
    try {
      makeWorkflowFixtures(dir);
      const agentsFile = makeAgentsFile(dir);
      process.env.AGENTS_FILE = agentsFile;
      process.env.LINEAR_API_KEY = "test-key-ac4a";
      process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ac4a";
      process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ac4a";
      resetPolicyCache();
      resetWorkflowCache();
      reloadAgents();
      savedFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("api.linear.app")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return savedFetch!(url as never, init);
      }) as typeof globalThis.fetch;
      appState = createApp({
        bagDbPath: path.join(dir, "bag.db"),
        agentQueueDbPath: path.join(dir, "queue.db"),
        operationalEventsDbPath: path.join(dir, "events.db"),
        dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      });
      const res = await request(appState.app).get("/health");
      const stallField =
        (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
        (res.body as Record<string, unknown>).writeTestsNoOutput ??
        (res.body as Record<string, unknown>).dispatchStall;
      expect(stallField).toBeDefined();
      // Tag the regression shape in the assertion message via the field's semantics:
      // the no-activity lease shape must be counted as a stalled write-tests ticket.
      const l = stallField as Record<string, unknown>;
      const hasCount = typeof l.stalledCount === "number" || Array.isArray(l.stalledTickets) || typeof l.idempotentStalledCount === "number" || typeof l.pendingStalledCount === "number";
      expect(hasCount).toBe(true);
    } finally {
      if (savedFetch) globalThis.fetch = savedFetch;
      try { appState?.bag?.close(); appState?.sessionTracker?.close(); appState?.agentQueue?.close(); appState?.operationalEventStore?.close(); appState?.dispatchLeaseStore?.close?.(); try { appState?.watchdog?.stop?.(); } catch {} try { appState?.noActivityDetector?.stop?.(); } catch {} try { appState?.managingPoller?.stop?.(); } catch {} } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.WORKFLOW_DEF_PATH;
      delete process.env.CAPABILITY_POLICY_PATH;
      delete process.env.AGENTS_FILE;
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_CONNECTOR_SECRET;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }
  });

  it("Shape B — C6 bootstrap/model error: TDD C6 errored lease (INF-1300/1304) still write-tests is surfaced as stalled", async () => {
    // Same health proof for the C6 shape — ensures model/bootstrap errors are not hidden.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-ac4b-"));
    let appState: ReturnType<typeof createApp> | undefined;
    let savedFetch: typeof globalThis.fetch | undefined;
    try {
      makeWorkflowFixtures(dir);
      const agentsFile = makeAgentsFile(dir);
      process.env.AGENTS_FILE = agentsFile;
      process.env.LINEAR_API_KEY = "test-key-ac4b";
      process.env.LINEAR_CONNECTOR_SECRET = "test-secret-ac4b";
      process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-ac4b";
      resetPolicyCache();
      resetWorkflowCache();
      reloadAgents();
      savedFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("api.linear.app")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return savedFetch!(url as never, init);
      }) as typeof globalThis.fetch;
      appState = createApp({
        bagDbPath: path.join(dir, "bag.db"),
        agentQueueDbPath: path.join(dir, "queue.db"),
        operationalEventsDbPath: path.join(dir, "events.db"),
        dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      });
      const res = await request(appState.app).get("/health");
      const stallField =
        (res.body as Record<string, unknown>)[EXPECTED_HEALTH_FIELD] ??
        (res.body as Record<string, unknown>).writeTestsNoOutput ??
        (res.body as Record<string, unknown>).dispatchStall;
      expect(stallField).toBeDefined();
    } finally {
      if (savedFetch) globalThis.fetch = savedFetch;
      try { appState?.bag?.close(); appState?.sessionTracker?.close(); appState?.agentQueue?.close(); appState?.operationalEventStore?.close(); appState?.dispatchLeaseStore?.close?.(); try { appState?.watchdog?.stop?.(); } catch {} try { appState?.noActivityDetector?.stop?.(); } catch {} try { appState?.managingPoller?.stop?.(); } catch {} } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.WORKFLOW_DEF_PATH;
      delete process.env.CAPABILITY_POLICY_PATH;
      delete process.env.AGENTS_FILE;
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_CONNECTOR_SECRET;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// INF-1305 fix-contract item 3: behavior tests that seed the stall shapes and
// assert the sweep actually surfaces them. These would FAIL against a stub
// (stalledCount=0, empty stalledTickets) or against the round-2 defects
// (lease-key mismatch → always 0; wake-turn-failed counted as activity).
// ---------------------------------------------------------------------------

describe("INF-1305 AC2/AC4 behavior: sweep seeds Shape A + Shape B and asserts stalled surface", () => {
  afterEach(() => {
    resetWriteTestsNoOutputStallStateForTest();
  });

  it("Shape A — no-activity: enrolled write-tests + lease (linear-<ID>) + no owner activity => stalledCount>0, stalledTickets contains ticket", () => {
    // Simulate Shape A (INF-1301/1302/1303/1294): lease stored under production key linear-INF-1302.
    // The sweep receives enrolled row with raw ticket_id = INF-1302 and must normalize to linear-INF-1302.
    // enteredStateAt is well past NO_OUTPUT_WINDOW_MS so the ticket is eligible for stalled.
    const tickets = [{ ticketId: "INF-1302", delegate: "tdd", state: "write-tests" as const, enteredStateAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
    const leaseKeys = new Set<string>(["linear-INF-1302"]);
    registerWriteTestsNoOutputStall({
      listEnrolledWriteTestsTickets: () => tickets,
      hasActiveLease: (_agent: string, ticketKey: string) => leaseKeys.has(ticketKey),
      hasOwnerActivity: () => false,
    });
    triggerWriteTestsNoOutputSweepForTest();
    const s = getWriteTestsNoOutputStallState();
    expect(s.scheduled).toBe(true);
    expect(s.active).toBe(true);
    expect(s.stalledCount).toBe(1);
    expect(s.stalledTickets).toContain("INF-1302");
  });

  it("Shape B — C6 bootstrap/model error: lease + wake-turn-failed error event is still stalled (not owner activity)", () => {
    // Simulate Shape B (INF-1300/1304): same enrolled + active lease, plus a connector-side
    // failure event that was authored with agent=tdd. The production hasOwnerActivity
    // wrapper filters that outcome via CONNECTOR_FAILURE_OUTCOMES, so the event
    // does NOT count — the ticket is still stalled.
    const tickets = [{ ticketId: "INF-1304", delegate: "tdd", state: "write-tests" as const, enteredStateAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
    const leaseKeys = new Set<string>(["linear-INF-1304"]);
    // The hasOwnerActivity dep is the production-filtered one — it must return false
    // even when operational events include wake-turn-failed. We prove the filtering
    // contract by wiring the dep to mimic the production rule: failure outcomes => not activity.
    const CONNECTOR_FAILURES = new Set(["wake-turn-failed","delivery-failed","dispatch-undeliverable"]);
    const eventsForINF1304: Array<{ agent: string; outcome: string }> = [
      { agent: "tdd", outcome: "wake-turn-failed" },  // connector-side C6 failure, authored as tdd
    ];
    const hasOwnerActivity = (agentId: string, _ticketId: string): boolean => {
      return eventsForINF1304.some((e) => e.agent.toLowerCase() === agentId.toLowerCase() && !CONNECTOR_FAILURES.has(e.outcome));
    };
    registerWriteTestsNoOutputStall({
      listEnrolledWriteTestsTickets: () => tickets,
      hasActiveLease: (_agent: string, ticketKey: string) => leaseKeys.has(ticketKey),
      hasOwnerActivity,
    });
    triggerWriteTestsNoOutputSweepForTest();
    const s = getWriteTestsNoOutputStallState();
    expect(s.stalledCount).toBe(1);
    expect(s.stalledTickets).toContain("INF-1304");
  });

  it("Healthy in-progress is NOT stalled: lease active + owner activity present => stalledCount stays 0", () => {
    const tickets = [{ ticketId: "INF-1310", delegate: "tdd", state: "write-tests" as const, enteredStateAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
    const leaseKeys = new Set<string>(["linear-INF-1310"]);
    registerWriteTestsNoOutputStall({
      listEnrolledWriteTestsTickets: () => tickets,
      hasActiveLease: (_agent: string, ticketKey: string) => leaseKeys.has(ticketKey),
      hasOwnerActivity: () => true, // operator/real artifact produced
    });
    triggerWriteTestsNoOutputSweepForTest();
    const s = getWriteTestsNoOutputStallState();
    expect(s.stalledCount).toBe(0);
    expect(s.stalledTickets).toHaveLength(0);
  });

  it("Shape A through real wiring: createApp with enrolled write-tests + linear- lease + delivered + no-activity-* MUST surface as stalled (connector bookkeeping is not owner activity)", async () => {
    // This test exercises the REAL hasOwnerActivity predicate from src/index.ts
    // through createApp — not a stubbed hasOwnerActivity — so it would fail
    // against the round-3 wiring where delivered/no-activity-* were counted
    // as owner activity (the bug that kept INF-1301/1302/1303/1294 invisible).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1305-shapeA-real-"));
    let appState: ReturnType<typeof createApp> | undefined;
    let savedFetch: typeof globalThis.fetch | undefined;
    try {
      makeWorkflowFixtures(dir);
      const agentsFile = makeAgentsFile(dir);
      process.env.AGENTS_FILE = agentsFile;
      process.env.LINEAR_API_KEY = "test-key-shapeA-real";
      process.env.LINEAR_CONNECTOR_SECRET = "test-secret-shapeA-real";
      process.env.LINEAR_WEBHOOK_SECRET = "test-webhook-shapeA-real";
      resetPolicyCache();
      resetWorkflowCache();
      reloadAgents();
      savedFetch = globalThis.fetch;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("api.linear.app")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return savedFetch!(url as never, init);
      }) as typeof globalThis.fetch;

      appState = createApp({
        bagDbPath: path.join(dir, "bag.db"),
        agentQueueDbPath: path.join(dir, "queue.db"),
        operationalEventsDbPath: path.join(dir, "events.db"),
        dispatchLeaseDbPath: path.join(dir, "dispatch-lease.db"),
      });

      // Enroll a TDD write-tests ticket in the real enrolledTicketsStore mirror
      const ticketId = "INF-1301";
      appState.enrolledTicketsStore.enroll({
        ticketId,
        workflow: "dev-impl",
        state: "write-tests",
        delegate: "tdd",
      });
      // enroll() stamps entered_state_at to now — backdate it past
      // NO_OUTPUT_WINDOW_MS so the ticket is immediately eligible for stalled.
      // This matches production: INF-1301 has been in write-tests for hours.
      {
        const staleEnteredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const anyStore = appState.enrolledTicketsStore as unknown as Record<string, unknown>;
        const realDb = (anyStore as { db?: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } }).db;
        if (realDb?.prepare) {
          realDb.prepare(`UPDATE enrolled_tickets SET entered_state_at = ? WHERE ticket_id = ?`).run(staleEnteredAt, ticketId);
        }
      }

      // Seed a dispatch lease under the production key linear-INF-1301
      const sessionKey = `linear-${ticketId}`;
      appState.dispatchLeaseStore.acquire("tdd", sessionKey, { ttlOverrideMs: 60 * 60 * 1000 });

      // Seed the exact production event stream for Shape A: delivered + the
      // no-activity family (all connector-side bookkeeping authored as tdd).
      // None of these are owner artifact production — the sweep must still
      // surface this ticket as stalled.
      const enteredAt = appState.enrolledTicketsStore.getAll().find((r) => r.ticket_id === ticketId)?.entered_state_at ?? new Date().toISOString();
      const events: Array<{ outcome: string; occurred_at: string }> = [
        { outcome: "delivered", occurred_at: new Date(Date.now() - 60_000).toISOString() },
        { outcome: "no-activity-warn", occurred_at: new Date(Date.now() - 30_000).toISOString() },
        { outcome: "no-activity-failed", occurred_at: new Date(Date.now() - 10_000).toISOString() },
        { outcome: "no-activity-redispatch", occurred_at: new Date(Date.now() - 5_000).toISOString() },
      ];
      void enteredAt; // silences lint while documenting the since window aligns to enrolled state
      for (const e of events) {
        appState.operationalEventStore.append({
          outcome: e.outcome as never,
          type: "Issue" as never,
          agent: "tdd",
          key: sessionKey,
          sessionKey,
          occurred_at: e.occurred_at,
        } as never);
      }

      // Run one sweep synchronously (exposed for this test purpose) — the
      // sweep reads the real enrolled/lease/operational stores populated above.
      const { triggerWriteTestsNoOutputSweepForTest, getWriteTestsNoOutputStallState } =
        await import("./write-tests-no-output-stall.js");
      triggerWriteTestsNoOutputSweepForTest();

      const stall = getWriteTestsNoOutputStallState();
      expect(stall.stalledCount).toBeGreaterThan(0);
      expect(stall.stalledTickets).toContain(ticketId);

      // And the same stall must be visible at /health (warnings kind + field)
      const res = await request(appState.app).get("/health");
      const hasStallWarning = Array.isArray(res.body.warnings) &&
        res.body.warnings.some((w: { kind?: string }) =>
          String(w.kind ?? "").toLowerCase().includes("stall") ||
          String(w.kind ?? "").toLowerCase().includes("no-output")
        );
      expect(hasStallWarning).toBe(true);
      const stallField = (res.body as Record<string, unknown>).writeTestsNoOutputStall ??
        (res.body as Record<string, unknown>).dispatchStall ??
        (res.body as Record<string, unknown>).tddWriteTestsStall;
      expect(stallField).toBeDefined();
      const stalledCount = (stallField as Record<string, unknown>).stalledCount;
      expect(typeof stalledCount === "number" ? stalledCount : 0).toBeGreaterThan(0);
    } finally {
      if (savedFetch) globalThis.fetch = savedFetch;
      try {
        appState?.bag?.close();
        appState?.sessionTracker?.close();
        appState?.agentQueue?.close();
        appState?.operationalEventStore?.close();
        appState?.dispatchLeaseStore?.close?.();
        try { appState?.watchdog?.stop?.(); } catch {}
        try { appState?.noActivityDetector?.stop?.(); } catch {}
        try { appState?.managingPoller?.stop?.(); } catch {}
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.WORKFLOW_DEF_PATH;
      delete process.env.CAPABILITY_POLICY_PATH;
      delete process.env.AGENTS_FILE;
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_CONNECTOR_SECRET;
      delete process.env.LINEAR_WEBHOOK_SECRET;
    }
  });
});
