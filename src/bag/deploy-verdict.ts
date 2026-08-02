/**
 * INF-1099 — Live-signal deploy verdict for the Done-ticket watch-cron.
 *
 * The Done-ticket detector previously decided "landed / deployed" by string-
 * matching the ticket *identifier* in `git log origin/main` (see the retired
 * `ticketIdInMainLog`). That derives the verdict from ticket text: a squash
 * merge that drops the identifier reads as "not landed", and — worse — a fix
 * merged to `origin/main` but never deployed still read as shipped. This is
 * the `Done ≠ merged ≠ deployed` failure class (AI-2449/2450, LIF-2/AI-2406).
 *
 * This module derives the verdict from LIVE signals only:
 *   1. Live `/health` — read the commit the running connector reports.
 *   2. Code-level presence — `git grep` the fix's hallmark symbol in the
 *      deployed artifact (the /health commit) and in `origin/main`. This is a
 *      squash-merge-safe check: it confirms the *code* is present, never that
 *      a particular SHA is an ancestor.
 *   3. The report asserts the concrete divergence it found — never the ticket
 *      title or its `state:*` label.
 *   4. No ticket-text as ground truth: a ticket with no `hallmark:<symbol>`
 *      label cannot be verified from live signals and is reported UNVERIFIABLE
 *      (skipped), never flagged from the presence of a `Done` label alone.
 */

export const HALLMARK_LABEL_PREFIX = "hallmark:";
export const DEFAULT_SHIPPED_REF = "origin/main";

export type DeployVerdictStatus =
  /** Hallmark confirmed present in the live deployed artifact. */
  | "deployed"
  /** Hallmark present on origin/main but ABSENT from the deployed /health commit. */
  | "stale-not-deployed"
  /** Hallmark absent from origin/main entirely — the fix never merged. */
  | "absent-from-main"
  /** No live signal could produce a verdict — do not flag (AC4 fail-open). */
  | "unverifiable";

export interface DeployVerdict {
  status: DeployVerdictStatus;
  /** True only when the fix is confirmed live in the deployed artifact. */
  deployed: boolean;
  /** True when a stall should be flagged (a concrete negative live signal). */
  stall: boolean;
  /** The hallmark symbol used for the code-presence check, or null if none. */
  hallmarkSymbol: string | null;
  /** The commit reported by live /health, or null if unreachable. */
  runningCommit: string | null;
  presentOnMain: boolean | null;
  presentInDeployed: boolean | null;
  /** Human-readable evidence asserting the concrete divergence found (AC3). */
  evidence: string;
}

/**
 * A tri-state code-presence check: `true` present, `false` absent, `null`
 * indeterminate (ref not fetched into the clone / grep errored). The `null`
 * case must never be collapsed into `false`, or an unreachable deployed
 * commit would masquerade as a stall.
 */
export type CodePresence = boolean | null;

export interface DeployVerdictDeps {
  /** `git grep <symbol> <ref>` in the connector clone → tri-state presence. */
  symbolPresentAt(symbol: string, ref: string): CodePresence;
  /** Fetch the live `/health` endpoint and return the running commit, or null. */
  fetchHealthCommit(): Promise<string | null>;
  /** The shipped ref to grep for `origin/main` presence. Default origin/main. */
  shippedRef?: string;
}

export interface DeployVerdictApi {
  verify(ticket: { identifier: string; labels: string[] }): Promise<DeployVerdict>;
}

/** Extract the `hallmark:<symbol>` label value, or null if absent. */
export function extractHallmarkSymbol(labels: string[]): string | null {
  for (const label of labels) {
    if (label.startsWith(HALLMARK_LABEL_PREFIX)) {
      const symbol = label.slice(HALLMARK_LABEL_PREFIX.length).trim();
      if (symbol) return symbol;
    }
  }
  return null;
}

/**
 * Derive a deploy verdict for a single ticket from live signals.
 *
 * Precedence, and why each branch is fail-open where it must be:
 *  - No hallmark label            → UNVERIFIABLE (never flag from ticket text).
 *  - Present in deployed artifact  → DEPLOYED (the all-clear only a live signal can give).
 *  - Absent from deployed artifact → STALL (the exact Done-≠-deployed case).
 *  - Deployed commit unknowable, but absent from origin/main → STALL (never merged).
 *  - Deployed commit unknowable, present on origin/main      → UNVERIFIABLE
 *    (merged, but /health unreachable or its commit not in the clone — do not
 *    manufacture a stall from a missing signal; fail open like the deploy probe).
 */
