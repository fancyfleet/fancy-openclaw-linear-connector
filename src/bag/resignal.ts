import { makeFreshSessionKey, normalizeSessionKey } from "../session-key.js";
import { createModuleLogger } from "../logging.js";
import { sendWakeUpSignal, MENTION_TICKET_TEMPLATE, type WakeUpConfig } from "./wake-up.js";
import { PendingWorkBag } from "./pending-work-bag.js";
import { SessionTracker } from "./session-tracker.js";
import { isLinearIssueActionable, isLinearIssueStillRoutedToAgent, checkLinearIssueRouting, type RoutingReason } from "../linear-actionable.js";

const log = createModuleLogger("resignal");

export interface DispatchResult {
  ticketId: string;
  dispatched: boolean;
  runId?: string;
  pruned?: boolean;
  /** True when dispatch was skipped because the routing check returned fail-open and failOpenBehavior is "defer". */
  deferred?: boolean;
  /** Canon version injected into this dispatch (null when no canon loaded). */
  canonVersion?: string | null;
}

export interface ResignalOptions {
  /** Mark the agent active for the first successfully signaled ticket. */
  markActive?: boolean;
  /** Optional test hook / policy override for pruning no-longer-actionable tickets. */
  isTicketActionable?: (ticketId: string, agentId: string) => boolean | Promise<boolean>;
  /** Optional test hook for delivery. */
  sendWakeUp?: (agentId: string, ticketIds: string[], config: WakeUpConfig) => Promise<{ runId?: string; canonVersion?: string } | void>;
  /** Optional callback after successful dispatch — used for ack tracking. */
  onDispatched?: (agentId: string, ticketId: string) => void;
  /**
   * How to handle a fail-open result (transient Linear API error) during the default routing check.
   * - "dispatch" (default): treat as actionable and dispatch — preserves fail-open protection for
   *   live webhook events where dropping legitimate work would be worse than a spurious wake-up.
   * - "defer": skip dispatch but leave in bag for retry on the next connector start — safe for
   *   startup-replay where a transient error should not resurrect Done tickets.
   * Has no effect when isTicketActionable is provided (custom override bypasses this logic).
   */
  failOpenBehavior?: "dispatch" | "defer";
  /**
   * INF-982: map of (agentId → [ticketId → freshRecoveryKey]) used for stale-session
   * re-dispatch. When a stale-session recovery transitions a C2/C4 ticket back to
   * To Do and re-dispatches, the new dispatch should use a session key that does NOT
   * match the stale session, so that the stale-session forensics module reads the NEW
   * session's data (not the old zero-output stale data) on the next timeout.
   *
   * The key is a versioned form like `linear-INF-982:r1` which the delivery layer
   * passes through to the gateway as the session label, creating a fresh OpenClaw
   * session. The stale-forensics `findSessionFile` searches by the session key;
   * the versioned key only matches the new dispatch's session, not any old stale ones.
   *
   * Internal tracking (sessionTracker, bag, ackTracker) uses the normalized base key
   * (`linear-INF-982`), so dedup and tracking remain coherent across version boundaries.
   */
  staleRecoveryKeys?: Map<string, Map<string, string>>;
}

/**
 * Re-signal queued work one Linear issue at a time.
 *
 * A single multi-ticket wake-up is dangerous because OpenClaw keys the session by
 * one `linear-TEAM-N` value; unrelated tickets then land in the first ticket's
 * session. This helper preserves one per-ticket session key per pending ticket.
 */
