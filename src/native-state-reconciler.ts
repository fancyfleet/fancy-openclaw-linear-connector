/**
 * INF-993 — Native Linear state reconciler.
 *
 * Projects the connector's source-of-truth (workflow-state + session liveness)
 * back onto the *visible native Linear state*. The detection half of a diverged
 * workflow already exists in three places (`first-action-watchdog.ts`
 * SESSION_DEAD classification, `rescue-sweep.ts` labels+delegate,
 * `oob-reconcile-sweep.ts` bypass surfacing) — but none of them writes native
 * state back, so on a confirmed-dead session the native state keeps lying (e.g.
 * stays "Thinking") while the watchdog drives redispatch/escalate. This module
 * is the user-facing write-back complement.
 *
 * Source-of-truth contract (FROZEN, from the ticket):
 *   - Source of truth = connector workflow-state + session liveness.
 *   - The corrective native write fires on a **confirmed-dead** session only
 *     (SESSION_DEAD). NEVER on "quiet-for-N-minutes" / live-but-slow.
 *   - Connector-ahead advances native state **only on a completion receipt**
 *     (merged PR / deploy evidence), never on inference.
 *
 * The reconciler is deliberately I/O-injected: it reads workflow state and
 * liveness facts from an injected `listTickets`, resolves native Linear state
 * ids via `resolveNativeStateId`, performs a single *verified* `writeNativeState`
 * per ticket, and exposes liveness for /health. This keeps the corrective logic
 * (AC1–AC4) unit-testable with mocks while the production data-plane (below)
 * wires the same contract to live Linear I/O.
 */

import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";
import { getFirstActionWatchdogState } from "./first-action-watchdog-state.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "native-state-reconciler");

const CRON_NAME = "native-state-reconciler";
const DEFAULT_CADENCE_MS = 5 * 60 * 1000; // 5m

/** Native state names the reconciler drives toward. */
const STATE_TODO = "To Do";
const STATE_DONE = "Done";

/**
 * Session liveness classification. The corrective trigger is SESSION_DEAD
 * (confirmed-dead) only — LIVE_BUT_SLOW and LIVE never cause a corrective
 * revert (false-positive guard, INF-940 / INF-982).
 */
export type Liveness =
  | { kind: "SESSION_DEAD" }
  | { kind: "LIVE_BUT_SLOW" }
  | { kind: "LIVE" };

/** One ticket's reconcilable facts, as read from the connector + Linear. */
export interface ReconcileTicket {
  identifier: string;
  issueId: string;
  workflow: string;
  /** Connector workflow-state (source of truth). */
  connectorState: string;
  nativeStateId: string;
  nativeStateName: string;
  delegateId: string | null;
  assigneeId: string | null;
  liveness: Liveness;
  /** Present iff a completion receipt exists (merged PR / deploy). */
  completionReceipt?: "merged-pr" | "deploy";
  /** A connector-ahead signal that is NOT completion evidence. */
  nonEvidenceSignal?: "label-ahead" | "delegate-ahead" | "quiet-for-n-minutes";
}

/** Result shape returned to `markCronRun`/callers and asserted by tests. */
export interface NativeStateReconcilerResult {
  /** Tickets whose native state was successfully corrected. */
  corrected: number;
  /** Tickets where a write was attempted but did not land / errored. */
  failed: number;
  /** Structured errors for failed corrections. */
  errors: Array<{ ticket: string; message: string }>;
}

/** Result of a single verified native write. */
export interface NativeWriteResult {
  success: boolean;
  issue?: {
    id?: string;
    state?: { id?: string } | null;
    delegate?: { id?: string } | null;
    assignee?: { id?: string } | null;
  };
}

