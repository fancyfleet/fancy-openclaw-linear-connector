/**
 * DoneTicketDetector — cron-based detector for Done dev-impl tickets
 * whose fix is not present in the LIVE deployed artifact.
 *
 * INF-1099: the verdict is derived from live signals — the running commit read
 * from `/health` and a code-level `git grep` of the fix's hallmark symbol —
 * never from the ticket's identifier/title/`Done` label. See ./deploy-verdict.ts.
 */

import { createModuleLogger } from "../logging.js";
import { markCronRun } from "../cron/registry.js";
import type { DeployVerdict, DeployVerdictApi } from "./deploy-verdict.js";

const log = createModuleLogger("done-ticket-detector", "info");

// ── Types ──────────────────────────────────────────────────────────────────

export interface DoneTicketDetectorConfig {
  lookbackDays: number;
  graceHours: number;
  pollIntervalMs: number;
  repoPath: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  userId?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  createdAt: string;
  teamKey?: string;
  labels: string[];
  branchName?: string | null;
  hasBranch?: boolean;
  doneAt?: string | null;
  comments?: LinearComment[];
}

export interface LinearCreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  labels?: string[];
  parentId?: string;
}

export interface LinearApi {
  fetchDoneTickets(lookbackDays: number): Promise<LinearIssue[]>;
  applyLabel(issueId: string, label: string): Promise<boolean>;
  postComment(issueId: string, body: string): Promise<boolean>;
  createIssue(input: LinearCreateIssueInput): Promise<{ id: string; identifier: string } | null>;
  hasExistingComment(issueId: string, bodyPrefix: string): Promise<boolean>;
}

export interface DoneTicketDetectorDeps {
  linear: LinearApi;
  /** Derives the deploy verdict from live /health + code-level grep (INF-1099). */
  deploy: DeployVerdictApi;
  config: DoneTicketDetectorConfig;
}

export interface DoneTicketCycleResult {
  scanned: number;
  flagged: number;
  skippedLabeled: number;
  skippedUnbranched: number;
  /** Tickets with no live signal to verify against (no hallmark / /health down). */
  skippedUnverifiable: number;
  reLandCreated: number;
  errors: string[];
}

// ── Detector ───────────────────────────────────────────────────────────────

export class DoneTicketDetector {
  private deps: DoneTicketDetectorDeps;
  private timer?: ReturnType<typeof setInterval>;
  private commentedTickets: Set<string> = new Set();

