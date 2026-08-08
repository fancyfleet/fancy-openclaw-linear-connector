/**
 * INF-1302 — engine-watch periodic signal-to-ticket pipeline cron.
 *
 * Scans signals, classifies each, dedups, and files follow-up tickets via the
 * Linear API only when a service credential is available. Registration is via
 * registerEngineWatchCron() called from inside createApp() so /health.crons
 * proves bootstrap wiring (AC6, AI-1810).
 *
 * R2: production collector is wired to the live operational-event store (and
 * other liveness sources) so the tick classifies real recurrence, not an empty
 * stub. The collector is injectable for tests so the two regression shapes can
 * be driven through the real tick path and verified end-to-end.
 */

import { createModuleLogger } from "../logging.js";
import { registerCron, formatIntervalMs, markCronRunSuccess, markCronRunFailure } from "./registry.js";
import { resolveServiceCredential } from "../service-credential.js";
import {
  markEngineWatchScheduled,
  recordEngineWatchRun,
  recordEngineWatchSkip,
  recordEngineWatchFail,
} from "../engine-watch-state.js";
import {
  classifySignal,
  buildEngineWatchSummary,
  getDedupKey,
  peekDedupActiveTicket,
  type Signal,
  type TicketRef,
  type Disposition,
} from "../engine-watch/engine-watch.js";
import { LINEAR_API_URL } from "../linear-helpers.js";

const log = createModuleLogger("engine-watch");

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15m

// ── Interval parsing ────────────────────────────────────────────────────────

function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return DEFAULT_INTERVAL_MS;
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: return DEFAULT_INTERVAL_MS;
  }
}

