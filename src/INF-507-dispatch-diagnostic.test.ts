/**
 * INF-507 — Loud per-container diagnostic for silent dispatch-wake failures
 * (context-overflow-on-primary class).
 *
 * A dispatched turn that dies on a prompt/context overflow used to surface only
 * as a generic "unreachable," forcing a human to read gateway logs by hand
 * (INF-502, INF-506). These tests pin the connector-side contract that makes
 * such a failure self-describing:
 *
 *   AC1 — a failed dispatch emits a STRUCTURED diagnostic naming the resolved
 *         model and the error class.
 *   AC2 — the diagnostic is persisted on the dispatch outcome (operational event
 *         store `detail`) — queryable without a gateway-log dig.
 *   AC3 — a context-overflow-on-primary is DISTINGUISHABLE from a genuine
 *         unreachable / timeout (distinct class + non-cascading prompt flag),
 *         and the first-action watchdog escalates it as a model-named
 *         unreachable instead of a blank one — skipping the futile re-dispatch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import {
  classifyDeliveryFailure,
  isContextOverflow,
  type DeliveryDiagnostic,
} from "./delivery/delivery-diagnostic.js";
import { deliverWithAck } from "./delivery/deliver-with-ack.js";
import type { DeliveryResult } from "./delivery/deliver.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { DispatchAckTracker } from "./bag/dispatch-ack-tracker.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

// The exact overflow line the gateway logs for the INF-506 incident (dev's
// tiny-context primary), as it would reach the connector over the awaited /v1
// path (flattened into the non-ok error body / summary).
const INF506_OVERFLOW =
  "gateway API responded with 500: [context-overflow-precheck] pre-prompt check " +
  "provider=ollama/gemma4:31b estimatedPromptTokens=20044 promptBudgetBeforeReserve=12768 " +
  "overflowTokens=7276 Context overflow: prompt too large for the model (precheck).";

// ── AC1 / AC3: the classifier ──────────────────────────────────────────────

describe("INF-507 classifier: names the model + error class (AC1)", () => {
  it("classifies a context-overflow from the /v1 error string, extracting model + budgets", () => {
    const d = classifyDeliveryFailure({ hookError: true, hookErrorSummary: INF506_OVERFLOW });
    expect(d.errorClass).toBe("context-overflow");
    expect(d.promptError).toBe(true); // non-cascading — the load-bearing bit
    expect(d.resolvedModel).toBe("ollama/gemma4:31b");
    expect(d.estimatedPromptTokens).toBe(20044);
    expect(d.promptBudgetBeforeReserve).toBe(12768);
    expect(d.overflowTokens).toBe(7276);
    expect(d.summary).toContain("context-overflow-on-primary");
    expect(d.summary).toContain("ollama/gemma4:31b");
  });

  it("classifies a context-overflow from a STRUCTURED gateway body (fields, not prose)", () => {
    const d = classifyDeliveryFailure({
      hookError: true,
      hookErrorSummary: "hook agent run returned non-ok status",
      rawResponse: {
        ok: false,
        provider: "ollama",
        model: "gemma4:31b",
        estimatedPromptTokens: 20044,
        promptBudgetBeforeReserve: 12768,
        diagnostics: { summary: "Context overflow" },
      },
    });
    expect(d.errorClass).toBe("context-overflow");
    expect(d.resolvedModel).toBe("ollama/gemma4:31b");
    expect(d.estimatedPromptTokens).toBe(20044);
    expect(d.overflowTokens).toBe(20044 - 12768);
  });

  it("detects overflow from the numbers alone when the prose marker is absent", () => {
    const d = classifyDeliveryFailure({
      hookError: true,
      hookErrorSummary: "estimatedPromptTokens=30000 promptBudgetBeforeReserve=8000 provider=ollama/qwen2:7b",
    });
    expect(d.errorClass).toBe("context-overflow");
    expect(d.promptError).toBe(true);
    expect(d.resolvedModel).toBe("ollama/qwen2:7b");
  });

  it("classifies a provider error (5xx, WOULD cascade) as NOT a prompt error (AC3)", () => {
    const d = classifyDeliveryFailure({
      hookError: true,
      hookErrorSummary: "gateway API responded with 503: upstream provider unavailable",
    });
    expect(d.errorClass).toBe("provider-error");
    expect(d.promptError).toBe(false);
    expect(isContextOverflow(d)).toBe(false);
  });

  it("classifies a transport-unreachable host distinctly from a context-overflow (AC3)", () => {
    const d = classifyDeliveryFailure({
      hookError: true,
      hookErrorSummary: "fetch failed: connect ECONNREFUSED 10.0.0.9:8790",
    });
    expect(d.errorClass).toBe("unreachable");
    expect(d.promptError).toBe(false);
  });

  it("classifies a timeout/abort distinctly", () => {
    const d = classifyDeliveryFailure({ pendingAck: true, hookErrorSummary: "The operation was aborted" });
    expect(d.errorClass).toBe("timeout");
    expect(d.promptError).toBe(false);
  });

  it("names a silent miss (no detail) explicitly instead of misclassifying it", () => {
    const d = classifyDeliveryFailure({});
    expect(d.errorClass).toBe("unknown");
    expect(d.summary).toContain("silent miss");
  });
});

// ── AC2: persisted on the dispatch outcome ──────────────────────────────────

describe("INF-507 persistence: diagnostic lands on the operational event (AC2)", () => {
  let dbPath: string;
  let store: OperationalEventStore;
  let ackDbPath: string;
  let ackTracker: DispatchAckTracker;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inf507-ev-")), "ev.db");
    store = new OperationalEventStore(dbPath);
    ackDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inf507-ack-")), "ack.db");
    ackTracker = new DispatchAckTracker(ackDbPath);
  });

  afterEach(() => {
    store.close();
    ackTracker.close?.();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(ackDbPath), { recursive: true, force: true });
  });

  it("writes the structured diagnostic into detail and a self-describing error summary", async () => {
    const failing: DeliveryResult = {
      dispatched: false,
      hookError: true,
      hookErrorSummary: INF506_OVERFLOW,
      diagnostic: classifyDeliveryFailure({ hookError: true, hookErrorSummary: INF506_OVERFLOW }),
    };
    const outcome = await deliverWithAck({
      agentId: "igor",
      ticketId: "INF-504",
      workflowState: "implementation",
      gateway: "dev",
      dispatchId: "wake-1",
      deliver: async () => failing,
      eventStore: store,
      ackTracker,
      maxRetries: 1,
      backoffMs: () => 0,
      sleep: async () => {},
    });
    expect(outcome.status).toBe("undeliverable");

    const events = store.query({ key: "linear-INF-504" });
    const failed = events.find((e) => e.outcome === "delivery-failed");
    expect(failed).toBeTruthy();
    const detail = failed!.detail as { diagnostic?: DeliveryDiagnostic };
    expect(detail.diagnostic?.errorClass).toBe("context-overflow");
    expect(detail.diagnostic?.resolvedModel).toBe("ollama/gemma4:31b");
    // The persisted summary is self-describing — no gateway-log dig required.
    expect(failed!.errorSummary).toContain("context-overflow");
    expect(failed!.errorSummary).toContain("ollama/gemma4:31b");

    // The terminal undeliverable record names the root cause too.
    const terminal = events.find((e) => e.outcome === "dispatch-undeliverable");
    expect(terminal!.errorSummary).toContain("context-overflow");
    const tdetail = terminal!.detail as { diagnostic?: DeliveryDiagnostic };
    expect(tdetail.diagnostic?.resolvedModel).toBe("ollama/gemma4:31b");
  });
});

// ── AC3: the watchdog distinguishes it and skips the futile re-dispatch ──────

describe("INF-507 watchdog: context-overflow unreachable is loud + skips redispatch (AC3)", () => {
  let runFirstActionWatchdogSweep: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let resetFirstActionWatchdogStateForTest: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    ({ runFirstActionWatchdogSweep } = (await import("./first-action-watchdog.js")) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    ({ resetFirstActionWatchdogStateForTest } = (await import(
      "./first-action-watchdog-state.js"
    )) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  beforeEach(() => resetFirstActionWatchdogStateForTest?.());

  const ticket = () => ({
    ticket: "INF-504",
    workflow: "dev-impl",
    state: "implementation",
    delegate: "igor",
    humanAssigned: false,
    labels: [],
    dispatchDeliveredAtMs: T0,
    dispatchUpdatedAt: new Date(T0).toISOString(),
    firstOwnerActionAtMs: null,
  });

  const overflowDiagnostic: DeliveryDiagnostic = classifyDeliveryFailure({
    hookError: true,
    hookErrorSummary: INF506_OVERFLOW,
  });

  it("emits a model-named unreachable alert and does NOT re-dispatch a context-overflow", async () => {
    const alerts: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let redispatched = 0;
    const result = await runFirstActionWatchdogSweep({
      listTickets: async () => [ticket()],
      now: () => T0 + 60 * MINUTE, // past the 45m default deadline → breached
      notify: (a: any) => alerts.push(a), // eslint-disable-line @typescript-eslint/no-explicit-any
      redispatch: async () => {
        redispatched += 1;
        return { admitted: true };
      },
      getDeliveryDiagnostic: async () => overflowDiagnostic,
    });

    // Straight to unreachable — the non-cascading class must NOT be re-dispatched.
    expect(redispatched).toBe(0);
    expect(result.redispatched).toBe(0);
    expect(result.unreachable).toBe(1);

    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.title).toContain("context-overflow");
    expect(alert.title).toContain("ollama/gemma4:31b");
    expect(alert.diagnostic?.errorClass).toBe("context-overflow");
    expect(alert.diagnostic?.promptError).toBe(true);
  });

  it("still re-dispatches (rung 1) a genuine no-diagnostic stall — no false short-circuit", async () => {
    let redispatched = 0;
    const result = await runFirstActionWatchdogSweep({
      listTickets: async () => [ticket()],
      now: () => T0 + 60 * MINUTE,
      notify: () => {},
      redispatch: async () => {
        redispatched += 1;
        return { admitted: true };
      },
      getDeliveryDiagnostic: async () => null, // nothing captured → normal ladder
    });
    expect(redispatched).toBe(1);
    expect(result.redispatched).toBe(1);
    expect(result.unreachable).toBe(0);
  });
});