export async function resignalPendingTickets(
  agentId: string,
  ticketIds: string[],
  bag: PendingWorkBag,
  sessionTracker: SessionTracker,
  wakeConfig: WakeUpConfig,
  options: ResignalOptions = {},
): Promise<DispatchResult[]> {
  const normalizedTickets = [...new Set(ticketIds.map((ticketId) => normalizeSessionKey(ticketId)))];
  const usingInjectedWakeUp = options.sendWakeUp !== undefined;
  const sendWakeUp = options.sendWakeUp ?? sendWakeUpSignal;
  const results: DispatchResult[] = [];

  for (const ticketId of normalizedTickets) {
    try {
      // Skip if this ticket already has an active session — don't double-dispatch
      if (sessionTracker.isActiveForTicket(agentId, ticketId)) {
        log.info(`Session already active for ${agentId} [${ticketId}] — skipping resignal`);
        continue;
      }

      // AI-2091 §7 (AI-1774/AI-1772): one wake → one session. Claim the session
      // slot ATOMICALLY and SYNCHRONOUSLY here — before the first `await` — so two
      // concurrent dispatches of the same pending wake (the intake race) can't both
      // pass the isActiveForTicket check above and each deliver. startSession is a
      // compare-and-set: it returns false if another in-flight dispatch already
      // claimed this exact (agent, ticket), and we skip the duplicate. The claim is
      // released again on the prune paths below so a non-actionable ticket doesn't
      // leave a phantom active session behind. (Only when markActive — callers that
      // don't mark sessions active keep the prior behavior.)
      let claimedSession = false;
      if (options.markActive) {
        claimedSession = sessionTracker.startSession(agentId, ticketId);
        if (!claimedSession) {
          log.info(`Wake already in-flight for ${agentId} [${ticketId}] — skipping duplicate dispatch`);
          continue;
        }
      }

      // Resolve per-ticket actionability. For mention/body-mention–routed tickets the
      // issue need not have this agent as delegate — mentions are always actionable.
      // For everything else (or unknown/legacy rows) fall back to the delegate check,
      // which preserves the ILL-331 protection: a ticket whose delegate was cleared by
      // needs-human/complete/handoff-work is correctly pruned here.
      if (options.isTicketActionable) {
        // Custom override provided: use it as-is (failOpenBehavior does not apply)
        if (!(await options.isTicketActionable(ticketId, agentId))) {
          if (claimedSession) sessionTracker.endSession(agentId, ticketId);
          bag.removeTicket(agentId, ticketId);
          sessionTracker.removePendingTicket(ticketId, agentId);
          log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
          results.push({ ticketId, dispatched: false, pruned: true });
          continue;
        }
      } else {
        // Default: use checkLinearIssueRouting for rich result so failOpenBehavior can apply
        const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
        // AI-2295: the stored reason may be any RoutingReason — department-prefix
        // and steward-escalation included. The old cast narrowed the type to the
        // delegate/assignee/mention set, which hid the fact that roster-fanout
        // reasons flow through this check too and were bypassing every prune.
        const effectiveReason = (storedReason ?? "delegate") as RoutingReason;
        const routingResult = await checkLinearIssueRouting(ticketId, agentId, effectiveReason);

        if (!routingResult.actionable) {
          if (claimedSession) sessionTracker.endSession(agentId, ticketId);
          bag.removeTicket(agentId, ticketId);
          sessionTracker.removePendingTicket(ticketId, agentId);
          log.info(`Pruned non-actionable pending ticket for ${agentId} [${ticketId}] before wake-up dispatch`);
          results.push({ ticketId, dispatched: false, pruned: true });
          continue;
        }

        if (routingResult.failOpen && options.failOpenBehavior === "defer") {
          // Transient error during routing check: defer dispatch rather than risk waking an agent
          // for a ticket that may be Done. Ticket stays in bag for re-check on next connector start.
          if (claimedSession) sessionTracker.endSession(agentId, ticketId);
          log.info(`Deferring fail-open pending ticket for ${agentId} [${ticketId}] — routing check uncertain, will retry on next startup`);
          results.push({ ticketId, dispatched: false, deferred: true });
          continue;
        }
      }

      // Use a mention-specific wake message so the agent knows to observe, not own.
      const storedReason = bag.getTicketRoutingReason(agentId, ticketId);
      const isMention = storedReason === "mention" || storedReason === "body-mention";
      const ticketWakeConfig = isMention
        ? { ...wakeConfig, signalTemplate: MENTION_TICKET_TEMPLATE }
        : wakeConfig;

      // Record intent before delivery — prevents double-dispatch even on failure;
      // stale session detection handles cleanup if delivery never completes.
      // The active-session claim was already made atomically above (AI-2091 §7)
      // when markActive is set, so no second startSession is needed here.
      bag.recordSignal();

      // INF-982: when a stale-recovery fresh key is registered for this (agent, ticket),
      // pass the versioned key to the delivery layer instead of the normalized base key.
      // This creates a new OpenClaw session label so the stale-session forensics module
      // doesn't read the old zero-output session data on the next timeout.
      const freshRecoveryKey = options.staleRecoveryKeys
        ?.get(agentId)
        ?.get(ticketId);
      const dispatchTicketIds = freshRecoveryKey ? [freshRecoveryKey] : [ticketId];

      const wakeResult = await sendWakeUp(agentId, dispatchTicketIds, ticketWakeConfig);
      const wakeRunId = (wakeResult as { runId?: string; canonVersion?: string } | void | undefined)?.runId;

      // INF-1026: the active-session slot was claimed optimistically BEFORE delivery
      // (AI-2091 §7, to close the double-dispatch race). If delivery produced no real
      // gateway session (no runId), release the claim now — otherwise a PHANTOM
      // active-session lingers: `isActiveForTicket` reports the agent as "working" and
      // the active-session guard suppresses every future re-drive, so the agent goes
      // dark forever (confirmed live by Grover: igor stuck on linear-INF-995 with no
      // backing session). Only a confirmed runId keeps the claim.
      if (claimedSession && !wakeRunId && !usingInjectedWakeUp) {
        sessionTracker.endSession(agentId, ticketId);
        log.warn(
          `No session runId from wake for ${agentId} [${ticketId}] — releasing optimistic active-session claim (phantom-active guard, INF-1026)`,
        );
      }

      options.onDispatched?.(agentId, ticketId);
      results.push({ ticketId, dispatched: true, runId: wakeRunId, canonVersion: (wakeResult as { runId?: string; canonVersion?: string } | void | undefined)?.canonVersion ?? null });
    } catch (err) {
      log.error(
        `Re-signal failed for ${agentId} [${ticketId}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ ticketId, dispatched: false });
    }
  }

  return results;
}