function resolveIntervalMs(): number {
  const raw = process.env.ENGINE_WATCH_INTERVAL;
  if (!raw) return DEFAULT_INTERVAL_MS;
  return parseIntervalMs(raw);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type EngineWatchSignalSource = () => Signal[] | Promise<Signal[]>;

export interface EngineWatchCronOptions {
  intervalMs?: number;
  /** Override the signal collector (tests inject synthetic signals). */
  collectSignals?: EngineWatchSignalSource;
  /** Resolve the closest class-owner and active follow-up for a signal. */
  resolveOwner?: (signal: Signal) => Promise<{ closestOwner: TicketRef | null; activeFollowup: TicketRef | null }>;
  /** Create a follow-up / new fix ticket for a signal. */
  createTicket?: (signal: Signal) => Promise<TicketRef>;
  /** Injected for production default collector; also used by defaultResolveOwner/createTicket. */
  operationalEventStore?: unknown;
}

// ── Default collector: derive signals from live operational events ─────────

function detailText(detail: unknown, errorSummary: string | null): string {
  try {
    if (detail && typeof detail === "object") return JSON.stringify(detail).slice(0, 800);
    if (typeof detail === "string") return detail.slice(0, 800);
  } catch { /* ignore */ }
  return (errorSummary ?? "").slice(0, 800);
}

export function defaultCollectSignalsFromStore(
  operationalEventStore?: EngineWatchCronOptions["operationalEventStore"],
): Signal[] {
  if (!operationalEventStore || typeof (operationalEventStore as { query?: unknown }).query !== "function") return [];
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const events = (operationalEventStore as { query: (q: unknown) => Array<{ id: number; occurredAt: string; outcome: string; key: string | null; errorSummary: string | null; detail: unknown }> }).query({ since, limit: 500 } as unknown) as Array<{
      id: number; occurredAt: string; outcome: string; key: string | null; errorSummary: string | null; detail: unknown;
    }>;
    const signals: Signal[] = [];
    const seenKeys = new Set<string>();
    for (const ev of events) {
      const text = `${ev.outcome} ${ev.errorSummary ?? ""} ${detailText(ev.detail, ev.errorSummary)}`.toLowerCase();
      const ticketHint = ev.key ?? "";
      // — migrate-state client-error / delegate-repair recurrence (INF-1288 shape)
      if (
        text.includes("migrate-state") ||
        (text.includes("migrate") && text.includes("delegate")) ||
        text.includes("old client still prints success") ||
        (ev.outcome === "def-state-migrated" && text.includes("migrate"))
      ) {
        const key = `migrate-state-client-error::${ticketHint}::${ev.outcome}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        signals.push({
          id: `sig-migrate-${ev.id}`,
          class: "migrate-state-client-error",
          evidence: `[${ev.outcome}] ${ev.errorSummary ?? detailText(ev.detail, ev.errorSummary)} — delegate repair needed (ticket ${ticketHint})`.slice(0, 900),
          source: "operational-event",
          observedAt: ev.occurredAt,
        });
        continue;
      }
      // — xfn/intake recovery losing true workflow position (INF-1230/INF-1298 shape)
      if (
        text.includes("xfn") ||
        text.includes("intake") && text.includes("workflow position") ||
        text.includes("stale") && text.includes("routing") ||
        ev.outcome === "xfn-demoted" ||
        text.includes("lost true workflow position")
      ) {
        const key = `xfn-intake-recovery-stale-routing::${ticketHint}::${ev.outcome}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        signals.push({
          id: `sig-xfn-${ev.id}`,
          class: "xfn-intake-recovery-stale-routing",
          evidence: `[${ev.outcome}] ${ev.errorSummary ?? detailText(ev.detail, ev.errorSummary)} — xfn/intake recovery lost true workflow position (ticket ${ticketHint})`.slice(0, 900),
          source: "operational-event",
          observedAt: ev.occurredAt,
        });
        continue;
      }
      // — generic dispatch-undeliverable / no-activity / stale-cron signals
      if (
        ev.outcome === "dispatch-undeliverable" ||
        ev.outcome === "no-activity-failed" ||
        ev.outcome === "stale-c4-repoke-failed" ||
        text.includes("critical-stale-cron")
      ) {
        const key = `${ev.outcome}::${ticketHint}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        signals.push({
          id: `sig-${ev.outcome}-${ev.id}`,
          class: ev.outcome,
          evidence: `[${ev.outcome}] ${ev.errorSummary ?? detailText(ev.detail, ev.errorSummary)}`.slice(0, 900),
          source: "operational-event",
          observedAt: ev.occurredAt,
        });
      }
    }
    return signals;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[engine-watch] defaultCollect failed: ${msg}`);
    recordEngineWatchFail(msg);
    markCronRunFailure("engine-watch", err instanceof Error ? err : new Error(msg));
    throw err;
  }
}

// ── Default owner/ticket helpers (Linear API) ───────────────────────────────

async function fetchTicketByIdentifier(identifier: string, authToken: string): Promise<TicketRef | null> {
  try {
    const query = `query IssueByIdentifier($id: String!) { issue(id: $id) { id identifier state { type name } team { id } } }`;
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}` },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { issue?: { id: string; identifier: string; state: { type: string; name: string }; team?: { id: string } } } };
    const issue = body.data?.issue;
    if (!issue) return null;
    return { id: issue.id, identifier: issue.identifier, state: issue.state?.name ?? "unknown", stateType: issue.state?.type ?? "unknown" };
  } catch { return null; }
}

export async function searchActiveTicketForClass(signalClass: string, authToken: string): Promise<TicketRef | null> {
  try {
    const query = `query SearchIssues($filter: IssueFilter) { issues(filter: $filter, first: 50) { nodes { id identifier title labels { nodes { name } } state { type name } } } }`;
    const filter = { state: { type: { nin: ["completed", "canceled"] } } };
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}` },
      body: JSON.stringify({ query, variables: { filter } }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { issues?: { nodes: Array<{ id: string; identifier: string; title: string; state: { type: string; name: string }; labels: { nodes: Array<{ name: string }> } }> } } };
    const nodes = body.data?.issues?.nodes ?? [];
    const hint = signalClass.toLowerCase();
    const classPrefix = `[engine-watch] ${signalClass.toLowerCase()}`;
    for (const n of nodes) {
      const labelText = n.labels.nodes.map((l) => l.name.toLowerCase()).join(" ");
      const titleLower = (n.title ?? "").toLowerCase();
      if (
        titleLower.includes(classPrefix) ||
        labelText.includes(`engine-watch:${hint}`) ||
        labelText.includes(hint.split("-")[0]) ||
        n.identifier.toLowerCase().includes(hint.slice(0, 3))
      ) {
        return { id: n.id, identifier: n.identifier, state: n.state?.name ?? "unknown", stateType: n.state?.type ?? "unknown" };
      }
    }
    return null;
  } catch { return null; }
}

