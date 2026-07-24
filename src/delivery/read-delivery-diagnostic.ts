/**
 * INF-507 — production reader that surfaces the last dispatch failure's
 * structured diagnostic to the first-action watchdog.
 *
 * `deliver-with-ack.ts` already persists a {@link DeliveryDiagnostic} on the
 * `detail.diagnostic` of every `delivery-failed` attempt and the terminal
 * `dispatch-undeliverable` record (AC2). This helper is the read side: given a
 * ticket, it returns the diagnostic from that ticket's most recent failure
 * event so the watchdog can turn a blank "unreachable" into a model-named,
 * error-classed verdict — without a gateway-log dig.
 *
 * It is the production supply for `registerFirstActionWatchdogCron`'s optional
 * `getDeliveryDiagnostic` hook. Ai's INF-507 validation flagged that the hook
 * was coded + unit-tested but never wired in prod, so the loudest human-facing
 * surface (the on-call alert) still emitted the generic title. This closes that
 * gap on the awaited `/v1` path, which AC2 already populates — no gateway emit
 * (INF-514) required.
 */

import { tryNormalizeSessionKey } from "../session-key.js";
import type { DeliveryDiagnostic, DispatchErrorClass } from "./delivery-diagnostic.js";

/** Failure outcomes that may carry a `detail.diagnostic`. */
const DIAGNOSTIC_OUTCOMES = new Set(["delivery-failed", "dispatch-undeliverable"]);

const ERROR_CLASSES = new Set<DispatchErrorClass>([
  "context-overflow",
  "timeout",
  "unreachable",
  "provider-error",
  "unknown",
]);

/** The slice of the operational event store this reader needs. Kept minimal so
 *  the wiring is trivially unit-testable with a fake and never drags the whole
 *  store type through. */
export interface DiagnosticEventSource {
  query(q: { key?: string; limit?: number }): Array<{ outcome: string; detail: unknown }>;
}

/** Narrowing guard: a persisted `detail.diagnostic` must round-trip back into a
 *  well-formed DeliveryDiagnostic (a valid `errorClass` + a `summary` string)
 *  before we trust it to shape an alert. Anything else is treated as absent. */
function asDiagnostic(value: unknown): DeliveryDiagnostic | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (typeof d.errorClass !== "string" || !ERROR_CLASSES.has(d.errorClass as DispatchErrorClass)) {
    return null;
  }
  if (typeof d.summary !== "string") return null;
  return value as DeliveryDiagnostic;
}

/**
 * Return the structured diagnostic from the ticket's most recent
 * `delivery-failed` / `dispatch-undeliverable` event, or `null` when none is
 * captured. The store returns events newest-first, so the first matching event
 * with a valid `detail.diagnostic` wins.
 *
 * Never throws — a malformed store row, an unparseable ticket id, or a missing
 * diagnostic all resolve to `null` so the watchdog ladder is never blocked.
 */
export function readLastDeliveryDiagnostic(
  store: DiagnosticEventSource,
  ticket: string,
): DeliveryDiagnostic | null {
  // deliver-with-ack keys events under the normalized `linear-<TEAM>-<n>` form;
  // the watchdog hands us the bare identifier, so normalize both to match.
  const key = tryNormalizeSessionKey(ticket) ?? `linear-${ticket}`;
  let events: Array<{ outcome: string; detail: unknown }>;
  try {
    events = store.query({ key, limit: 50 });
  } catch {
    return null;
  }
  for (const event of events) {
    if (!DIAGNOSTIC_OUTCOMES.has(event.outcome)) continue;
    const detail = event.detail;
    if (!detail || typeof detail !== "object") continue;
    const diagnostic = asDiagnostic((detail as Record<string, unknown>).diagnostic);
    if (diagnostic) return diagnostic;
  }
  return null;
}
