/**
 * INF-604 — Cross-check classification for the first-action watchdog.
 *
 * The watchdog's on-breach cross-check reads authoritative Linear state via a
 * single-issue node query (`issue(id:)`) and decides whether a breached mirror
 * row is genuinely live or stale (done / deleted / trashed / demoted / drifted).
 *
 * This interpretation lives here as a PURE function so it can be unit-tested in
 * isolation — the index.ts closure only owns the fetch + the mirror side-effects
 * that each verdict implies.
 *
 * INF-604 root cause: a **trashed / soft-deleted** issue still resolves through
 * the archive on a node query (Linear's `issue(id:)` reads through the trash),
 * so it comes back NON-null and looking live — its `state:*` / `wf:*` labels are
 * frozen at deletion time. The old classifier only healed a HARD delete (`issue
 * == null`), so a trashed governed ticket (evidence: LSO-8) stayed "live" and
 * the watchdog kept firing rung-1 reconciliation wakes at its steward forever.
 * The fix: treat a set `archivedAt` / `trashed === true` as stale-and-drop, the
 * same as a hard delete.
 */

/** The subset of an `issue(id:)` node result the cross-check reads. */
export interface CrossCheckIssue {
  /** ISO timestamp when the issue was archived, or null/absent when active.
   *  A trashed (soft-deleted) issue has this set. */
  archivedAt?: string | null;
  /** True when the issue is in the trash (soft-deleted). */
  trashed?: boolean | null;
  state?: { type?: string } | null;
  labels?: { nodes?: Array<{ name: string }> } | null;
}

export const CROSS_CHECK_ISSUE_QUERY =
  `query($id: String!) { issue(id: $id) { id archivedAt trashed state { type } labels { nodes { name } } } }`;

export interface CrossCheckTokenCandidate {
  source: string;
  token: string | undefined | null;
}

export type CrossCheckIssueFetchResult =
  | { status: "ok"; source: string; issue: CrossCheckIssue | null }
  | { status: "unknown"; error: string };

interface CrossCheckIssueGraphqlBody {
  data?: { issue?: CrossCheckIssue | null };
  errors?: Array<{ message?: string }>;
}

function bearer(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/**
 * Fetch the authoritative issue node for an on-breach cross-check.
 *
 * INF-604 follow-up: trashed issues can return 401 for one app/user token while
 * remaining readable through the steward/delegate token. Try each scoped token
 * before returning "unknown"; do not classify a bare 401 as stale.
 */
export async function fetchCrossCheckIssueWithFallback(args: {
  fetchFn: typeof fetch;
  linearApiUrl: string;
  ticket: string;
  tokenCandidates: CrossCheckTokenCandidate[];
}): Promise<CrossCheckIssueFetchResult> {
  let lastError = "no Linear token available";
  const seenTokens = new Set<string>();

  for (const candidate of args.tokenCandidates) {
    const token = candidate.token?.trim();
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);

    try {
      const res = await args.fetchFn(args.linearApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: bearer(token),
        },
        body: JSON.stringify({
          query: CROSS_CHECK_ISSUE_QUERY,
          variables: { id: args.ticket },
        }),
      });
      const body = (await res.json()) as CrossCheckIssueGraphqlBody;
      if (body.data !== undefined) {
        return {
          status: "ok",
          source: candidate.source,
          issue: body.data.issue ?? null,
        };
      }
      lastError = `${candidate.source} returned ${res.status}: ${body.errors?.[0]?.message ?? "missing data"}`;
    } catch (err) {
      lastError = `${candidate.source} threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { status: "unknown", error: lastError };
}

/**
 * The heal action a stale verdict implies. The caller maps each to the concrete
 * enrolled-mirror mutation:
 *   - deleted / trashed / terminal → markTerminal (drop from every poller)
 *   - demoted                      → demoteEnrolled (lost its wf:* label)
 *   - state-drift                  → recordTransition to the authoritative state
 */
export type CrossCheckAction =
  | { verdict: "live" }
  | { verdict: "stale"; heal: "deleted" | "trashed" | "terminal" | "demoted" }
  | { verdict: "stale"; heal: "state-drift"; toState: string };

/**
 * Classify an `issue(id:)` node result (or null) against the mirror's expected
 * state. Pure — no I/O, no side-effects. `null` means the node query returned no
 * issue (hard delete). See the module header for the INF-604 trashed case.
 */
export function classifyCrossCheckIssue(
  issue: CrossCheckIssue | null,
  expectedState: string,
): CrossCheckAction {
  // Hard delete — the node query returned no issue at all.
  if (!issue) {
    return { verdict: "stale", heal: "deleted" };
  }

  // INF-604 — soft delete / archive. A trashed issue still resolves through the
  // archive on a node query, so it is NOT null here; detect it explicitly before
  // reading its (frozen) labels, or it reads as a live governed ticket forever.
  if (issue.archivedAt != null || issue.trashed === true) {
    return { verdict: "stale", heal: "trashed" };
  }

  const labels = issue.labels?.nodes ?? [];
  const stateType = issue.state?.type;
  const stateLabel = labels
    .find((l) => l.name.startsWith("state:"))
    ?.name.slice("state:".length);

  // Natively closed, or a mirror state:* label that says done.
  if (
    stateType === "completed" ||
    stateType === "canceled" ||
    stateLabel === "done"
  ) {
    return { verdict: "stale", heal: "terminal" };
  }

  // Lost its governance label — no longer a wf:* ticket.
  if (!labels.some((l) => l.name.startsWith("wf:"))) {
    return { verdict: "stale", heal: "demoted" };
  }

  // The mirror's state label drifted from authoritative Linear state.
  if (stateLabel && stateLabel !== expectedState) {
    return { verdict: "stale", heal: "state-drift", toState: stateLabel };
  }

  return { verdict: "live" };
}