  constructor(deps: DoneTicketDetectorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    const { config } = this.deps;
    log.info(
      `Done ticket detector started — lookbackDays=${config.lookbackDays} ` +
      `graceHours=${config.graceHours} pollInterval=${config.pollIntervalMs}ms ` +
      `repoPath=${config.repoPath}`,
    );
    // INF-1263 AC3: self-rescheduling setTimeout instead of setInterval — the
    // first cycle fires immediately (deploy churn cannot starve it until a
    // fixed-interval tick), and each subsequent cycle is scheduled only after
    // the previous one settles, so a single timer handle exists at any time.
    const runCycleTick = () => {
      this.runCycle().catch((err) => {
        log.error(
          `Done ticket detector cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }).finally(() => {
        markCronRun("done-ticket-detector");
        this.timer = setTimeout(runCycleTick, config.pollIntervalMs);
        this.timer.unref();
      });
    };
    this.timer = setTimeout(runCycleTick, 0);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one detection cycle.
   *
   * 1. Fetch Done tickets from the last N days
   * 2. For each ticket: skip if already flagged, skip if no branch
   * 3. Check if the ticket ID appears in git log origin/main --oneline
   * 4. If absent: apply needs-merge-verify label, post comment, create re-land
   *
   * Advisory only — all errors are caught and recorded, never thrown.
   */
  async runCycle(): Promise<DoneTicketCycleResult> {
    const result: DoneTicketCycleResult = {
      scanned: 0,
      flagged: 0,
      skippedLabeled: 0,
      skippedUnbranched: 0,
      skippedUnverifiable: 0,
      reLandCreated: 0,
      errors: [],
    };

    let tickets: LinearIssue[];
    try {
      tickets = await this.deps.linear.fetchDoneTickets(this.deps.config.lookbackDays);
    } catch (err) {
      result.errors.push(
        `fetchDoneTickets failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }

    result.scanned = tickets.length;

    for (const ticket of tickets) {
      try {
        await this.processTicket(ticket, result);
      } catch (err) {
        result.errors.push(
          `Error processing ${ticket.identifier}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  /**
   * Process a single Done ticket.
   * Returns true if a flag was raised (newly flagged), false otherwise.
   */
  private async processTicket(
    ticket: LinearIssue,
    result: DoneTicketCycleResult,
  ): Promise<boolean> {
    // AC4: Skip if already has needs-merge-verify label
    if (ticket.labels.includes("needs-merge-verify")) {
      result.skippedLabeled++;
      return false;
    }

    // AC5: Skip if no branch (can't determine code presence)
    if (ticket.hasBranch === false) {
      result.skippedUnbranched++;
      return false;
    }

    // INF-1099: derive the verdict from LIVE signals — /health running commit +
    // code-level hallmark grep — never from the ticket identifier/title/label.
    const doneDate = ticket.doneAt ? new Date(ticket.doneAt) : new Date(ticket.createdAt);
    const verdict = await this.deps.deploy.verify({
      identifier: ticket.identifier,
      labels: ticket.labels,
    });

    if (verdict.deployed) {
      // Fix confirmed live in the deployed artifact — no action needed.
      return false;
    }

    if (!verdict.stall) {
      // No concrete negative live signal (no hallmark label, or /health
      // unreachable). Do NOT flag from ticket text — fail open (AC4).
      result.skippedUnverifiable++;
      return false;
    }

    // AC9: Check if we've already commented on this ticket (in-memory set)
    if (this.commentedTickets.has(ticket.id)) {
      return false;
    }

    // AC3: Apply label and post comment asserting the concrete divergence.
    await this.deps.linear.applyLabel(ticket.id, "needs-merge-verify");

    const commentBody = this.buildFlagComment(ticket.identifier, doneDate, verdict);
    await this.deps.linear.postComment(ticket.id, commentBody);
    this.commentedTickets.add(ticket.id);

    result.flagged++;

    // AC6: Create re-land ticket
    try {
      const reLand = await this.deps.linear.createIssue({
        teamId: ticket.teamKey ?? "",
        title: `re-land: ${ticket.identifier} — ${ticket.identifier}`,
        description: `Re-land fix for ${ticket.identifier} that was marked Done but not found on main.\n\nOriginal ticket: ${ticket.identifier}`,
        parentId: ticket.id,
      });

      if (reLand) {
        result.reLandCreated++;
      }
    } catch {
      // AC8: Re-land creation failure is advisory — don't fail the cycle
      // Flag was still applied, just note the error
    }

    return true;
  }

  /**
   * Build the flagging comment body (AC3).
   * Quotes the concrete LIVE evidence — the running /health commit and the
   * hallmark-symbol code-presence result — never the ticket title or status.
   */
  private buildFlagComment(identifier: string, doneAt: Date, verdict: DeployVerdict): string {
    return (
      `## Done but not deployed\n\n` +
      `**${identifier}** was marked Done at ${doneAt.toISOString()}, but a live ` +
      `deploy check found its fix is not running in production:\n\n` +
      `> ${verdict.evidence}\n\n` +
      `A re-land ticket has been created to track re-applying/redeploying this fix.\n\n` +
      `_This is an automated advisory from the Done-ticket detector — the verdict ` +
      `is derived from the live \`/health\` commit and a code-level hallmark grep, ` +
      `not from the ticket's title or \`Done\` label (INF-1099)._`
    );
  }
}