async function defaultResolveOwner(signal: Signal, authToken: string): Promise<{ closestOwner: TicketRef | null; activeFollowup: TicketRef | null }> {
  // Try to extract a ticket identifier from evidence (e.g., INF-1288, INF-1230).
  const m = signal.evidence.match(/[A-Z]+-\d+/);
  if (m) {
    const t = await fetchTicketByIdentifier(m[0], authToken);
    if (t) {
      // If terminal, look for an active follow-up with similar class.
      const isTerminal = t.stateType === "completed" || t.stateType === "canceled";
      if (isTerminal) {
        const followup = await searchActiveTicketForClass(signal.class, authToken);
        return { closestOwner: t, activeFollowup: followup };
      }
      return { closestOwner: t, activeFollowup: null };
    }
  }
  // Fallback: search for active owner by class.
  const active = await searchActiveTicketForClass(signal.class, authToken);
  if (active) return { closestOwner: active, activeFollowup: null };
  return { closestOwner: null, activeFollowup: null };
}

async function defaultCreateTicket(signal: Signal, authToken: string): Promise<TicketRef> {
  let teamId = "";
  try {
    const teamQuery = `query Teams { teams(first: 5) { nodes { id } } }`;
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}` },
      body: JSON.stringify({ query: teamQuery, variables: {} }),
    });
    const body = (await res.json()) as { data?: { teams?: { nodes: Array<{ id: string }> } } };
    teamId = body.data?.teams?.nodes?.[0]?.id ?? "";
  } catch { /* ignore */ }
  const title = `[engine-watch] ${signal.class} recurrence — ${signal.evidence.slice(0, 80)}`;
  const description = `Automated engine-watch follow-up for signal \`${signal.id}\` (class \`${signal.class}\`).\n\nEvidence:\n${signal.evidence}\n\nSource: ${signal.source ?? "unknown"} observedAt: ${signal.observedAt ?? "unknown"}`;
  // Resolve a stable class-hint label so follow-ups are discoverable via
  // searchActiveTicketForClass on the next tick (AC4 cross-tick dedup).
  let labelIds: string[] | undefined;
  if (teamId) {
    try {
      const { findOrCreateLabel } = await import("../linear-helpers.js");
      const labelId = await findOrCreateLabel(teamId, `engine-watch:${signal.class}`, authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`);
      if (labelId) labelIds = [labelId];
    } catch { /* best-effort — creation still proceeds without label */ }
  }
  try {
    const mutation = labelIds
      ? `mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $labelIds: [String!]!) { issueCreate(input: { teamId: $teamId, title: $title, description: $description, labelIds: $labelIds }) { success issue { id identifier state { type name } } } }`
      : `mutation CreateIssue($teamId: String!, $title: String!, $description: String!) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { id identifier state { type name } } } }`;
    const variables: Record<string, unknown> = { teamId, title, description };
    if (labelIds) variables.labelIds = labelIds;
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}` },
      body: JSON.stringify({ query: mutation, variables }),
    });
    const body = (await res.json()) as { data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string; state: { type: string; name: string } } } } };
    const issue = body.data?.issueCreate?.issue;
    if (issue) return { id: issue.id, identifier: issue.identifier, state: issue.state?.name ?? "To Do", stateType: issue.state?.type ?? "unstarted" };
  } catch { /* fall through */ }
  return { id: `engine-watch-${signal.id}`, identifier: `INF-EW-${Date.now()}`, state: "To Do", stateType: "unstarted" };
}

// ── Tick ────────────────────────────────────────────────────────────────────

let activeOptions: EngineWatchCronOptions | null = null;