export interface NativeStateReconcilerOpts {
  listTickets: () => Promise<ReconcileTicket[]>;
  resolveNativeStateId: (stateName: string) => Promise<string>;
  writeNativeState: (
    issueId: string,
    input: Record<string, unknown>,
  ) => Promise<NativeWriteResult>;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

/**
 * Decide the corrective native write for a ticket, or `null` for no-op.
 *
 * SESSION_DEAD → revert native to "To Do", RETAIN the delegate so re-dispatch
 * still targets the owner (AC1). Connector-ahead advances to "Done" ONLY when a
 * completion receipt is present (AC2). LIVE_BUT_SLOW / LIVE without evidence →
 * no write (AC3). A no-op is also returned when native state already matches the
 * target, so a healthy ticket is never needlessly mutated.
 */
function planCorrection(t: ReconcileTicket): { stateName: string } | null {
  if (t.liveness.kind === "SESSION_DEAD") {
    // Corrective revert: the session is confirmed dead, so the native state is
    // lying. Send it back to To Do (retaining the delegate) for re-dispatch.
    if (t.nativeStateName === STATE_TODO) return null; // already correct
    return { stateName: STATE_TODO };
  }

  // Connector-ahead advance-on-evidence: advance native ONLY on a completion
  // receipt (merged PR / deploy). A non-evidence signal (label/delegate ahead,
  // quiet-for-N-minutes) never advances native state.
  if (t.completionReceipt) {
    if (t.nativeStateName === STATE_DONE) return null; // already advanced
    return { stateName: STATE_DONE };
  }

  // LIVE_BUT_SLOW, LIVE without evidence, or a bare non-evidence signal:
  // the false-positive guard means we do nothing.
  return null;
}

/**
 * Run one reconciliation sweep. For each ticket needing a correction, resolve
 * the target native state id, perform a single paired write, and VERIFY the
 * returned native state reflects the write (AI-1395 / INF-724 desync class):
 * Linear silently drops a `stateId`/`delegateId` write to an app user unless
 * `assigneeId` is paired in the same mutation, so we always pair `assigneeId`
 * and treat a returned pre-write state as a failed correction (AC4).
 */
export async function runNativeStateReconcilerSweep(
  opts: NativeStateReconcilerOpts,
): Promise<NativeStateReconcilerResult> {
  const result: NativeStateReconcilerResult = { corrected: 0, failed: 0, errors: [] };

  let tickets: ReconcileTicket[];
  try {
    tickets = await opts.listTickets();
  } catch (err) {
    result.failed += 1;
    result.errors.push({
      ticket: "*",
      message: `native state reconciler: listTickets failed: ${errMsg(err)}`,
    });
    return result;
  }

  for (const t of tickets) {
    const plan = planCorrection(t);
    if (!plan) continue;

    try {
      const stateId = await opts.resolveNativeStateId(plan.stateName);

      // Pair `assigneeId` in the SAME mutation so Linear cannot silently drop
      // the app-user native write (AI-1395 / INF-724). Retain the delegate.
      const input: Record<string, unknown> = {
        stateId,
        delegateId: t.delegateId,
        assigneeId: t.assigneeId,
      };

      const write = await opts.writeNativeState(t.issueId, input);

      const returnedStateId = write?.issue?.state?.id;
      if (!write?.success || returnedStateId !== stateId) {
        result.failed += 1;
        result.errors.push({
          ticket: t.identifier,
          message:
            `native state write for ${t.identifier} did not land ` +
            `(expected ${stateId}, Linear returned ${returnedStateId ?? "none"})`,
        });
        continue;
      }

      result.corrected += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        ticket: t.identifier,
        message: `native state write for ${t.identifier} did not land: ${errMsg(err)}`,
      });
    }
  }

  return result;
}

// ── Liveness (surfaced at /health.nativeStateReconciler) ────────────────────

interface ReconcilerLiveness {
  /** True once the cron is registered (armed and scheduled). */
  scheduled: boolean;
  /**
   * ISO timestamp. Stamped at registration so liveness is observable at
   * ac-validate WITHOUT waiting for the trigger condition (AC5), then
   * re-stamped at the end of every sweep.
   */
  lastRunAt: string;
  /** Rolling result of the most recent sweep, or null before the first run. */
  lastResult: NativeStateReconcilerResult | null;
}

let liveness: ReconcilerLiveness = {
  scheduled: false,
  lastRunAt: new Date(0).toISOString(),
  lastResult: null,
};

