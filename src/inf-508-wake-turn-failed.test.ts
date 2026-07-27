/**
 * INF-508 — loud diagnostics for silent dispatch-wake failures, end to end.
 *
 * The follow-up from INF-506: when a connector dispatch is accepted by a gateway
 * but the hook turn errors before first activity (context overflow on a
 * tiny-context primary), the first-action watchdog used to surface only a generic
 * "unreachable". This suite proves the full path now surfaces the real cause:
 *
 *   1. deliver-with-ack captures a failed attempt's gateway error and emits a
 *      structured `wake-turn-failed` operational event (AC1 — admin-visible record).
 *   2. resolveStallReason turns that into a WAKE_TURN_FAILED StallReason carrying
 *      the diagnostic.
 *   3. the first-action watchdog reads the reason, SKIPS the pointless re-wake,
 *      and alerts with the resolved model / error class / gateway / fallback-skip
 *      instead of "unreachable" (AC2).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { deliverWithAck } from "./delivery/deliver-with-ack.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";
import type { DeliveryResult } from "./delivery/deliver.js";

import {
  StallReasonCode,
  resolveStallReason,
  type StallResolverDeps,
  type WakeFailureDiagnostic,
} from "./wake-observability/index.js";
import { classifyWakeFailure, WakeFailureClass } from "./wake-observability/wake-failure-diagnostic.js";

import {
  runFirstActionWatchdogSweep,
  type FirstActionWatchdogOptions,
  type UnreachableAlert,
} from "./first-action-watchdog.js";
import { resetFirstActionWatchdogStateForTest } from "./first-action-watchdog-state.js";

// The authoritative gateway overflow line (see wake-failure-diagnostic.test.ts).
const OVERFLOW_SIGNAL =
  "[context-overflow-precheck] pre-prompt check sessionKey=agent:igor:linear-INF-504 " +
  "provider=ollama/gemma4:31b route=primary estimatedPromptTokens=20044 pressureSource=estimate " +
  "promptBudgetBeforeReserve=12768 overflowTokens=7276 reserveTokens=1024 messages=3 sessionFile=/x";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `inf-508-${prefix}-`));
}

describe("INF-508: silent wake-failure diagnostics", () => {
  let dir: string;
  let eventStore: OperationalEventStore;
  let ackTracker: DispatchAckTracker;

  beforeEach(() => {
    dir = tmpDir("e2e");
    eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    ackTracker = new DispatchAckTracker(path.join(dir, "acks.db"));
    resetFirstActionWatchdogStateForTest();
  });

  afterEach(() => {
    eventStore.close();
    ackTracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1: deliver-with-ack emits a structured wake-turn-failed event ──
  it("AC1 — a context-overflow delivery failure is recorded as a structured wake-turn-failed event", async () => {
    const OVERFLOW_FAIL: DeliveryResult = {
      dispatched: false,
      hookError: true,
      rawResponse: { ok: false, error: OVERFLOW_SIGNAL },
      hookErrorSummary: OVERFLOW_SIGNAL,
    };

    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "INF-504",
      workflowState: "implementation",
      gateway: "dev",
      dispatchId: "disp-overflow-1",
      deliver: async () => OVERFLOW_FAIL,
      eventStore,
      ackTracker,
      maxRetries: 0,
      sleep: async () => {},
    });
    expect(outcome.status).toBe("undeliverable");

    const events = eventStore.query({ key: "linear-INF-504", outcome: "wake-turn-failed", limit: 10 });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const diag = (events[0].detail as { diagnostic?: WakeFailureDiagnostic }).diagnostic!;
    expect(diag.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(diag.resolvedProvider).toBe("ollama");
    expect(diag.resolvedModel).toBe("gemma4:31b");
    expect(diag.gateway).toBe("dev");
    expect(diag.fallbackSkipped).toBe(true);
    expect(events[0].errorSummary).toMatch(/context-overflow/i);
  });

  it("AC1c — a 200-OK /v1 overflow (delivered, but overflow in the reply body) still emits a diagnostic", async () => {
    // The live silent-wake signature: the gateway ACCEPTS the dispatch (dispatched:true)
    // and returns a 200-OK completion whose assistant content is the overflow message.
    const V1_OVERFLOW_DELIVERED: DeliveryResult = {
      dispatched: true,
      runId: "chatcmpl_live",
      rawResponse: {
        id: "chatcmpl_live",
        choices: [{ index: 0, message: { role: "assistant", content: "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    };

    const outcome = await deliverWithAck({
      agentId: "tdd",
      ticketId: "DSN-5",
      workflowState: "write-tests",
      gateway: "dev",
      dispatchId: "disp-v1-overflow-1",
      resolvedModelHint: "ollama/gemma4:31b",
      deliver: async () => V1_OVERFLOW_DELIVERED,
      eventStore,
      ackTracker,
      maxRetries: 0,
      sleep: async () => {},
    });
    // Delivery still reports "delivered" — the ack/retry contract is unchanged.
    expect(outcome.status).toBe("delivered");

    // ...but the silent turn failure was captured as a structured diagnostic.
    const events = eventStore.query({ key: "linear-DSN-5", outcome: "wake-turn-failed", limit: 10 });
    expect(events.length).toBe(1);
    const diag = (events[0].detail as { diagnostic?: WakeFailureDiagnostic }).diagnostic!;
    expect(diag.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(diag.fallbackSkipped).toBe(true);
    expect(diag.resolvedModel).toBe("gemma4:31b"); // from the hint — content has no provider= token
  });

  it("AC1d — a genuine delivered turn (real reply, prompt tokens spent) emits NO diagnostic", async () => {
    const CLEAN_DELIVERED: DeliveryResult = {
      dispatched: true,
      runId: "chatcmpl_clean",
      rawResponse: {
        id: "chatcmpl_clean",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5120, completion_tokens: 1, total_tokens: 5121 },
      },
    };
    await deliverWithAck({
      agentId: "igor",
      ticketId: "INF-900",
      workflowState: "implementation",
      gateway: "dev",
      dispatchId: "disp-clean-1",
      deliver: async () => CLEAN_DELIVERED,
      eventStore,
      ackTracker,
      maxRetries: 0,
      sleep: async () => {},
    });
    const events = eventStore.query({ key: "linear-INF-900", outcome: "wake-turn-failed", limit: 10 });
    expect(events.length).toBe(0);
  });

  it("AC1b — a silent miss (no gateway error text) emits NO wake-turn-failed event", async () => {
    const SILENT_MISS: DeliveryResult = { dispatched: false }; // pendingAck-less, no error
    await deliverWithAck({
      agentId: "igor",
      ticketId: "INF-777",
      workflowState: "implementation",
      gateway: "dev",
      dispatchId: "disp-silent-1",
      deliver: async () => SILENT_MISS,
      eventStore,
      ackTracker,
      maxRetries: 0,
      sleep: async () => {},
    });
    const events = eventStore.query({ key: "linear-INF-777", outcome: "wake-turn-failed", limit: 10 });
    expect(events.length).toBe(0); // WAKE_NOT_DELIVERED / SESSION_DEAD already cover an empty miss
  });

  // ── AC (resolver): a captured diagnostic becomes a WAKE_TURN_FAILED reason ──
  it("resolveStallReason returns WAKE_TURN_FAILED carrying the diagnostic", async () => {
    const diagnostic = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: OVERFLOW_SIGNAL });
    const deps: Partial<StallResolverDeps> = {
      getWakeDeliveryOutcome: async () => ({ delivered: true, deliveredAt: Date.now() - 30 * 60_000 }),
      getFirstActionAt: async () => null,
      getWakeFailureDiagnostic: async () => diagnostic,
      getActiveSessionKeys: () => [],
    };
    const reason = await resolveStallReason(
      "INF-504", "igor",
      { delegatedAtMs: Date.now() - 30 * 60_000 },
      deps as StallResolverDeps,
    );
    expect(reason).not.toBeNull();
    expect(reason!.reason).toBe(StallReasonCode.WAKE_TURN_FAILED);
    expect(reason!.diagnostic?.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    // It must WIN over the SESSION_DEAD it would otherwise resolve to (no session).
    expect(reason!.detail).toContain("gemma4:31b");
  });

  // ── AC2: watchdog surfaces the reason instead of a generic unreachable ──
  it("AC2 — watchdog skips re-wake and alerts with resolved model + error class, not 'unreachable'", async () => {
    const diagnostic = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: OVERFLOW_SIGNAL });
    const alerts: UnreachableAlert[] = [];
    let redispatchCalled = 0;

    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "INF-504",
          workflow: "dev-impl",
          state: "implementation",
          delegate: "igor",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 60 * 60_000,
          dispatchUpdatedAt: "2026-07-24T16:38:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.WAKE_TURN_FAILED,
            detail: diagnostic.summary,
            resolvedAt: Date.now(),
            diagnostic,
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => {
        redispatchCalled += 1;
        return { admitted: true };
      },
      escalateUnreachable: async () => {},
      notify: (a) => alerts.push(a),
    };

    const result = await runFirstActionWatchdogSweep(opts);

    // Re-waking into the same oversized-prompt config is pointless — skipped.
    expect(redispatchCalled).toBe(0);
    expect(result.redispatched).toBe(0);
    expect(result.unreachable).toBe(1);

    // The alert names the real cause, not just "unreachable".
    expect(alerts.length).toBe(1);
    expect(alerts[0].title).toMatch(/context-overflow/);
    expect(alerts[0].title).toContain("ollama/gemma4:31b");
    expect(alerts[0].title).toMatch(/fallback skipped/i);
    expect((alerts[0] as { reason?: string }).reason).toBe(StallReasonCode.WAKE_TURN_FAILED);
  });

  it("AC2b — a second sweep does not re-alert (dedup on exhausted ladder)", async () => {
    const diagnostic = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: OVERFLOW_SIGNAL });
    const alerts: UnreachableAlert[] = [];
    const nowMs = Date.parse("2026-07-24T17:38:00.000Z");
    const deliveredAtMs = nowMs - 60 * 60_000;
    const opts: FirstActionWatchdogOptions = {
      listTickets: async () => [
        {
          ticket: "INF-504",
          workflow: "dev-impl",
          state: "implementation",
          delegate: "igor",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: deliveredAtMs,
          dispatchUpdatedAt: "2026-07-24T16:38:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.WAKE_TURN_FAILED,
            detail: diagnostic.summary,
            resolvedAt: nowMs,
            diagnostic,
          },
        },
      ],
      now: () => nowMs,
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => ({ admitted: true }),
      escalateUnreachable: async () => {},
      notify: (a) => alerts.push(a),
    };
    await runFirstActionWatchdogSweep(opts);
    await runFirstActionWatchdogSweep(opts);
    expect(alerts.length).toBe(1); // fired once, then silent
  });

  // ── Full synthetic path: capture → resolve → escalate ──
  it("end-to-end — a synthetic overflow flows from delivery capture through to a diagnostic alert", async () => {
    // 1) Delivery captures the overflow.
    await deliverWithAck({
      agentId: "igor",
      ticketId: "INF-504",
      workflowState: "implementation",
      gateway: "dev",
      dispatchId: "disp-e2e-1",
      deliver: async () => ({ dispatched: false, hookError: true, hookErrorSummary: OVERFLOW_SIGNAL, rawResponse: { ok: false, error: OVERFLOW_SIGNAL } }),
      eventStore,
      ackTracker,
      maxRetries: 0,
      sleep: async () => {},
    });

    // 2) The wiring the connector does in index.ts: read the captured event back.
    const failures = eventStore.query({ key: "linear-INF-504", outcome: "wake-turn-failed", limit: 20 });
    const diagnostic = (failures[0].detail as { diagnostic?: WakeFailureDiagnostic }).diagnostic!;
    expect(diagnostic.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);

    // 3) That diagnostic drives the watchdog to a specific, non-generic alert.
    const alerts: UnreachableAlert[] = [];
    await runFirstActionWatchdogSweep({
      listTickets: async () => [
        {
          ticket: "INF-504",
          workflow: "dev-impl",
          state: "implementation",
          delegate: "igor",
          humanAssigned: false,
          labels: [],
          dispatchDeliveredAtMs: Date.now() - 60 * 60_000,
          dispatchUpdatedAt: "2026-07-24T16:38:00.000Z",
          firstOwnerActionAtMs: null,
          rungsFired: 0,
          stallReason: {
            reason: StallReasonCode.WAKE_TURN_FAILED,
            detail: diagnostic.summary,
            resolvedAt: Date.now(),
            diagnostic,
          },
        },
      ],
      now: () => Date.now(),
      maxRungs: 3,
      defaultDeadlineMs: 45 * 60_000,
      redispatch: async () => ({ admitted: true }),
      escalateUnreachable: async () => {},
      notify: (a) => alerts.push(a),
    });
    expect(alerts[0].title).toMatch(/context-overflow.*gemma4:31b|gemma4:31b.*context-overflow/);
  });
});
