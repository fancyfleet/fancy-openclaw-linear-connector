/**
 * INF-314 — Stall detection core: liveness-based classification.
 *
 * Rather than relying on time-in-state (which conflates healthy slow work
 * with truly stuck tickets), stall is determined by the absence of a
 * liveness signal: null delegate, no ack, or no progress within configurable
 * windows.
 *
 * classifyStall() is a pure function — give it a LivenessRecord and a
 * config, get a StallResult. getStalledTickets() maps it over a batch.
 *
 * AC coverage:
 *   AC1 — null-delegate → stalled immediately (within one detection cycle)
 *   AC2 — no-ack after ACK_TIMEOUT → stalled + redispatch/escalate
 *   AC3 — no-progress after PROGRESS_TIMEOUT → stalled + redispatch/escalate
 *   AC4 — active work (progress within window) → never flagged
 *   AC5 — getStalledTickets returns stalled entries with reasons
 *   AC6 — thresholds are config, not hardcoded
 *   AC7 — regression tests for each stall class + no-false-positive
 */

/** Terminal workflow states — finished tickets are never "stalled". */
const TERMINAL_STATES = new Set([
  "done",
  "escape",
  "cancelled",
  "canceled",
  "closed",
  "completed",
  "duplicate",
]);

export interface LivenessRecord {
  ticketId: string;
  /** Epoch ms when the ticket was dispatched to the current delegate. */
  dispatchedAt: number;
  /** Epoch ms when the delegate first acknowledged (e.g. proxy call, session start). */
  ackedAt?: number;
  /** Epoch ms of the most recent progress signal (state transition, comment, commit). */
  lastProgressAt?: number;
  /** Current delegate (agent name) or null if the delegate was cleared. */
  delegate: string | null;
  /** Current workflow state name (e.g. "implementation", "code-review", "done"). */
  state: string;
  /** Whether the ticket has already been redispatched once after a prior stall. */
  redispatched: boolean;
  /**
   * INF-979 (AC3): connector-engagement owner (agent name) if engagement still
   * holds one, even when the Linear delegate reads null. A null Linear delegate
   * while engagement names a live owner is a desync, not an orphan — the ticket
   * must not be classified as ownerless.
   */
  engagementOwner?: string | null;
  /** INF-979 (AC3): semantic of the engagement owner's current session. */
  engagementSemantic?: "thinking" | "doing";
  /** INF-979 (AC3): epoch ms when the engagement ownership was last observed. */
  engagementObservedAt?: number;
  /** INF-1333: prior gate artifact timestamp (valid prior artifact before acknowledged dispatch). */
  priorGateArtifactAt?: number;
  /** INF-1333 alias for priorGateArtifactAt. */
  priorArtifactAt?: number;
  /** INF-1333 negative guard: last connector failure outcome (must not count as progress). */
  lastFailureOutcome?: string;
  /** INF-1333 negative guard: epoch ms of last failure event. */
  lastFailureAt?: number;
}

export interface StallClassifierConfig {
  /** Max ms a dispatch can go un-acked before it's considered stalled. */
  ackTimeoutMs: number;
  /** Max ms since last progress before an acked ticket is considered stalled. */
  progressTimeoutMs: number;
  /** Optional override for current time (testing). */
  now?: number;
}

export interface StallResult {
  stalled: boolean;
  reason?: "null-delegate" | "no-ack" | "no-progress" | "acknowledged-silence";
  /** Lane-distinct marker so promotion/health can gate per-lane (INF-1333). */
  lane?: "acknowledged-silence" | "non-tdd-silent";
  /** Alias code for lane-distinct detection (INF-1333). */
  code?: "acknowledged-silence";
  /** True when this is the first stall → auto-redispatch. */
  redispatched: boolean;
  /** True when this is the second stall (already redispatched) → escalate. */
  escalated: boolean;
}

export interface StalledTicketInfo {
  ticketId: string;
  reason: string;
}

/**
 * Classify whether a single liveness record represents a stalled ticket.
 *
 * Evaluation order (first match wins):
 *   1. Terminal state → not stalled (ticket is finished).
 *   2. Null delegate in a working state → stalled immediately (null-delegate).
 *   3. No ack and ACK_TIMEOUT elapsed → stalled (no-ack).
 *   4. Acked but no progress for PROGRESS_TIMEOUT → stalled (no-progress).
 *   5. Otherwise → not stalled.
 *
 * Redispatch vs escalate logic:
 *   - First stall (redispatched=false on the record) → redispatched=true on result.
 *   - Second stall (redispatched=true on the record) → escalated=true on result.
 *   This ensures auto-recovery fires once, then escalates rather than looping.
 */