/** Liveness view for /health — proves the reconciler is scheduled/subscribed. */
export function getNativeStateReconcilerLiveness(): ReconcilerLiveness {
  return {
    scheduled: liveness.scheduled,
    lastRunAt: liveness.lastRunAt,
    lastResult: liveness.lastResult
      ? { ...liveness.lastResult, errors: liveness.lastResult.errors.map((e) => ({ ...e })) }
      : null,
  };
}

/** Test-only: reset module-level liveness between cases. */
export function resetNativeStateReconcilerForTest(): void {
  liveness = {
    scheduled: false,
    lastRunAt: new Date(0).toISOString(),
    lastResult: null,
  };
}

// ── Cron registration (AI-1810 registry ⇒ /health.crons) ────────────────────

export interface RegisterNativeStateReconcilerOpts extends NativeStateReconcilerOpts {
  /** Sweep cadence; defaults to 5m. */
  cadenceMs?: number;
}

/**
 * Register the native-state reconciler as a recurring interval timer.
 *
 * Records itself in the cron registry (so /health.crons enumerates it) and
 * marks liveness scheduled at the moment the timer is armed — importing the
 * module is NOT enough to appear, only a real bootstrap call is (AI-1808).
 * Returns the timer so the caller can clear it on shutdown.
 */
export function registerNativeStateReconcilerCron(
  opts: RegisterNativeStateReconcilerOpts,
): NodeJS.Timeout {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;

  registerCron(CRON_NAME, `every ${formatIntervalMs(cadenceMs)} (${cadenceMs}ms)`);
  liveness.scheduled = true;
  // Stamp at registration so /health liveness is observable immediately, before
  // the first tick fires (AC5: "without waiting for a trigger").
  liveness.lastRunAt = new Date().toISOString();

  const runOnce = async () => {
    try {
      const res = await runNativeStateReconcilerSweep(opts);
      liveness.lastResult = res;
      if (res.failed > 0) {
        for (const e of res.errors) {
          log.error(`native-state-reconciler: ${e.message}`);
        }
      }
      if (res.corrected > 0) {
        log.info(`native-state-reconciler: corrected ${res.corrected} native state(s)`);
      }
    } catch (err) {
      log.error(`native-state-reconciler: sweep failed: ${errMsg(err)}`);
    } finally {
      // Stamp the run and refresh /health liveness even on a thrown sweep.
      liveness.lastRunAt = new Date().toISOString();
      markCronRun(CRON_NAME);
    }
  };

  const timer = setInterval(() => void runOnce(), cadenceMs);
  timer.unref();

  log.info(`native-state-reconciler: cron registered (${cadenceMs}ms interval)`);
  return timer;
}

// ── Production data-plane (live Linear I/O) ──────────────────────────────────

/**
 * A confirmed-dead ticket candidate, as surfaced by the first-action watchdog.
 * The watchdog's terminal `unreachable: true` ladder IS the connector's
 * confirmed-dead signal (AC1: "the first-action-watchdog SESSION_DEAD branch"),
 * so the reconciler reuses it rather than inventing a new heuristic — which
 * would risk exactly the false-positive class the frozen contract forbids.
 */
interface DeadCandidate {
  identifier: string;
  connectorState: string;
}

const LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Build the production I/O for the reconciler, wired to live Linear + the
 * first-action watchdog ladder state.
 *
 * SESSION_DEAD candidates come from the watchdog's `unreachable` ladders. For
 * each, we read the issue's native state / delegate / assignee AND the team's
 * workflow states in a single query, so `resolveNativeStateId` maps a name to
 * the correct per-issue id. Live-but-slow ladders (armed, not yet unreachable)
 * are intentionally NOT surfaced — their absence is the no-write guard (AC3).
 *
 * NOTE (scoping, INF-993): the connector-ahead advance-on-evidence path (AC2)
 * is implemented in `runNativeStateReconcilerSweep` but production candidates
 * carry no completion receipt yet — there is no merged-PR/deploy receipt feed
 * wired into the connector. The reconciler therefore never advances on
 * inference in production (the safe direction of the frozen contract); wiring a
 * receipt source is a follow-up.
 */