export async function runEngineWatchTick(opts: EngineWatchCronOptions = {}): Promise<{ signals: number; dispositions: number; summary: string; dispositionsList: Disposition[] }> {
  const authToken = resolveServiceCredential();
  if (!authToken) {
    const reason = "No service credential configured — skipping engine-watch tick";
    log.warn(`[engine-watch] ${reason}`);
    recordEngineWatchSkip(reason);
    markCronRunFailure("engine-watch", reason);
    return { signals: 0, dispositions: 0, summary: reason, dispositionsList: [] };
  }

  const effective: EngineWatchCronOptions = { ...activeOptions, ...opts };
  // Collector: explicit override > activeOptions > default store-backed collector
  const collect: EngineWatchSignalSource = effective.collectSignals
    ?? (activeOptions?.collectSignals ?? (() => defaultCollectSignalsFromStore(effective.operationalEventStore ?? activeOptions?.operationalEventStore)));

  let signals: Signal[] = [];
  try {
    const raw = await collect();
    signals = Array.isArray(raw) ? raw : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[engine-watch] collectSignals failed: ${msg}`);
    recordEngineWatchFail(msg);
    markCronRunFailure("engine-watch", err);
    throw err;
  }

  if (signals.length === 0) {
    const summary = buildEngineWatchSummary([]);
    recordEngineWatchRun({ signals: 0, dispositions: 0, summary });
    markCronRunSuccess("engine-watch");
    return { signals: 0, dispositions: 0, summary, dispositionsList: [] };
  }

  const dispositions: Disposition[] = [];
  for (const signal of signals) {
    let ownerCtx = effective.resolveOwner
      ? await effective.resolveOwner(signal)
      : await defaultResolveOwner(signal, authToken);

    // Cross-tick dedup (AC4): consult the in-process dedup registry BEFORE
    // creating a ticket. If an active follow-up for this class::evidence was
    // already created on a prior tick, reuse it so we do not file a duplicate.
    // This applies to both the terminal-owner branch and the no-owner branch.
    if (!ownerCtx.activeFollowup) {
      const dedupActive = peekDedupActiveTicket(signal);
      if (dedupActive) {
        const isTerminal = !!ownerCtx.closestOwner && (ownerCtx.closestOwner.stateType === "completed" || ownerCtx.closestOwner.stateType === "canceled");
        if (isTerminal || !ownerCtx.closestOwner) {
          ownerCtx = { ...ownerCtx, activeFollowup: dedupActive };
        }
      }
    }

    const isTerminal = !!ownerCtx.closestOwner && (ownerCtx.closestOwner.stateType === "completed" || ownerCtx.closestOwner.stateType === "canceled");
    const needsCreation = !ownerCtx.closestOwner || (isTerminal && !ownerCtx.activeFollowup);

    let createdTicket: TicketRef | null = null;
    if (needsCreation) {
      // Re-check dedup immediately before creation to close the race where
      // a concurrent caller populated the registry after the pre-check above.
      const lateDedup = peekDedupActiveTicket(signal);
      if (lateDedup) {
        ownerCtx = { ...ownerCtx, activeFollowup: lateDedup };
      } else {
        try {
          if (effective.createTicket) createdTicket = await effective.createTicket(signal);
          else createdTicket = await defaultCreateTicket(signal, authToken);
        } catch (err) {
          log.warn(`[engine-watch] createTicket failed for ${signal.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const disposition = classifySignal(signal, {
      closestOwner: ownerCtx.closestOwner,
      activeFollowup: ownerCtx.activeFollowup ?? createdTicket,
      createTicket: (s) => {
        if (createdTicket) return createdTicket;
        const dedup = peekDedupActiveTicket(s);
        if (dedup) return dedup;
        return { id: `engine-watch-${s.id}`, identifier: `INF-EW-${Date.now()}`, state: "To Do", stateType: "unstarted" };
      },
    });

    dispositions.push(disposition);
  }

  const summary = buildEngineWatchSummary(dispositions);
  recordEngineWatchRun({ signals: signals.length, dispositions: dispositions.length, summary });
  markCronRunSuccess("engine-watch");
  log.info(`[engine-watch] tick complete — ${signals.length} signal(s), ${dispositions.length} disposition(s)\n${summary}`);
  return { signals: signals.length, dispositions: dispositions.length, summary, dispositionsList: dispositions };
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerEngineWatchCron(options: EngineWatchCronOptions = {}): void {
  const intervalMs = options.intervalMs ?? resolveIntervalMs();
  activeOptions = options;
  registerCron("engine-watch", `every ${formatIntervalMs(intervalMs)}`);
  markEngineWatchScheduled();

  const firstRun = setTimeout(() => {
    void runEngineWatchTick(options).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[engine-watch] first run failed: ${msg}`);
      recordEngineWatchFail(msg);
      markCronRunFailure("engine-watch", err);
    });
  }, 0);
  if (process.env.NODE_ENV !== "test") firstRun.unref();

  const timer = setInterval(() => {
    void runEngineWatchTick(options).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[engine-watch] periodic run failed: ${msg}`);
      recordEngineWatchFail(msg);
      markCronRunFailure("engine-watch", err);
    });
  }, intervalMs);
  if (process.env.NODE_ENV !== "test") timer.unref();

  log.info(`[engine-watch] engine-watch scheduled every ${formatIntervalMs(intervalMs)} — first run queued immediately`);
}

/** Test-only: trigger one tick with optional overrides (bypasses auth check when collectSignals is injected). */
export async function triggerEngineWatchForTest(overrides: EngineWatchCronOptions = {}): Promise<{ signals: number; dispositions: number; summary: string; dispositionsList: Disposition[] }> {
  return runEngineWatchTick(overrides);
}

/** Test-only: reset module state between cases. */
export function resetEngineWatchCronForTest(): void {
  activeOptions = null;
}
