/**
 * HeldRunRetrier — AI-1533.
 *
 * Watches per-(agent, ticket) dispatch windows. If a session ends with no observed
 * state-advancing transition within the retry window, it re-dispatches. After
 * maxAttempts retries it stops retrying and leaves the ticket for the existing
 * no-activity fail path.
 *
 * All methods normalize session keys internally so callers do not need to
 * pre-normalize — raw Linear IDs (AI-123), legacy prefixes (wake-linear-AI-123),
 * and already-normalized keys (linear-AI-123) all map to the same canonical form.
 */

import { normalizeSessionKey } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import type { PendingWorkBag } from "./pending-work-bag.js";
import type { SessionTracker } from "./session-tracker.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";
import type { WakeUpConfig } from "./wake-up.js";
import { resignalPendingTickets, type ResignalOptions } from "./resignal.js";
import { isLinearIssueActionable } from "../linear-actionable.js";

const log = componentLogger(createLogger(), "held-run-retrier");

export interface HeldRunRetrierConfig {
  /** Grace window before treating a session-end as a held (unproductive) run. Not currently used as a timer — all session-ends are treated as held if no transition was recorded. Future: use dispatchedAt to skip very short runs. */
  dispatchRetryGraceMs: number;
  /** Maximum number of automatic retries before giving up and falling through to no-activity escalation. */
  maxAttempts: number;
}

export interface HeldRunRetrierDeps {
  bag: PendingWorkBag;
  sessionTracker: SessionTracker;
  operationalEventStore: OperationalEventStore;
  wakeConfig: WakeUpConfig;
  /** Optional overrides forwarded to resignalPendingTickets (test hooks). */
  resignalOptions?: Partial<ResignalOptions>;
}

interface RetryState {
  retryCount: number;
  transitioned: boolean;
}

export class HeldRunRetrier {
  private readonly deps: HeldRunRetrierDeps;
  private readonly config: HeldRunRetrierConfig;
  private readonly state: Map<string, RetryState> = new Map();

  constructor(deps: HeldRunRetrierDeps, config: HeldRunRetrierConfig) {
    this.deps = deps;
    this.config = config;
  }

  private stateKey(agentId: string, ticketId: string): string {
    return `${agentId}:${normalizeSessionKey(ticketId)}`;
  }

  /** Record that a dispatch was sent for (agentId, ticketId). Initializes retry tracking. */
  trackDispatch(agentId: string, ticketId: string): void {
    const key = this.stateKey(agentId, ticketId);
    if (!this.state.has(key)) {
      this.state.set(key, { retryCount: 0, transitioned: false });
    }
  }

  /** Mark that a state-advancing transition was observed for (agentId, ticketId). */
  recordTransition(agentId: string, ticketId: string): void {
    const key = this.stateKey(agentId, ticketId);
    const s = this.state.get(key);
    if (s) s.transitioned = true;
  }

  /**
   * Called when a session ends for (agentId, ticketId).
   * Keys are normalized internally — raw or prefixed keys work identically to normalized ones.
   * Returns true if a retry was dispatched, false otherwise.
   */
  async onSessionEnd(agentId: string, ticketId: string): Promise<boolean> {
    const normalizedTicketId = normalizeSessionKey(ticketId);
    const key = `${agentId}:${normalizedTicketId}`;
    const s = this.state.get(key);

    if (!s) return false;

    if (s.transitioned) {
      this.state.delete(key);
      return false;
    }

    if (s.retryCount >= this.config.maxAttempts) {
      this.deps.operationalEventStore.append({
        outcome: "held-run-exhausted",
        agent: agentId,
        key: normalizedTicketId,
      });
      log.warn(`HeldRunRetrier: max attempts (${this.config.maxAttempts}) exhausted for ${agentId} [${normalizedTicketId}]`);
      this.state.delete(key);
      return false;
    }

    const isTicketActionable = this.deps.resignalOptions?.isTicketActionable ?? isLinearIssueActionable;
    if (!(await isTicketActionable(normalizedTicketId, agentId))) {
      this.state.delete(key);
      return false;
    }

    s.retryCount++;

    // End the held session so resignalPendingTickets can open a fresh one.
    this.deps.sessionTracker.endSession(agentId, normalizedTicketId);

    const pendingIds = this.deps.bag.getPendingTickets(agentId).map(e => e.ticketId);
    if (!pendingIds.includes(normalizedTicketId)) {
      this.deps.bag.add(agentId, normalizedTicketId, "Issue");
    }

    await resignalPendingTickets(
      agentId,
      [normalizedTicketId],
      this.deps.bag,
      this.deps.sessionTracker,
      this.deps.wakeConfig,
      { markActive: true, ...this.deps.resignalOptions },
    );

    this.deps.operationalEventStore.append({
      outcome: "held-run-retry",
      agent: agentId,
      key: normalizedTicketId,
    });

    log.info(`HeldRunRetrier: retried ${agentId} [${normalizedTicketId}] (attempt ${s.retryCount}/${this.config.maxAttempts})`);
    return true;
  }

  /**
   * Clear all retry state for a ticket when its delegate changes, so the new agent
   * starts with a fresh attempt budget.
   */
  onDelegateChange(ticketId: string): void {
    const normalizedTicketId = normalizeSessionKey(ticketId);
    for (const key of [...this.state.keys()]) {
      if (key.endsWith(`:${normalizedTicketId}`)) {
        this.state.delete(key);
      }
    }
  }
}
