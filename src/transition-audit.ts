/**
 * AI-2554 — Structured transition audit logging + post-transition verification + label-sync audit.
 *
 * Three capabilities:
 *   1. Structured transition log — JSON log record per transition attempt with gate evaluation details.
 *   2. Post-transition verification — re-read state:* label from Linear after transition, warn on mismatch.
 *   3. Label-sync audit — compare proxy-store (applied-state-store) state against Linear's live state.
 */

import { componentLogger, createLogger } from "./logger.js";
import { getAppliedState } from "./store/applied-state-store.js";
import type { TransitionApplyResult } from "./workflow-gate.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "transition-audit");
const LINEAR_API_URL = "https://api.linear.app/graphql";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Structured record for a single transition attempt.
 * All fields are present so log aggregators can query without null-tolerance.
 */
export interface TransitionAuditRecord {
  /** ISO-8601 timestamp of the audit record creation. */
  ts: string;
  /** The ticket identifier (e.g. "AI-2554"). */
  ticketId: string;
  /** The command/intent that triggered the transition (e.g. "handoff-work"). */
  command: string;
  /** Resolved transition name (label state name). */
  transitionName: string | null;
  /** Source state name from the state:* label. */
  fromState: string | null;
  /** Target state name. */
  toState: string | null;
  /** Final apply result status. */
  status: "applied" | "noop" | "blocked" | "failed";
  /** Machine-readable result code. */
  code: string;
  /** Human-readable detail, if any. */
  detail: string | null;
  /** The agent who initiated the transition. */
  agentId: string | null;
  /**
   * Gate evaluation results: each gate that ran records pass/fail.
   * Order is evaluation order.
   */
  gateResults: GateResult[];
  /** Proxy-store (applied-state-store) state at invocation, if available. */
  proxyStoreState: string | null;
  /** Post-transition verification result, if performed. */
  postVerification: PostTransitionVerification | null;
}

