/**
 * INF-1333 Slice E — Acknowledged-silence behavior: classifier + distinct-lane regressions.
 *
 * TDD-first failing regressions. These MUST be RED against origin/main because the
 * non-TDD lane, lane-distinct reason codes, warning surface, and negative-guard
 * helpers do not yet exist. Igor implements them; we only prove the AC.
 *
 * AC mapping (comments on each block):
 *   AC INF-1305 — idle-lease lane: production-format linear-<ID> leases, no owner artifact,
 *                 asserts ticket identity + stalled count + warning/event + recovery.
 *   AC INF-1307 — acknowledged-silent lane: valid prior gate artifact + acknowledged
 *                 implementation dispatch (agent igor) with no subsequent owner output,
 *                 asserts detection DISTINCT from INF-1305 + recovery.
 *   AC Negative guard — C6/bootstrap/model/delivery failures never count as productive
 *                 owner activity.
 *   AC Both lanes TDD-first — these tests are the failing regressions.
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyStall,
  getStalledTickets,
  type LivenessRecord,
  type StallClassifierConfig,
} from "./stall-detection.js";

const ACK_TIMEOUT_MS = 3 * 60 * 1000;
const PROGRESS_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_CONFIG: StallClassifierConfig = {
  ackTimeoutMs: ACK_TIMEOUT_MS,
  progressTimeoutMs: PROGRESS_TIMEOUT_MS,
};

// Mirrors the connector's production lease key prefix (see write-tests-no-output-stall.ts toLeaseKey).
function prodLeaseId(id: string): string {
  return id.startsWith("linear-") ? id : `linear-${id}`;
}

// Helper to build a baseline LivenessRecord.
function makeRecord(overrides: Partial<LivenessRecord> & { ticketId: string }): LivenessRecord {
  return {
    dispatchedAt: Date.now() - 120_000,
    delegate: "igor",
    state: "implementation",
    redispatched: false,
    ...overrides,
  };
}

// The connector collapses these outcomes into CONNECTOR_NON_ARTIFACT_OUTCOMES —
// none of them are productive owner activity. The spec lists the full family;
// we enumerate the canonical set here to prove the negative guard.
const CONNECTOR_NON_ARTIFACT_OUTCOMES = [
  "wake-turn-failed",
  "delivery-failed",
  "delivery-unconfirmed",
  "dispatch-undeliverable",
  "bootstrap-wake-failed",
  "delegation-reconciliation-failed",
  "no-activity-warn",
  "no-activity-failed",
  "no-activity-redispatch",
  "delivered",
  "dispatch-accepted",
  "delivery-pending-ack",
  "dedup-suppressed",
  "queued",
  "bag-added",
  "bootstrap-wake-delivered",
  "bootstrap-wake-dispatched",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// AC: INF-1305 lane — idle lease (production-format linear-ID leases, no owner artifact)
// ─────────────────────────────────────────────────────────────────────────────

describe("INF-1333 Slice E — AC INF-1305 lane (idle lease: production-format linear-ID, no owner artifact)", () => {
  // AC: INF-1305 lane — idle lease identity + stalled count + warning/event + recovery
  it("seeds production-format linear-<ID> leases with no owner artifact and asserts stalled identity + count + warning + recovery", async () => {
    const now = Date.now();
    const ticketA = prodLeaseId("INF-1333-A");
    const ticketB = prodLeaseId("INF-1333-B");

    // No ackedAt, no lastProgressAt beyond dispatch — pure idle lease.
    const records: LivenessRecord[] = [
      {
        ticketId: ticketA,
        dispatchedAt: now - (ACK_TIMEOUT_MS + 30_000),
        ackedAt: undefined,
        lastProgressAt: undefined,
        delegate: "igor",
        state: "implementation",
        redispatched: false,
      },
      {
        ticketId: ticketB,
        dispatchedAt: now - (ACK_TIMEOUT_MS + 30_000),
        ackedAt: undefined,
        lastProgressAt: undefined,
        delegate: "igor",
        state: "implementation",
        redispatched: false,
      },
      // Healthy control — must NOT be counted.
      makeRecord({
        ticketId: prodLeaseId("INF-1333-HEALTHY"),
        dispatchedAt: now - 30_000,
        ackedAt: now - 25_000,
        lastProgressAt: now - 10_000,
        delegate: "igor",
        state: "implementation",
      }),
    ];

    const stalled = getStalledTickets(records, { ...DEFAULT_CONFIG, now });

    // Ticket identity preserved + stalled count
    expect(stalled.length).toBe(2);
    expect(stalled.map((s) => s.ticketId)).toEqual(expect.arrayContaining([ticketA, ticketB]));
    expect(stalled.map((s) => s.ticketId)).not.toContain(prodLeaseId("INF-1333-HEALTHY"));

    // Each stalled entry carries a reason (stall classifier would drive warning/event).
    for (const s of stalled) {
      expect(typeof s.reason).toBe("string");
      expect(s.reason.length).toBeGreaterThan(0);
    }

    // ── TDD-first RED: warning/event + recovery surface for the idle-lease lane ──
    // The current classifier/state has no lane-aware warning helper. This assertion
    // proves the future warning/event surface exists and is exercised by this lane.
    // It MUST fail until Igor adds a helper such as getStallWarnings() /
    // getAcknowledgedSilenceWarnings() or a health field that reports idle-lease
    // warnings distinctly. Without this, the slice's "warning/event is emitted"
    // half of INF-1305 is unproven.
    const stallMod: unknown = (() => {
      try {
        // Synchronous require path mirrors how other tests reach state — avoids a
        // missing export breaking tsc (isolatedModules), while still failing at runtime.
        return { loaded: true };
      } catch {
        return { loaded: false };
      }
    })();
    void stallMod;

    // This import intentionally reaches for a not-yet-existing lane-aware warning
    // accessor. On origin/main it is undefined → expect fails → RED.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let idleLeaseWarningAccessor: unknown = undefined;
    try {
      // Use dynamic import indirection so tsc does not hard-fail on missing export.
      const mod = await import("./stall-detection.js") as Record<string, unknown>;
      idleLeaseWarningAccessor =
        mod.getStallWarnings ?? mod.getIdleLeaseWarnings ?? mod.getAcknowledgedSilenceWarnings ?? undefined;
    } catch {
      idleLeaseWarningAccessor = undefined;
    }
    expect(idleLeaseWarningAccessor).toBeDefined();
    // If the accessor exists, it must report warnings for the idle-lease stalled set.
    if (typeof idleLeaseWarningAccessor === "function") {
      const warnings = (idleLeaseWarningAccessor as (r: unknown, c: unknown) => unknown[])(records, {
        ...DEFAULT_CONFIG,
        now,
      });
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings.length).toBeGreaterThan(0);
    }

    // Recovery: first stall → redispatch, second stall → escalate.
    const first = classifyStall(records[0], DEFAULT_CONFIG, now);
    expect(first.stalled).toBe(true);
    expect(first.redispatched).toBe(true);
    expect(first.escalated).toBe(false);
    const second = classifyStall({ ...records[0], redispatched: true }, DEFAULT_CONFIG, now);
    expect(second.stalled).toBe(true);
    expect(second.redispatched).toBe(false);
    expect(second.escalated).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC: INF-1307 lane — acknowledged-silent (MUST BE DISTINCT from INF-1305)
// ─────────────────────────────────────────────────────────────────────────────

describe("INF-1333 Slice E — AC INF-1307 lane (acknowledged-silent: prior artifact + acknowledged dispatch, no subsequent output)", () => {
  // AC: INF-1307 lane — detection distinct from INF-1305 + recovery
  it("classifies prior-gate-artifact + acknowledged implementation dispatch with no subsequent output as stalled with a reason/operation DISTINCT from the idle-lease lane", async () => {
    const now = Date.now();

    // Idle-lease record (INF-1305 shape): never acked → expects no-ack / null-delegate
    const idleLeaseRecord: LivenessRecord = {
      ticketId: prodLeaseId("INF-1333-IDLE-1"),
      dispatchedAt: now - (ACK_TIMEOUT_MS + 30_000),
      ackedAt: undefined,
      lastProgressAt: undefined,
      delegate: "igor",
      state: "implementation",
      redispatched: false,
    };

    // Acknowledged-silent record (INF-1307 shape): valid prior gate artifact EXISTS
    // (e.g. failing TDD tests were posted — modeled as priorGateArtifactAt), then
    // an acknowledged implementation dispatch (ackedAt set, delegate igor,
    // state implementation) produces NO subsequent owner output (lastProgressAt
    // does not advance beyond ackedAt).
    const priorGateArtifactAt = now - (PROGRESS_TIMEOUT_MS + 120_000);
    void priorGateArtifactAt; // semantic marker — the record's ackedAt is the dispatch ack; the prior artifact is the conceptual gate precondition.
    const acknowledgedSilentRecord: LivenessRecord = {
      ticketId: prodLeaseId("INF-1333-SILENT-1"),
      dispatchedAt: now - (PROGRESS_TIMEOUT_MS + 60_000),
      ackedAt: now - (PROGRESS_TIMEOUT_MS + 30_000),
      lastProgressAt: now - (PROGRESS_TIMEOUT_MS + 30_000), // == ackedAt, no advancement
      delegate: "igor",
      state: "implementation",
      redispatched: false,
    };
    // Attach the prior-artifact marker so a lane-aware classifier can distinguish
    // this from a plain no-progress stall. On origin/main this field is ignored →
    // the classifier will return no-progress (same bucket as generic), failing
    // the distinct-reason assertion below.
    (acknowledgedSilentRecord as unknown as Record<string, unknown>).priorGateArtifactAt = priorGateArtifactAt;
    (acknowledgedSilentRecord as unknown as Record<string, unknown>).priorArtifactAt = priorGateArtifactAt;

    const idleResult = classifyStall(idleLeaseRecord, DEFAULT_CONFIG, now);
    const silentResult = classifyStall(acknowledgedSilentRecord, DEFAULT_CONFIG, now);

    expect(idleResult.stalled).toBe(true);
    expect(silentResult.stalled).toBe(true);

    // ── Core DISTINCTNESS assertion — MUST fail on origin/main ──
    // The idle-lease lane and acknowledged-silent lane must not collapse to the
    // same reason/operation code. INF-1333 requires a lane-distinct stall reason
    // (e.g. 'acknowledged-silence' / 'silent-implementation' / lane field) so
    // promotion/health can refuse a bad candidate per lane. If both return
    // 'no-ack' or both 'no-progress', the test fails — proving distinct detection
    // is missing.
    const idleReason = (idleResult as unknown as Record<string, unknown>).reason ?? idleResult.reason;
    const silentReason = (silentResult as unknown as Record<string, unknown>).reason ?? silentResult.reason;
    const silentLane = (silentResult as unknown as Record<string, unknown>).lane;
    const idleLane = (idleResult as unknown as Record<string, unknown>).lane;

    // INF-1333 requires a lane-distinct stall signal beyond the generic
    // no-ack vs no-progress difference that already exists. Idle=no-ack vs
    // silent=no-progress are incidentally distinct today, but the AC demands
    // a dedicated acknowledged-silence lane (reason or lane field) so the
    // promotion gate can block per-lane. We therefore require the silent
    // record to carry the new lane-distinct marker; mere generic reason
    // difference is not sufficient.
    void idleReason; void idleLane; // referenced below in blocked check
    const isAcknowledgedSilenceReason =
      silentReason === "acknowledged-silence" ||
      silentReason === "silent-implementation" ||
      silentReason === "ack-no-progress" ||
      silentLane === "acknowledged-silence" ||
      silentLane === "non-tdd-silent" ||
      (silentResult as unknown as Record<string, unknown>).code === "acknowledged-silence";
    expect(isAcknowledgedSilenceReason).toBe(true);

    // Additionally, the idle lane must NOT carry the acknowledged-silence
    // marker — proving the two lanes are distinguishable in both directions.
    const idleIsAckSilence =
      idleReason === "acknowledged-silence" ||
      idleLane === "acknowledged-silence" ||
      idleLane === "non-tdd-silent";
    expect(idleIsAckSilence).toBe(false);
  });

  it("recovers the acknowledged-silent lane distinctly: first stall redispatches, second escalates, both carrying the lane-distinct reason", () => {
    const now = Date.now();
    const record: LivenessRecord = {
      ticketId: prodLeaseId("INF-1333-SILENT-RECOVER"),
      dispatchedAt: now - (PROGRESS_TIMEOUT_MS + 60_000),
      ackedAt: now - (PROGRESS_TIMEOUT_MS + 30_000),
      lastProgressAt: now - (PROGRESS_TIMEOUT_MS + 30_000),
      delegate: "igor",
      state: "implementation",
      redispatched: false,
    };
    (record as unknown as Record<string, unknown>).priorGateArtifactAt = now - (PROGRESS_TIMEOUT_MS + 120_000);

    const first = classifyStall(record, DEFAULT_CONFIG, now);
    expect(first.stalled).toBe(true);
    // Recovery is exercised (first stall → redispatch) AND the lane-distinct
    // marker must persist through recovery. Without the lane-distinct code,
    // this assertion fails → RED.
    const firstReason = (first as unknown as Record<string, unknown>).reason ?? first.reason;
    const firstLane = (first as unknown as Record<string, unknown>).lane;
    const firstIsDistinct =
      firstReason === "acknowledged-silence" ||
      firstReason === "silent-implementation" ||
      firstLane === "acknowledged-silence" ||
      firstLane === "non-tdd-silent";
    expect(firstIsDistinct).toBe(true);
    expect(first.redispatched).toBe(true);
    expect(first.escalated).toBe(false);

    const second = classifyStall({ ...record, redispatched: true } as LivenessRecord, DEFAULT_CONFIG, now);
    expect(second.stalled).toBe(true);
    const secondReason = (second as unknown as Record<string, unknown>).reason ?? second.reason;
    const secondLane = (second as unknown as Record<string, unknown>).lane;
    const secondIsDistinct =
      secondReason === "acknowledged-silence" ||
      secondReason === "silent-implementation" ||
      secondLane === "acknowledged-silence" ||
      secondLane === "non-tdd-silent";
    expect(secondIsDistinct).toBe(true);
    expect(second.redispatched).toBe(false);
    expect(second.escalated).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC: Negative guard — C6/bootstrap/model/delivery failures never count as productive owner activity
// ─────────────────────────────────────────────────────────────────────────────

describe("INF-1333 Slice E — Negative guard: C6/bootstrap/model/delivery failures never count as productive owner activity", () => {
  it("treats every CONNECTOR_NON_ARTIFACT_OUTCOMES value as non-productive owner activity", async () => {
    // The stall classifier must exclude these outcomes from lastProgressAt semantics.
    // The intended implementation introduces a helper such as
    // isProductiveOwnerActivityOutcome(outcome) / isConnectorNonArtifactOutcome(outcome)
    // that returns false for every value in the family. We assert that helper
    // exists and returns false — on origin/main it does not exist → RED.
    let helper: ((outcome: string) => boolean) | undefined;
    try {
      const mod = (await import("./stall-detection.js")) as Record<string, unknown>;
      helper =
        (mod.isProductiveOwnerActivity as typeof helper) ??
        (mod.isProductiveOwnerActivityOutcome as typeof helper) ??
        (mod.isConnectorNonArtifactOutcome as unknown as typeof helper) ??
        undefined;
      // Some implementations expose the guard as "isNonArtifactOutcome → true"
      // meaning non-productive; normalize to productive=false expectation below.
      if (!helper) {
        const alt = mod.isNonArtifactOutcome as ((o: string) => boolean) | undefined;
        if (alt) {
          helper = (o: string) => !alt(o);
        }
      }
    } catch {
      helper = undefined;
    }

    expect(helper).toBeDefined();
    if (!helper) return; // expect above already failed; guard for type narrowing

    for (const outcome of CONNECTOR_NON_ARTIFACT_OUTCOMES) {
      expect(helper(outcome)).toBe(false);
    }
    // A genuine owner artifact outcome must still count as productive.
    expect(helper("tests-failed")).toBe(true);
    expect(helper("implemented")).toBe(true);
  });

  it("still reports stalled when the only activity after dispatch is a connector failure outcome (must not advance lastProgressAt)", async () => {
    const now = Date.now();

    // Model: acknowledged dispatch with lastProgressAt == ackedAt, plus a
    // synthetic failure event timestamp that must NOT be treated as progress.
    // If the classifier mistakenly treats a failure outcome as progress,
    // it would see "recent progress" and return stalled=false (wrong).
    const ackedAt = now - (PROGRESS_TIMEOUT_MS + 30_000);
    const failureEventAt = now - 5_000; // very recent, but it's a failure outcome

    const record: LivenessRecord = {
      ticketId: prodLeaseId("INF-1333-NEG-GUARD"),
      dispatchedAt: now - (PROGRESS_TIMEOUT_MS + 60_000),
      ackedAt,
      lastProgressAt: ackedAt, // no productive advancement
      delegate: "igor",
      state: "implementation",
      redispatched: false,
    };
    // Attach the failure outcome marker so a naive implementation that
    // advances lastProgressAt to failureEventAt would be caught. Correct
    // behavior: lastProgressAt stays at ackedAt → still stalled.
    (record as unknown as Record<string, unknown>).lastFailureOutcome = "delivery-failed";
    (record as unknown as Record<string, unknown>).lastFailureAt = failureEventAt;

    const result = classifyStall(record, DEFAULT_CONFIG, now);
    expect(result.stalled).toBe(true);

    // ── RED guard: if a helper maps failure outcomes to progress, it must be
    // excluded. Assert that a future helper `getEffectiveLastProgressAt` or
    // `resolveProductiveProgressAt` does not advance past ackedAt for failures.
    // On origin/main no such helper exists → this assertion fails.
    let effectiveHelper: ((r: unknown) => number) | undefined;
    try {
      const mod = (await import("./stall-detection.js")) as Record<string, unknown>;
      effectiveHelper =
        (mod.getEffectiveLastProgressAt as typeof effectiveHelper) ??
        (mod.resolveProductiveProgressAt as typeof effectiveHelper) ??
        undefined;
    } catch {
      effectiveHelper = undefined;
    }
    expect(effectiveHelper).toBeDefined();
    if (effectiveHelper) {
      const effective = effectiveHelper(record);
      expect(effective).toBe(ackedAt);
    }
  });
});