export function deriveVerdict(
  hallmarkSymbol: string | null,
  presentOnMain: CodePresence,
  runningCommit: string | null,
  presentInDeployed: CodePresence,
  shippedRef: string,
): DeployVerdict {
  const base = { hallmarkSymbol, runningCommit, presentOnMain, presentInDeployed };

  if (!hallmarkSymbol) {
    return {
      ...base,
      status: "unverifiable",
      deployed: false,
      stall: false,
      evidence:
        "No `hallmark:<symbol>` label — the fix's code presence cannot be " +
        "verified from live signals. Not flagged: a stall verdict must never " +
        "be derived from a `Done` label or the ticket title (AC4).",
    };
  }

  if (presentInDeployed === true) {
    return {
      ...base,
      status: "deployed",
      deployed: true,
      stall: false,
      evidence:
        `Hallmark \`${hallmarkSymbol}\` is present in the live deployed ` +
        `artifact at commit \`${runningCommit}\` (read from /health). Shipped.`,
    };
  }

  if (presentInDeployed === false) {
    const mainClause =
      presentOnMain === true
        ? `present on \`${shippedRef}\``
        : presentOnMain === false
          ? `also absent from \`${shippedRef}\``
          : `presence on \`${shippedRef}\` indeterminate`;
    return {
      ...base,
      status: "stale-not-deployed",
      deployed: false,
      stall: true,
      evidence:
        `/health reports running commit \`${runningCommit}\`; hallmark ` +
        `\`${hallmarkSymbol}\` is ABSENT from that deployed artifact (${mainClause}). ` +
        `Done ≠ deployed — the running service does not contain this fix.`,
    };
  }

  // presentInDeployed indeterminate (no /health commit, or it is not in the clone).
  if (presentOnMain === false) {
    return {
      ...base,
      status: "absent-from-main",
      deployed: false,
      stall: true,
      evidence:
        `Hallmark \`${hallmarkSymbol}\` is ABSENT from \`${shippedRef}\` — the ` +
        `fix is not merged` +
        (runningCommit
          ? ` (live /health commit \`${runningCommit}\` could not be grepped in the clone).`
          : ` (live /health was unreachable, so the deployed artifact could not be read).`),
    };
  }

  return {
    ...base,
    status: "unverifiable",
    deployed: false,
    stall: false,
    evidence:
      `Hallmark \`${hallmarkSymbol}\` is present on \`${shippedRef}\`, but the ` +
      `deployed artifact could not be read from live /health` +
      (runningCommit
        ? ` (commit \`${runningCommit}\` is not present in the clone)` +
          ` — cannot confirm deployment; not flagged (fail-open).`
        : ` (endpoint unreachable) — cannot confirm deployment; not flagged (fail-open).`),
  };
}

/** Build a live-signal DeployVerdictApi from injectable dependencies. */
export function makeDeployVerdictApi(deps: DeployVerdictDeps): DeployVerdictApi {
  const shippedRef = deps.shippedRef ?? DEFAULT_SHIPPED_REF;
  return {
    async verify(ticket): Promise<DeployVerdict> {
      const hallmarkSymbol = extractHallmarkSymbol(ticket.labels);
      if (!hallmarkSymbol) {
        return deriveVerdict(null, null, null, null, shippedRef);
      }

      const presentOnMain = deps.symbolPresentAt(hallmarkSymbol, shippedRef);

      let runningCommit: string | null = null;
      try {
        runningCommit = await deps.fetchHealthCommit();
      } catch {
        runningCommit = null;
      }

      const presentInDeployed: CodePresence = runningCommit
        ? deps.symbolPresentAt(hallmarkSymbol, runningCommit)
        : null;

      return deriveVerdict(
        hallmarkSymbol,
        presentOnMain,
        runningCommit,
        presentInDeployed,
        shippedRef,
      );
    },
  };
}