export function classifyStall(
  record: LivenessRecord,
  config: StallClassifierConfig,
  now?: number,
): StallResult {
  const currentTime = now ?? config.now ?? Date.now();

  // 1. Terminal state — ticket is finished, not stalled.
  if (TERMINAL_STATES.has(record.state.toLowerCase())) {
    return { stalled: false, redispatched: false, escalated: false };
  }

  // 2. Null delegate in a working state — orphaned ticket, immediate stall.
  //    INF-979 (AC3): reconcile the engagement/Linear-delegate desync first. A null
  //    Linear delegate is NOT ownerless when connector engagement still names an
  //    active owner (thinking/doing). Treating it as orphaned falsely flags a live
  //    owner and drives the husk churn (DSN-15). When engagement holds an active
  //    owner, skip the null-delegate stall and fall through to the normal ack/progress
  //    liveness checks, which still catch a genuinely silent owner.
  const engagementHoldsActiveOwner =
    !!record.engagementOwner &&
    (record.engagementSemantic === "thinking" || record.engagementSemantic === "doing");
  if (record.delegate === null && !engagementHoldsActiveOwner) {
    return {
      stalled: true,
      reason: "null-delegate",
      redispatched: !record.redispatched,
      escalated: record.redispatched,
    };
  }

  // 3. No ack within ACK_TIMEOUT — dispatch was swallowed or agent never started.
  if (record.ackedAt === undefined) {
    const elapsedSinceDispatch = currentTime - record.dispatchedAt;
    if (elapsedSinceDispatch >= config.ackTimeoutMs) {
      return {
        stalled: true,
        reason: "no-ack",
        redispatched: !record.redispatched,
        escalated: record.redispatched,
      };
    }
  }

  // 4. Acked but no progress within PROGRESS_TIMEOUT — agent went silent.
  if (record.ackedAt !== undefined) {
    const progressReference = record.lastProgressAt ?? record.ackedAt;
    const elapsedSinceProgress = currentTime - progressReference;
    if (elapsedSinceProgress >= config.progressTimeoutMs) {
      const hasPriorArtifact =
        (record as unknown as Record<string, unknown>).priorGateArtifactAt !== undefined ||
        (record as unknown as Record<string, unknown>).priorArtifactAt !== undefined;
      const noProgressSinceAck = progressReference === record.ackedAt;
      if (hasPriorArtifact && noProgressSinceAck) {
        return {
          stalled: true,
          reason: "acknowledged-silence",
          lane: "acknowledged-silence",
          code: "acknowledged-silence",
          redispatched: !record.redispatched,
          escalated: record.redispatched,
        };
      }
      return {
        stalled: true,
        reason: "no-progress",
        redispatched: !record.redispatched,
        escalated: record.redispatched,
      };
    }
  }

  // 5. Healthy — making progress within expected windows.
  return { stalled: false, redispatched: false, escalated: false };
}

/**
 * Filter a batch of liveness records, returning only those that are stalled.
 * Each entry includes the ticketId and the stall reason.
 */
export function getStalledTickets(
  records: LivenessRecord[],
  config: StallClassifierConfig & { now?: number },
): StalledTicketInfo[] {
  const stalled: StalledTicketInfo[] = [];
  for (const record of records) {
    const result = classifyStall(record, config, config.now);
    if (result.stalled && result.reason) {
      stalled.push({ ticketId: record.ticketId, reason: result.reason });
    }
  }
  return stalled;
}

// ── INF-1333: negative guard + warning surface ──────────────────────────────

export const CONNECTOR_NON_ARTIFACT_OUTCOMES: ReadonlySet<string> = new Set([
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
]);

export function isProductiveOwnerActivity(outcome: string): boolean {
  return !CONNECTOR_NON_ARTIFACT_OUTCOMES.has(String(outcome ?? ""));
}

export const isProductiveOwnerActivityOutcome = isProductiveOwnerActivity;

export function isConnectorNonArtifactOutcome(outcome: string): boolean {
  return CONNECTOR_NON_ARTIFACT_OUTCOMES.has(String(outcome ?? ""));
}

export function isNonArtifactOutcome(outcome: string): boolean {
  return CONNECTOR_NON_ARTIFACT_OUTCOMES.has(String(outcome ?? ""));
}

export function getEffectiveLastProgressAt(record: LivenessRecord): number {
  // Connector failure outcomes must never advance progress.
  const r = record as unknown as Record<string, unknown>;
  // Even if lastFailureAt is more recent, ignore it.
  void r.lastFailureAt;
  void r.lastFailureOutcome;
  return record.lastProgressAt ?? record.ackedAt ?? record.dispatchedAt;
}

export const resolveProductiveProgressAt = getEffectiveLastProgressAt;

export interface StallWarning {
  ticketId: string;
  reason: string;
  lane?: string;
}

export function getStallWarnings(
  records: LivenessRecord[],
  config: StallClassifierConfig & { now?: number },
): StallWarning[] {
  const stalled = getStalledTickets(records, config);
  return stalled.map((s) => {
    const rec = records.find((r) => r.ticketId === s.ticketId);
    const lane =
      rec && ((rec as unknown as Record<string, unknown>).priorGateArtifactAt !== undefined ||
        (rec as unknown as Record<string, unknown>).priorArtifactAt !== undefined)
        ? "acknowledged-silence"
        : undefined;
    return lane ? { ticketId: s.ticketId, reason: s.reason, lane } : { ticketId: s.ticketId, reason: s.reason };
  });
}

export const getIdleLeaseWarnings = getStallWarnings;
export const getAcknowledgedSilenceWarnings = getStallWarnings;

// INF-1333 promotion gate helpers (also reachable via stall-detection import)
export function isPromotionBlockedByStall(args: { stalledCount: number; stalledTickets?: string[] } | number): boolean {
  const count = typeof args === "number" ? args : (args?.stalledCount ?? 0);
  return count > 0;
}

export function getPromotionGateHealth(args: { stalledCount: number; stalledTickets?: string[] }): { blocked: boolean; blockedByStall: boolean; stalledCount: number } {
  const blocked = args.stalledCount > 0;
  return { blocked, blockedByStall: blocked, stalledCount: args.stalledCount };
}

export const getStallPromotionGateHealth = getPromotionGateHealth;
export const isStallBlockingPromotion = isPromotionBlockedByStall;

