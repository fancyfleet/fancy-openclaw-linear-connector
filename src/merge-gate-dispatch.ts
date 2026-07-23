/**
 * INF-400: Merge-gate outcome dispatch.
 *
 * Hanzo's merge gate (`check-gate.sh`, run from the `merge` state) posts an
 * outcome COMMENT on a PR-stage ticket — e.g.
 *
 *   Merge gate held.
 *   I opened PR https://github.com/.../pull/437 ...
 *   Automated gate result: PASS via `check-gate.sh ... 437` ...
 *   Manual gate result: BLOCKED — no Charles code-review sign-off ...
 *
 * A comment never changes state or delegate, and only a state/delegate change
 * drives next-role dispatch. So the standard comment path routes the outcome
 * back to the ticket's delegate (Hanzo, the author), where the comment-fed
 * suppression drops it — and the ticket strands until a manual stall sweep
 * re-wakes it. INF-358 and INF-342 both sat ~7h this way (2026-07-22/23).
 *
 * This module makes the gate outcome a STRUCTURED signal (AC1) and maps it to
 * the correct next role to wake (AC2):
 *
 *   held  → code-review role (Charles) — PR opened, needs human review
 *   fail  → implementer (prior-implementer, e.g. Igor) — CI red, fix it
 *   pass  → advance toward merge/deploy per the workflow def
 *
 * The parser + role mapping are pure and unit-tested; the connector wires the
 * orchestrator into the Comment path ahead of the normal router (see
 * webhook/index.ts) so the wake fires directly, bypassing the suppression that
 * otherwise eats it.
 */

import type { LinearEvent, LinearCommentData } from "./webhook/schema.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "merge-gate-dispatch");

// ── Structured signal (AC1) ───────────────────────────────────────────────────

export type MergeGateOutcome = "held" | "pass" | "fail";

export interface MergeGateSignal {
  outcome: MergeGateOutcome;
  /** Free-text reason (fail outcomes; captured from the lead line or gate-result line). */
  reason?: string;
  /** GitHub PR URL, if the comment names one. */
  prUrl?: string;
  /** GitHub PR number, if the comment names one. */
  prNumber?: string;
}

/**
 * Lead-line recognizer. Anchored at start-of-line and requiring the outcome word
 * to be TERMINAL (followed by `:`, `.`, or end-of-line) so prose that merely
 * mentions the phrase mid-sentence ("the merge gate held us up") does not match.
 */
const LEAD_LINE = /^[^\S\n]*Merge gate\s+(held|passed|pass|failed|fail)\b\s*(?:([:.])\s*(.*))?$/im;

/** Machine token some gate variants emit, e.g. `GATE_RESULT=BLOCKED_BASE_BRANCH`. */
const GATE_RESULT_TOKEN = /\bGATE_RESULT\s*[:=]\s*([A-Z_]+)\b/;

const PR_URL = /https?:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/i;

function normalizeOutcomeWord(word: string): MergeGateOutcome {
  const w = word.toLowerCase();
  if (w === "held") return "held";
  if (w === "pass" || w === "passed") return "pass";
  return "fail"; // fail | failed
}

/**
 * Parse a comment body into a structured merge-gate signal, or null when the
 * body is not a recognizable gate outcome.
 *
 * Recognition is conservative on purpose (AC: a non-gate comment must not
 * trigger a dispatch): it requires the canonical `Merge gate <outcome>.` lead
 * line, or an explicit `GATE_RESULT=<value>` machine token.
 */
export function parseMergeGateOutcome(body: string | undefined | null): MergeGateSignal | null {
  if (!body || typeof body !== "string") return null;

  let outcome: MergeGateOutcome | null = null;
  let reason: string | undefined;

  const lead = LEAD_LINE.exec(body);
  if (lead) {
    outcome = normalizeOutcomeWord(lead[1]);
    // Trailing text after `: reason` on the lead line (fail case).
    if (lead[2] === ":" && lead[3]?.trim()) reason = lead[3].trim();
  } else {
    const token = GATE_RESULT_TOKEN.exec(body);
    if (token) {
      const val = token[1].toUpperCase();
      if (val === "PASS" || val === "PASSED" || val === "OK" || val === "GREEN") outcome = "pass";
      else if (val === "HELD" || val === "HOLD") outcome = "held";
      else {
        // BLOCKED_*, FAIL, RED, etc. — a non-pass machine result is a failure.
        outcome = "fail";
        reason = token[1];
      }
    }
  }

  if (!outcome) return null;

  // Enrich the reason for failures from the structured gate-result lines when
  // the lead line didn't carry one.
  if (outcome === "fail" && !reason) {
    const auto = /Automated gate result:\s*(.+)/i.exec(body);
    const manual = /Manual gate result:\s*(.+)/i.exec(body);
    reason = (auto?.[1] ?? manual?.[1])?.trim();
  }

  const signal: MergeGateSignal = { outcome };
  if (reason) signal.reason = reason;
  const pr = PR_URL.exec(body);
  if (pr) {
    signal.prUrl = pr[0];
    signal.prNumber = pr[1];
  }
  return signal;
}

// ── Outcome → dispatch directive (AC2) ────────────────────────────────────────

export type MergeGateDispatch =
  | { kind: "wake-role"; role: "code-review" }
  | { kind: "wake-implementer" }
  | { kind: "advance" };