export function createLinearReconcilerDataPlane(config: {
  authToken: string;
  fetchFn?: typeof fetch;
  listDeadCandidates?: () => DeadCandidate[];
}): NativeStateReconcilerOpts {
  const fetchFn = config.fetchFn ?? fetch;
  const authToken = config.authToken;

  // Per-issue name→id map, populated by listTickets, consumed by
  // resolveNativeStateId. dev-impl tickets can span teams, so the id for a
  // given state name is scoped to the issue we just read.
  let stateIdByName = new Map<string, string>();

  const listDeadCandidates =
    config.listDeadCandidates ??
    (() =>
      getFirstActionWatchdogState()
        .ladders.filter((l) => l.unreachable)
        .map((l) => ({ identifier: l.ticket, connectorState: l.state })));

  const listTickets = async (): Promise<ReconcileTicket[]> => {
    const candidates = listDeadCandidates();
    if (candidates.length === 0) return [];

    const tickets: ReconcileTicket[] = [];
    const freshStateMap = new Map<string, string>();

    for (const c of candidates) {
      try {
        const facts = await readIssueFacts(c.identifier, authToken, fetchFn);
        if (!facts) continue;
        for (const s of facts.teamStates) freshStateMap.set(s.name, s.id);
        tickets.push({
          identifier: c.identifier,
          issueId: facts.id,
          workflow: "dev-impl",
          connectorState: c.connectorState,
          nativeStateId: facts.stateId,
          nativeStateName: facts.stateName,
          delegateId: facts.delegateId,
          assigneeId: facts.assigneeId,
          liveness: { kind: "SESSION_DEAD" },
        });
      } catch (err) {
        log.error(`native-state-reconciler: failed to read ${c.identifier}: ${errMsg(err)}`);
      }
    }

    stateIdByName = freshStateMap;
    return tickets;
  };

  const resolveNativeStateId = async (stateName: string): Promise<string> => {
    const id = stateIdByName.get(stateName);
    if (!id) throw new Error(`native-state-reconciler: no state id for "${stateName}"`);
    return id;
  };

  const writeNativeState = async (
    issueId: string,
    input: Record<string, unknown>,
  ): Promise<NativeWriteResult> => {
    const mutation = `
      mutation ReconcileNativeState($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id state { id } delegate { id } assignee { id } }
        }
      }
    `;
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query: mutation, variables: { id: issueId, input } }),
    });
    const data = (await res.json()) as {
      data?: { issueUpdate?: NativeWriteResult };
    };
    return data.data?.issueUpdate ?? { success: false };
  };

  return { listTickets, resolveNativeStateId, writeNativeState };
}

interface IssueFacts {
  id: string;
  stateId: string;
  stateName: string;
  delegateId: string | null;
  assigneeId: string | null;
  teamStates: Array<{ id: string; name: string }>;
}

async function readIssueFacts(
  identifier: string,
  authToken: string,
  fetchFn: typeof fetch,
): Promise<IssueFacts | null> {
  const query = `
    query ReconcileIssueFacts($id: String!) {
      issue(id: $id) {
        id
        state { id name }
        delegate { id }
        assignee { id }
        team { states(first: 100) { nodes { id name } } }
      }
    }
  `;
  const res = await fetchFn(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query, variables: { id: identifier } }),
  });
  type Resp = {
    data?: {
      issue?: {
        id: string;
        state?: { id: string; name: string } | null;
        delegate?: { id: string } | null;
        assignee?: { id: string } | null;
        team?: { states?: { nodes?: Array<{ id: string; name: string }> } } | null;
      } | null;
    };
  };
  const data = (await res.json()) as Resp;
  const issue = data.data?.issue;
  if (!issue || !issue.state) return null;
  return {
    id: issue.id,
    stateId: issue.state.id,
    stateName: issue.state.name,
    delegateId: issue.delegate?.id ?? null,
    assigneeId: issue.assignee?.id ?? null,
    teamStates: issue.team?.states?.nodes ?? [],
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