export interface GateResult {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface PostTransitionVerification {
  /** True if the re-read state:* label matches the expected target state. */
  match: boolean;
  /** The expected state (what was applied). */
  expectedState: string;
  /** The actual state read back from Linear. */
  actualState: string | null;
}

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Build a structured transition audit record from available information.
 * Does not perform I/O — purely constructs the data from what's in scope.
 */
export function buildTransitionAuditRecord(
  ticketId: string,
  command: string,
  transitionName: string | null,
  fromState: string | null,
  toState: string | null,
  status: "applied" | "noop" | "blocked" | "failed",
  code: string,
  detail: string | null,
  agentId: string | null,
  gateResults: GateResult[],
): TransitionAuditRecord {
  const proxyStoreState = ticketId ? getAppliedState(ticketId) : null;

  return {
    ts: new Date().toISOString(),
    ticketId,
    command,
    transitionName,
    fromState,
    toState,
    status,
    code,
    detail,
    agentId,
    gateResults,
    proxyStoreState,
    postVerification: null,
  };
}

/**
 * Emit a structured transition audit record as a single JSON log line.
 * The JSON is emitted at INFO level for success, WARN for noop/blocked, ERROR for failure.
 */
export function emitTransitionAuditRecord(record: TransitionAuditRecord): void {
  const json = JSON.stringify(record);
  if (record.status === "failed") {
    log.error(`[TRANSITION-AUDIT] ${json}`);
  } else if (record.status === "blocked" || record.status === "noop") {
    log.warn(`[TRANSITION-AUDIT] ${json}`);
  } else {
    log.info(`[TRANSITION-AUDIT] ${json}`);
  }
}

// ── Post-transition verification ───────────────────────────────────────────

/**
 * After a transition is applied, re-read the state:* label from Linear and
 * compare to the expected target state. Returns a PostTransitionVerification
 * result, or null if the read could not be performed.
 */
export async function verifyPostTransition(
  issueId: string,
  expectedState: string,
  authToken: string,
): Promise<PostTransitionVerification | null> {
  try {
    const rawLabel = await fetchStateLabel(issueId, authToken);
    if (rawLabel === null) {
      log.warn(
        `[transition-audit] post-transition verify: could not read state label for ${issueId}`,
      );
      return null;
    }
    // INF-771: `fetchStateLabel` returns the full label name (`state:<id>`) while
    // callers pass the BARE target state (`transitionResult.to`, e.g. `spawn-arms`).
    // The old raw `===` therefore reported a mismatch on EVERY transition — the
    // detector was structurally always-false (and any self-heal built on it would
    // fire on every correctly-applied transition). Canonicalize both sides to the
    // bare state id before comparing, and report the bare actual state.
    const stripState = (s: string): string => (s.startsWith("state:") ? s.slice("state:".length) : s);
    const actualState = stripState(rawLabel);
    const expectedBare = stripState(expectedState);
    const match = actualState === expectedBare;
    if (!match) {
      log.warn(
        `[transition-audit] post-transition LABEL MISMATCH for ${issueId}: ` +
        `expected 'state:${expectedBare}', got 'state:${actualState}'`,
      );
    } else {
      log.info(
        `[transition-audit] post-transition verify: ${issueId} → confirmed state:${expectedBare}`,
      );
    }
    return { match, expectedState: expectedBare, actualState };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[transition-audit] post-transition verify failed for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * Outcome of a post-transition desync heal attempt.
 */
export interface PostTransitionHealResult {
  /** True if the read-back resolved a state:* label to compare against. */
  verified: boolean;
  /** True if the live label already matched the expected target (no heal needed). */
  matched: boolean;
  /** True if a desync was detected AND the reconcile applied successfully. */
  healed: boolean;
  /** Human-readable detail for logs/audit. */
  detail: string;
}

/**
 * INF-771: detect and self-heal a post-transition label desync.
 *
 * The live incident (INF-768, dev-sprint continue-workflow): the CLI's forwarded
 * mutation advanced the NATIVE Linear state while the proxy's B2 `state:*` label
 * swap did not land, leaving the ticket at a stale `state:*` label. Detection
 * alone (a WARN) let the desync persist; the ticket's Expected behavior is that a
 * transition "atomically advances the label OR fails without partial state".
 *
 * This helper re-reads the live label via `verifyPostTransition`; if it is stale,
 * it invokes `reconcile` (in production: a label-only `setStateAtomic` to the
 * expected state, which strips the old `state:*`, adds the target, and is
 * verified read-after-write by AI-1762 — with no fanout/comment side effects).
 * A reconcile that cannot apply is reported loudly (`healed: false`) rather than
 * swallowed, so a stuck desync surfaces instead of masquerading as success.
 *
 * `reconcile` is injected so the seam is unit-testable without the full proxy
 * write path.
 */
export async function healPostTransitionDesync(
  issueId: string,
  expectedState: string,
  authToken: string,
  reconcile: (
    issueId: string,
    expectedState: string,
    authToken: string,
  ) => Promise<{ ok: boolean; error?: string }>,
): Promise<PostTransitionHealResult> {
  const verification = await verifyPostTransition(issueId, expectedState, authToken);
  if (!verification) {
    return {
      verified: false,
      matched: false,
      healed: false,
      detail: `post-transition read-back could not resolve a state:* label for ${issueId}`,
    };
  }
  if (verification.match) {
    return { verified: true, matched: true, healed: false, detail: `label already at state:${expectedState}` };
  }

  // Desync detected — reconcile the stale state:* label to the applied target.
  log.warn(
    `[transition-audit] post-transition DESYNC for ${issueId}: label '${verification.actualState ?? "(null)"}' ` +
      `!= expected 'state:${expectedState}' — attempting self-heal`,
  );
  let outcome: { ok: boolean; error?: string };
  try {
    outcome = await reconcile(issueId, expectedState, authToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[transition-audit] post-transition self-heal threw for ${issueId} → state:${expectedState}: ${msg}`);
    return { verified: true, matched: false, healed: false, detail: `self-heal threw: ${msg}` };
  }
  if (outcome.ok) {
    log.info(`[transition-audit] post-transition self-heal reconciled ${issueId} → state:${expectedState}`);
    return { verified: true, matched: false, healed: true, detail: `reconciled to state:${expectedState}` };
  }
  log.error(
    `[transition-audit] post-transition self-heal FAILED for ${issueId} → state:${expectedState}: ${outcome.error ?? "unknown"}`,
  );
  return {
    verified: true,
    matched: false,
    healed: false,
    detail: `self-heal failed: ${outcome.error ?? "unknown"}`,
  };
}

// ── Label-sync audit ───────────────────────────────────────────────────────

/**
 * Label-sync divergence descriptor: proxy-state vs Linear live state.
 */
export interface LabelSyncDivergence {
  ticketId: string;
  proxyState: string | null;
  linearState: string | null;
  linearStateLabel: string | null;
  /** Approximate seconds since proxy state was recorded. */
  ageSec: number;
}

/**
 * Run a label-sync audit for a single ticket: compare the proxy-store
 * (applied-state-store) state against Linear's current state:* label.
 *
 * Returns a LabelSyncDivergence if the states differ AND the proxy store has
 * a recorded state (i.e., the connector has touched this ticket recently).
 * Returns null if states match or the proxy has no recorded state for this ticket.
 */
export async function checkLabelSyncForTicket(
  ticketId: string,
  authToken: string,
): Promise<LabelSyncDivergence | null> {
  const proxyState = getAppliedState(ticketId);
  if (!proxyState) return null; // No proxy state recorded — nothing to audit.

  let linearStateLabel: string | null = null;
  try {
    linearStateLabel = await fetchStateLabel(ticketId, authToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[transition-audit] label-sync check failed for ${ticketId}: ${msg}`);
    return null;
  }

  // Strip the "state:" prefix for comparison.
  const linearState = linearStateLabel?.startsWith("state:")
    ? linearStateLabel.slice("state:".length)
    : null;

  if (proxyState === linearState) return null; // Match — no divergence.

  return {
    ticketId,
    proxyState,
    linearState,
    linearStateLabel,
    ageSec: 0, // Caller can compute from store timestamps if needed.
  };
}

/**
 * Emit a warning log entry for label-sync divergence. Structured JSON so
 * log aggregators can alert on it.
 */
export function emitLabelSyncWarning(divergence: LabelSyncDivergence): void {
  log.warn(
    `[TRANSITION-AUDIT] LABEL-SYNC DIVERGENCE ${JSON.stringify(divergence)}`,
  );
}

/**
 * Fetch the state:* label name from Linear for a given issue.
 * Returns the full label name (e.g. "state:doing") or null if not found.
 */
async function fetchStateLabel(
  issueId: string,
  authToken: string,
): Promise<string | null> {
  const query = `
    query IssueStateLabel($id: String!) {
      issue(id: $id) {
        labels {
          nodes { name }
        }
      }
    }
  `;
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authToken },
    body: JSON.stringify({ query, variables: { id: issueId } }),
  });
  type Resp = { data?: { issue?: { labels?: { nodes?: Array<{ name: string }> } } | null } | null };
  const data = (await res.json()) as Resp;
  const labels = data.data?.issue?.labels?.nodes ?? [];
  for (const l of labels) {
    if (l.name.startsWith("state:")) return l.name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the human-readable ticket identifier from a UUID issue ID.
 * First checks the applied-state store by key, then falls back to a Linear query.
 * Returns the identifier or the original ID if resolution fails.
 */
export async function resolveTicketIdentifier(
  issueId: string,
  authToken: string,
): Promise<string> {
  // The applied-state-store is keyed by human identifier already.
  const proxyState = getAppliedState(issueId);
  if (proxyState) return issueId; // It's already a human identifier.

  // Could be a UUID — try to fetch the identifier.
  try {
    const query = `
      query IssueIdentifier($id: String!) {
        issue(id: $id) { identifier }
      }
    `;
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    type Resp = { data?: { issue?: { identifier?: string } | null } | null };
    const data = (await res.json()) as Resp;
    if (data.data?.issue?.identifier) return data.data.issue.identifier;
  } catch {
    // Fall through
  }
  return issueId;
}
