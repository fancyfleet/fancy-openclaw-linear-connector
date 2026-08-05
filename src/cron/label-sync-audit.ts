/**
 * AI-2554 — Label-sync audit cron (AC3).
 *
 * Periodic check: compares proxy-store (applied-state-store + enrolled-tickets-store)
 * label state against Linear's current state for enrolled tickets. Any divergence
 * is logged as a structured JSON warning for alerting infrastructure.
 *
 * Also supports on-webhook trigger (single-ticket check) via checkLabelSyncForTicket.
 */

import { componentLogger, createLogger } from "../logger.js";
import { registerCron, formatIntervalMs, markCronRun } from "./registry.js";
import {
  checkLabelSyncForTicket,
  checkLabelNativeStateSyncForTicket,
  emitLabelSyncWarning,
  emitLabelNativeSyncWarning,
  type LabelSyncAuditDivergence,
} from "../transition-audit.js";
import type { EnrolledTicketsStore } from "../store/enrolled-tickets-store.js";
import type { OperationalEventStore } from "../store/operational-event-store.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "label-sync-audit");

export interface LabelSyncAuditOptions {
  authToken: string | (() => string);
  enrolledTicketsStore?: EnrolledTicketsStore;
  /**
   * INF-1242 AC3: when provided, every divergence found (either the
   * proxy-vs-label kind or the new label-vs-native kind) is also appended as
   * a `label-sync-divergence` operational event, so it surfaces at /health
   * (see index.ts's /health handler) — not just in logs.
   */
  operationalEventStore?: OperationalEventStore;
  intervalMs?: number;
}

/**
 * INF-1242 AC3: append a `label-sync-divergence` operational event for a
 * detected divergence, alongside the existing log-line emit. Detail carries
 * both flavors' fields (unset ones are simply absent from the object) so
 * downstream consumers (like /health) can project either kind uniformly.
 */
function recordDivergenceEvent(
  store: OperationalEventStore | undefined,
  divergence: LabelSyncAuditDivergence,
): void {
  if (!store) return;
  const divergenceKind = divergence.kind ?? "proxy-vs-label";
  store.append({
    outcome: "label-sync-divergence",
    key: divergence.ticketId,
    sessionKey: divergence.ticketId,
    detail: {
      ticket: divergence.ticketId,
      divergenceKind,
      ...(divergenceKind === "proxy-vs-label"
        ? {
            proxyState: (divergence as { proxyState: string | null }).proxyState,
            linearState: (divergence as { linearState: string | null }).linearState,
            linearStateLabel: (divergence as { linearStateLabel: string | null }).linearStateLabel,
          }
        : {
            workflowId: (divergence as { workflowId: string }).workflowId,
            stateLabel: (divergence as { stateLabel: string | null }).stateLabel,
            expectedNativeState: (divergence as { expectedNativeState: string | null }).expectedNativeState,
            actualNativeStateName: (divergence as { actualNativeStateName: string | null }).actualNativeStateName,
          }),
    },
  });
}

export interface LabelSyncAuditResult {
  scanned: number;
  divergencesFound: number;
  errors: string[];
}

/**
 * Run a full label-sync audit pass: scan all enrolled tickets and check each
 * one for proxy-store vs Linear label divergence.
 *
 * Only checks tickets where the proxy has a recorded state in the
 * applied-state-store (i.e., tickets the connector has recently transitioned).
 */
export async function runLabelSyncAuditPass(
  opts: LabelSyncAuditOptions,
): Promise<LabelSyncAuditResult> {
  const { enrolledTicketsStore } = opts;
  // INF-683: resolve the token at pass time (getter) so the boot/~20h token
  // refresh can't strand a value captured at registration.
  const authToken = typeof opts.authToken === "function" ? opts.authToken() : opts.authToken;
  const result: LabelSyncAuditResult = {
    scanned: 0,
    divergencesFound: 0,
    errors: [],
  };

  if (!enrolledTicketsStore) {
    // Without an enrolled-tickets store, fall back to the applied-state-store
    // which tracks recent transitions only. This is inherently incomplete but
    // better than nothing.
    log.warn(
      "[label-sync-audit] No enrolledTicketsStore available — skip full scan; " +
      "only post-transition verification will run for recently-touched tickets.",
    );
    return result;
  }

  const allTickets = enrolledTicketsStore.getAll();
  result.scanned = allTickets.length;

  for (const ticket of allTickets) {
    try {
      // Skip terminal tickets — they're not expected to have active label state.
      if (ticket.terminal) continue;

      const divergence = await checkLabelSyncForTicket(ticket.ticket_id, authToken);
      if (divergence) {
        result.divergencesFound++;
        // Compute approximate age from the enrolled-tickets store's entered_state_at.
        const enteredMs = new Date(ticket.entered_state_at).getTime();
        const ageSec = Math.round((Date.now() - enteredMs) / 1000);
        divergence.ageSec = ageSec;
        emitLabelSyncWarning(divergence);
        recordDivergenceEvent(opts.operationalEventStore, divergence);
      }

      // INF-1242 AC3: `state:*` label vs native Linear workflow status —
      // distinct pairing from the proxy-vs-label check above. Reuses
      // ticket.workflow, already available on the enrolled-tickets mirror row.
      const nativeDivergence = await checkLabelNativeStateSyncForTicket(
        ticket.ticket_id,
        ticket.workflow,
        authToken,
      );
      if (nativeDivergence) {
        result.divergencesFound++;
        emitLabelNativeSyncWarning(nativeDivergence);
        recordDivergenceEvent(opts.operationalEventStore, nativeDivergence);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${ticket.ticket_id}: ${msg}`);
      log.warn(`[label-sync-audit] scan error for ${ticket.ticket_id}: ${msg}`);
    }
  }

  if (result.divergencesFound > 0 || result.errors.length > 0) {
    log.info(
      `[label-sync-audit] Pass: scanned=${result.scanned} ` +
      `divergences=${result.divergencesFound} errors=${result.errors.length}`,
    );
  }

  return result;
}

/**
 * Register the periodic label-sync audit cron.
 * Defaults to every 15 minutes (same as anti-entropy).
 */
export function registerLabelSyncAuditCron(opts: LabelSyncAuditOptions): ReturnType<typeof setInterval> {
  const intervalMs = opts.intervalMs ?? (
    process.env.LABEL_SYNC_AUDIT_INTERVAL
      ? parseInt(process.env.LABEL_SYNC_AUDIT_INTERVAL, 10)
      : 15 * 60 * 1000
  );

  registerCron("label-sync-audit", `every ${formatIntervalMs(intervalMs)}`);
  const timer = setInterval(() => {
    void (async () => {
      try {
        const result = await runLabelSyncAuditPass(opts);
        if (result.divergencesFound > 0 || result.errors.length > 0) {
          log.info(
            `[label-sync-audit] Scheduled pass: scanned=${result.scanned} ` +
            `divergences=${result.divergencesFound} errors=${result.errors.length}`,
          );
        }
      } catch (err) {
        log.error(
          `[label-sync-audit] Scheduled pass failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        markCronRun("label-sync-audit");
      }
    })();
  }, intervalMs);

  timer.unref();
  return timer;
}
