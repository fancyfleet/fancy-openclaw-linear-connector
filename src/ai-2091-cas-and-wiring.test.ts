/**
 * AI-2091 — Dispatch integrity, part 2: stale-snapshot CAS + boot-path wiring.
 *
 * Companion to ai-2091-dispatch-integrity.test.ts (§1–§7). That file covers the
 * wrong-agent, phantom, mirror-purge, watchdog-restart, and one-wake-one-session
 * vectors as module-level regression fixtures. This file closes the two gaps
 * that the AC of record + the steward's AI-1808 addendum require and that §1–§7
 * do not reach:
 *
 *   §8  AI-2058 — stale-snapshot compare-and-swap. The umbrella's fourth scope
 *       clause: "re-reads ticket state before an agent commits a mutation to
 *       kill stale-snapshot overwrites." AI-2035 added a terminal re-entry guard
 *       for the Done→Doing bounce; AI-2058 generalizes it to a CAS re-read
 *       before ANY mutation commits. FAILING: the delivery-time CAS decision
 *       export does not exist yet.
 *
 *   §9  AI-1808 wiring addendum (Astrid, 2026-07-11T15:21:51Z — treated as part
 *       of the AC of record even though it post-dates capture). Each of the four
 *       dispatch-integrity gates must be reachable from the production dispatch
 *       path at server bootstrap and observable WITHOUT waiting for a live
 *       misroute. A module-level unit test of a gate in isolation does NOT
 *       satisfy this. This block boots the production app factory (createApp —
 *       the same factory src/index.ts's main() calls before app.listen) and
 *       asserts /health surfaces a `dispatchIntegrity` liveness block showing
 *       each gate active on the dispatch path. FAILING: /health exposes no
 *       dispatchIntegrity block today.
 *
 * The four gates keyed throughout (umbrella Scope + Igor's intake fixtures):
 *   G1 deliveryTimeRecipientResolution — wrong-agent  (AI-2042)
 *   G2 phantomFetchabilityGate         — unfetchable  (AI-2015 / AI-2034)
 *   G3 wakeSessionDedup                — duplicate    (AI-1774)
 *   G4 preMutationCAS                  — stale-snapshot (AI-2058)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, it, test, expect, beforeEach, afterEach } from "@jest/globals";

import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

// ── Tolerant loader for the delivery-time export the fix must add (AI-2091) ────
// Mirrors ai-2091-dispatch-integrity.test.ts so the suite stays collectable
// while the fix is unimplemented; the failure names the missing contract.
async function requireNewExport<T = (...args: unknown[]) => unknown>(
  modulePath: string,
  name: string,
): Promise<T> {
  const mod = (await import(modulePath)) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== "function") {
    throw new Error(
      `AI-2091: expected export \`${name}\` from ${modulePath} — not implemented yet. ` +
        `The dispatch-integrity fix must add it.`,
    );
  }
  return fn as T;
}

// ════════════════════════════════════════════════════════════════════════════
// §8 — AI-2058 stale-snapshot compare-and-swap (G4).
//      An agent authorizes a mutation against the delegate/state it snapshotted
//      at command start. If another actor changes the delegate or advances the
//      state mid-run, the mutation must be re-evaluated against CURRENT state
//      before it commits — not applied blindly against the stale snapshot.
// ════════════════════════════════════════════════════════════════════════════

interface CasDecision {
  proceed: boolean;
  reason?: string | null;
}

describe("§8 pre-mutation compare-and-swap (AI-2058)", () => {
  it("proceeds when the snapshot still matches current delegate + state", async () => {
    const assertMutationAgainstCurrentState = await requireNewExport(
      "./proxy.js",
      "assertMutationAgainstCurrentState",
    );

    const decision = (await assertMutationAgainstCurrentState({
      agent: "igor",
      ticketId: "AI-2091",
      snapshotDelegate: "igor",
      snapshotState: "implementation",
      currentDelegate: "igor",
      currentState: "implementation",
    })) as CasDecision;

    expect(decision.proceed).toBe(true);
  });

  it("rejects a mutation when the delegate changed mid-run (stale-snapshot overwrite)", async () => {
    const assertMutationAgainstCurrentState = await requireNewExport(
      "./proxy.js",
      "assertMutationAgainstCurrentState",
    );

    // Live instance called out on this very ticket: the session was dispatched on
    // a delegate=Igor snapshot that moved to tdd mid-run. A blind mutation would
    // overwrite the new delegate's decision.
    const decision = (await assertMutationAgainstCurrentState({
      agent: "igor",
      ticketId: "AI-2091",
      snapshotDelegate: "igor",
      snapshotState: "implementation",
      currentDelegate: "tdd",
      currentState: "write-tests",
    })) as CasDecision;

    expect(decision.proceed).toBe(false);
  });

  it("rejects a mutation when the state advanced mid-run (another actor already transitioned)", async () => {
    const assertMutationAgainstCurrentState = await requireNewExport(
      "./proxy.js",
      "assertMutationAgainstCurrentState",
    );

    // Same delegate, but the ticket already advanced past the snapshotted state
    // (e.g. a reviewer closed it during the run). The trailing mutation must not
    // re-apply off the stale source state.
    const decision = (await assertMutationAgainstCurrentState({
      agent: "astrid",
      ticketId: "AI-2091",
      snapshotDelegate: "astrid",
      snapshotState: "ac-validate",
      currentDelegate: "astrid",
      currentState: "done",
    })) as CasDecision;

    expect(decision.proceed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §9 — AI-1808 wiring addendum. Boot the production app factory and assert each
//      of the four gates is live + observable at /health, without waiting for a
//      real misroute. Module-level unit tests (§1–§8) do NOT satisfy this.
// ════════════════════════════════════════════════════════════════════════════

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai2091-wiring-"));
}

const SAMPLE_AGENT = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

describe("§9 dispatch-integrity gates are wired + observable at /health (AI-1808 addendum)", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = tempDir();
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [SAMPLE_AGENT] }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      idempotencyDbPath: path.join(dir, "idempotency.db"),
    });
  });

  afterEach(() => {
    appState?.bag?.close();
    appState?.sessionTracker?.close();
    appState?.agentQueue?.close();
    appState?.operationalEventStore?.close();
    appState?.idempotencyStore?.close();
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("/health exposes a dispatchIntegrity block", async () => {
    const res = await request(appState.app).get("/health");
    // Accept 200 (healthy) or 503 (degraded) — assert on fields, not status.
    expect(res.body.dispatchIntegrity).toBeDefined();
  });

  // One assertion per gate: `active === true` only because bootstrap wired the
  // gate onto the dispatch path — the AI-1808 dead-code-in-prod guard.
  test("G1 delivery-time recipient resolution (AI-2042) is active on the dispatch path", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.body.dispatchIntegrity?.deliveryTimeRecipientResolution?.active).toBe(true);
  });

  test("G2 phantom fetchability gate (AI-2015/AI-2034) is active on the dispatch path", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.body.dispatchIntegrity?.phantomFetchabilityGate?.active).toBe(true);
  });

  test("G3 wake→session dedup (AI-1774) is active on the dispatch path", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.body.dispatchIntegrity?.wakeSessionDedup?.active).toBe(true);
  });

  test("G4 pre-mutation compare-and-swap (AI-2058) is active on the dispatch path", async () => {
    const res = await request(appState.app).get("/health");
    expect(res.body.dispatchIntegrity?.preMutationCAS?.active).toBe(true);
  });
});
