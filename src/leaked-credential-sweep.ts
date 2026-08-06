/**
 * INF-529 / Layer 2: leaked-credential reopen sweep (human-close path).
 *
 * The proxy gate (Layer 1) blocks *agent* closes, but a human closing a ticket
 * in the Linear UI never traverses the connector proxy — that path is exactly
 * how AI-2372 was closed *Invalid* with the key still live. This sweep is the
 * out-of-band net for it: on a cadence it scans recently-closed
 * `sec:leaked-credential` tickets and RE-OPENS any that lack a rotation
 * confirmation, with a loud comment. Silence stops reading as resolution.
 *
 * Design mirrors `bag/done-ticket-detector.ts`: a pure engine with an injectable
 * `LinearSweepApi` so the transition/mutation logic is unit-testable without a
 * live Linear. Advisory-safe: every error is caught and recorded, never thrown,
 * and a per-cycle reopen cap bounds blast radius if the label is ever misapplied
 * en masse.
 */

import { createModuleLogger } from "./logging.js";
import {
  SEC_LEAKED_CREDENTIAL_LABEL,
  anyCommentConfirmsRotation,
} from "./leaked-credential-artifact.js";

const log = createModuleLogger("leaked-credential-sweep");

/**
 * Idempotency marker the sweep posts when it reopens a ticket. Its presence
 * means "this sweep already acted here"; combined with the still-closed check it
 * prevents fighting a human who deliberately re-closes AFTER posting a genuine
 * rotation confirmation (that confirmation now satisfies the artifact check, so
 * the ticket is skipped rather than reopened).
 */
export const REOPEN_MARKER = "<!-- leaked-cred-reopen -->";

export interface SweepIssue {
  id: string;
  identifier: string;
  /** Comment bodies on the ticket (any order). */
  comments: string[];
}

export interface LinearSweepApi {
  /**
   * Fetch tickets labelled `sec:leaked-credential` that are currently in a
   * closed/resolved state (Done / Canceled / Invalid), closed within the
   * lookback window. Implementations filter by label + state.type on the server.
   */
  fetchClosedLeakedCredentialTickets(lookbackDays: number): Promise<SweepIssue[]>;
  /** Move the ticket back to an open (unstarted/backlog) state. */
  reopenIssue(issueId: string): Promise<boolean>;
  /** Post a comment. */
  postComment(issueId: string, body: string): Promise<boolean>;
}

export interface LeakedCredentialSweepConfig {
  lookbackDays: number;
  pollIntervalMs: number;
  /** Max reopens per cycle — blast-radius bound. Default 10. */
  maxReopensPerCycle: number;
}

export interface LeakedCredentialSweepDeps {
  linear: LinearSweepApi;
  config: LeakedCredentialSweepConfig;
}

export interface SweepCycleResult {
  scanned: number;
  reopened: number;
  skippedConfirmed: number;
  skippedAlreadyReopened: number;
  cappedSkipped: number;
  errors: string[];
}

function reopenComment(): string {
  return (
    `${REOPEN_MARKER}\n` +
    `🔧 **Reopened by the leaked-credential rotation gate (INF-529).**\n\n` +
    `This ticket carries \`${SEC_LEAKED_CREDENTIAL_LABEL}\` and was closed without a ` +
    `rotation-confirmation artifact. A leaked key left live in pushed history stays ` +
    `harvestable, so **closing is not resolution — rotation is.**\n\n` +
    `To close it: rotate the credential, revoke/disable the old value, then post a ` +
    `confirmation comment — either the marker ` +
    `\`<!-- rotation-confirmed: {"credential":"<name>","revoked":true} -->\` or a ` +
    `\`ROTATION-CONFIRMED: … revoked …\` line. With that artifact present, closing it ` +
    `sticks. Genuine non-rotation exceptions go through a steward (break-glass).`
  );
}

export class LeakedCredentialSweep {
  private deps: LeakedCredentialSweepDeps;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: LeakedCredentialSweepDeps) {
    this.deps = deps;
  }

  start(onCycle?: (result?: SweepCycleResult) => void): void {
    if (this.timer) return;
    const { config } = this.deps;
    log.info(
      `Leaked-credential reopen sweep started — lookbackDays=${config.lookbackDays} ` +
      `pollInterval=${config.pollIntervalMs}ms maxReopensPerCycle=${config.maxReopensPerCycle}`,
    );
    const runOneCycle = () => {
      this.runCycle()
        .then((r) => {
          if (r.reopened > 0 || r.errors.length > 0) {
            log.warn(
              `sweep cycle: scanned=${r.scanned} reopened=${r.reopened} ` +
              `skippedConfirmed=${r.skippedConfirmed} errors=${r.errors.length}`,
            );
          }
          onCycle?.(r);
        })
        .catch((err) => {
          log.error(`sweep cycle error: ${err instanceof Error ? err.message : String(err)}`);
          onCycle?.();
        });
    };
    // INF-1263 AC3/AC5: kick off a first cycle immediately instead of waiting
    // for the first interval tick, so deploy churn (a restart shortly before
    // the next scheduled tick) cannot starve the sweep indefinitely.
    setTimeout(runOneCycle, 0);
    this.timer = setInterval(runOneCycle, config.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one sweep cycle. For each closed labelled ticket:
   *   • skip if a rotation artifact is already present (legitimate close),
   *   • skip if we already reopened it (marker present) — avoids a reopen/reclose war,
   *   • otherwise reopen + comment, up to the per-cycle cap.
   *
   * Advisory: all errors are caught and recorded, never thrown.
   */
  async runCycle(): Promise<SweepCycleResult> {
    const result: SweepCycleResult = {
      scanned: 0,
      reopened: 0,
      skippedConfirmed: 0,
      skippedAlreadyReopened: 0,
      cappedSkipped: 0,
      errors: [],
    };

    let tickets: SweepIssue[];
    try {
      tickets = await this.deps.linear.fetchClosedLeakedCredentialTickets(this.deps.config.lookbackDays);
    } catch (err) {
      result.errors.push(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    result.scanned = tickets.length;

    for (const ticket of tickets) {
      try {
        // Legitimate close: rotation was confirmed before closing.
        if (anyCommentConfirmsRotation(ticket.comments)) {
          result.skippedConfirmed++;
          continue;
        }
        // Already handled by a prior sweep — do not re-reopen (idempotent).
        if (ticket.comments.some((c) => c.includes(REOPEN_MARKER))) {
          result.skippedAlreadyReopened++;
          continue;
        }
        // Blast-radius cap.
        if (result.reopened >= this.deps.config.maxReopensPerCycle) {
          result.cappedSkipped++;
          continue;
        }

        const commented = await this.deps.linear.postComment(ticket.id, reopenComment());
        const reopened = await this.deps.linear.reopenIssue(ticket.id);
        if (reopened) {
          result.reopened++;
          log.warn(`reopened ${ticket.identifier} — leaked-credential ticket closed without rotation confirmation`);
        } else {
          result.errors.push(`reopen of ${ticket.identifier} did not succeed (commented=${commented})`);
        }
      } catch (err) {
        result.errors.push(`error on ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (result.cappedSkipped > 0) {
      log.warn(`sweep hit per-cycle reopen cap (${this.deps.config.maxReopensPerCycle}); ${result.cappedSkipped} deferred to next cycle`);
    }

    return result;
  }
}
