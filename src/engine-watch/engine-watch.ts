/**
 * INF-1302 — engine-watch signal-to-ticket pipeline
 *
 * STUB ONLY — RED phase. Implementer must replace with real classification,
 * dedup, and summary logic per AC1–AC5. This stub makes the test suite
 * collect and fail with behavioral assertions, rather than failing to
 * resolve at all (which also counts as RED but hides per-AC results).
 */

export type TicketRef = { id: string; identifier: string; state: string; stateType: string; url?: string };
export type Signal = { id: string; class: string; evidence: string; source?: string; runId?: string; observedAt?: string };
export type Disposition =
  | { kind: "attached-active-owner"; signalId: string; ownerTicket: TicketRef }
  | { kind: "recurrence-with-followup"; signalId: string; terminalOwner: TicketRef; followupTicket: TicketRef }
  | { kind: "new-fix-ticket"; signalId: string; createdTicket: TicketRef }
  | { kind: "non-actionable"; signalId: string; reason: string };

export function classifySignal(): Disposition {
  throw new Error("engine-watch not implemented — INF-1302 RED");
}

export function buildEngineWatchSummary(): string {
  throw new Error("engine-watch not implemented — INF-1302 RED");
}

export function getDedupKey(): string {
  throw new Error("engine-watch not implemented — INF-1302 RED");
}