export function mergeGateDispatchTarget(signal: Pick<MergeGateSignal, "outcome">): MergeGateDispatch {
  switch (signal.outcome) {
    case "held":
      return { kind: "wake-role", role: "code-review" };
    case "fail":
      return { kind: "wake-implementer" };
    case "pass":
      return { kind: "advance" };
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface MergeGateDispatchContext {
  /** Linear issue UUID (for implementer-store lookup). */
  issueUuid: string;
  /** Human-readable identifier, e.g. "INF-358" (for the wake session key + logs). */
  issueIdentifier: string;
  /** OpenClaw agent name of the ticket's current delegate (the merge/deploy owner). */
  currentDelegateAgent?: string | null;
}

export interface MergeGateWakeTarget {
  /** OpenClaw agent name to wake. */
  agentId: string;
  /** Semantic role label for the wake ("code-review" | "implementer" | "advance"). */
  role: string;
  signal: MergeGateSignal;
  ctx: MergeGateDispatchContext;
}

export interface MergeGateDispatchDeps {
  resolveBodiesForRole: (role: string) => Promise<string[]>;
  getImplementer: (issueUuid: string) => Promise<string | null>;
  deliverWake: (target: MergeGateWakeTarget) => Promise<{ delivered: boolean }>;
  /**
   * Optional author guard (defense-in-depth against a non-gate agent quoting the
   * phrase). When supplied and it returns false, the outcome is ignored.
   */
  isMergeGateAuthor?: (actorId: string | undefined, actorName: string | undefined) => boolean | Promise<boolean>;
}

export interface MergeGateDispatchResult {
  handled: true;
  outcome: MergeGateOutcome;
  /** "code-review" | "implementer" | "advance". */
  targetRole: string;
  /** Resolved agent woken, or null when no body could be resolved. */
  targetAgent: string | null;
  delivered: boolean;
  reason?: string;
  prNumber?: string;
}

/**
 * If `event` is a merge-gate outcome comment, resolve and wake the correct next
 * role. Returns a result when the comment WAS a gate outcome (whether or not a
 * target could be resolved), or null when it was not — letting the caller fall
 * through to normal routing.
 *
 * Never throws: resolution/delivery failures are logged and surfaced via the
 * result (delivered=false) so the caller can alert rather than crash the hook.
 */
export async function maybeDispatchMergeGateOutcome(
  event: LinearEvent,
  ctx: MergeGateDispatchContext,
  deps: MergeGateDispatchDeps,
): Promise<MergeGateDispatchResult | null> {
  if (event.type !== "Comment") return null;
  const body = (event.data as LinearCommentData | undefined)?.body;
  const signal = parseMergeGateOutcome(body);
  if (!signal) return null;

  // Author guard (optional): only the merge-gate role holder's outcome counts.
  if (deps.isMergeGateAuthor) {
    const ok = await deps.isMergeGateAuthor(event.actor?.id, event.actor?.name);
    if (!ok) {
      log.info(
        `merge-gate-dispatch: ignoring '${signal.outcome}' phrasing on ${ctx.issueIdentifier} — ` +
        `author ${event.actor?.name ?? event.actor?.id ?? "unknown"} does not hold the merge-gate role`,
      );
      return null;
    }
  }

  const directive = mergeGateDispatchTarget(signal);

  let targetAgent: string | null = null;
  let targetRole: string;
  try {
    switch (directive.kind) {
      case "wake-role": {
        targetRole = directive.role;
        const bodies = await deps.resolveBodiesForRole(directive.role);
        targetAgent = bodies[0] ?? null;
        break;
      }
      case "wake-implementer": {
        targetRole = "implementer";
        const prior = await deps.getImplementer(ctx.issueUuid);
        if (prior) {
          targetAgent = prior;
        } else {
          // No recorded prior implementer — fall back to a singleton dev role.
          const devBodies = await deps.resolveBodiesForRole("dev");
          targetAgent = devBodies.length === 1 ? devBodies[0] : null;
        }
        break;
      }
      case "advance": {
        targetRole = "advance";
        // "Advance toward merge/deploy per the workflow def" — the current
        // role-holder (merge/deploy owner) must issue the forward
        // `continue-workflow`; re-poke them so it doesn't stall.
        targetAgent = ctx.currentDelegateAgent ?? null;
        break;
      }
    }
  } catch (err) {
    log.warn(
      `merge-gate-dispatch: role resolution failed for ${ctx.issueIdentifier} (${signal.outcome}): ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return { handled: true, outcome: signal.outcome, targetRole: signal.outcome, targetAgent: null, delivered: false, reason: signal.reason, prNumber: signal.prNumber };
  }

  if (!targetAgent) {
    log.warn(
      `merge-gate-dispatch: recognized '${signal.outcome}' on ${ctx.issueIdentifier} but could not resolve a ` +
      `target body (role=${targetRole}) — not waking; caller should escalate`,
    );
    return { handled: true, outcome: signal.outcome, targetRole, targetAgent: null, delivered: false, reason: signal.reason, prNumber: signal.prNumber };
  }

  let delivered = false;
  try {
    const r = await deps.deliverWake({ agentId: targetAgent, role: targetRole, signal, ctx });
    delivered = r.delivered;
    log.info(
      `merge-gate-dispatch: ${ctx.issueIdentifier} gate '${signal.outcome}' → woke ${targetAgent} ` +
      `(role=${targetRole}${signal.prNumber ? `, PR #${signal.prNumber}` : ""})`,
    );
  } catch (err) {
    log.warn(
      `merge-gate-dispatch: wake delivery failed for ${targetAgent} on ${ctx.issueIdentifier}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    handled: true,
    outcome: signal.outcome,
    targetRole,
    targetAgent,
    delivered,
    reason: signal.reason,
    prNumber: signal.prNumber,
  };
}
