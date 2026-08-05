/**
 * Done ticket detector cron registration.
 *
 * Registers the DoneTicketDetector as a periodic background job alongside the
 * existing dispatch watchdog and rescue sweep. Runs on the host's periodic
 * task scheduler alongside linear-connector-watchdog.py.
 *
 * AC10: Bootstrap registration — the scheduler configuration explicitly
 * references the script path, proven by the cron registration call.
 * AC11: Liveness observability — start() logs a startup confirmation.
 */

import { createModuleLogger } from "../logging.js";
import { execFileSync } from "node:child_process";
import { resolveServiceCredential } from "../service-credential.js";
import { formatIntervalMs, registerCron } from "./registry.js";
import {
  DoneTicketDetector,
  type DoneTicketDetectorConfig,
  type LinearApi,
  type LinearIssue,
  type LinearCreateIssueInput,
} from "../bag/done-ticket-detector.js";
import {
  makeDeployVerdictApi,
  type DeployVerdictApi,
  type CodePresence,
} from "../bag/deploy-verdict.js";
import { LINEAR_API_URL } from "../linear-helpers.js";

const log = createModuleLogger("done-ticket-detector-cron");

// ── Options ──────────────────────────────────────────────────────────────────

export interface DoneDetectorCronOptions {
  /** Path to the git repository to check. Default: process.env.DONE_DETECTOR_REPO_PATH */
  repoPath?: string;
  /** Lookback days for Done tickets. Default: 14 or process.env.DONE_DETECTOR_LOOKBACK_DAYS */
  lookbackDays?: number;
  /** Grace hours after Done before flagging. Default: 4 or process.env.DONE_DETECTOR_GRACE_HOURS */
  graceHours?: number;
  /** Poll interval in ms. Default: 1 hour or process.env.DONE_DETECTOR_POLL_INTERVAL_MS */
  pollIntervalMs?: number;
  /**
   * Token for Linear API calls. Default: the dedicated service credential
   * (resolveServiceCredential(), INF-1212).
   */
  linearToken?: string;
  /**
   * Live `/health` endpoint URL to read the deployed running commit from
   * (INF-1099). Default: process.env.HEALTH_CHECK_URL.
   */
  healthUrl?: string;
}

// ── Real Linear API implementation ───────────────────────────────────────────

function resolveToken(token?: string): string | undefined {
  return token ?? (resolveServiceCredential() || undefined);
}

/** Create a real LinearApi implementation backed by fetch to api.linear.app. */
export function createLinearApi(linearToken?: string): LinearApi {
  const getToken = () => {
    const t = resolveToken(linearToken);
    if (!t) {
      throw new Error("No Linear API token available for done-ticket-detector");
    }
    return t;
  };

  const authHeaders = () => ({
    "content-type": "application/json",
    authorization: /^Bearer\s+/i.test(getToken()) ? getToken() : `Bearer ${getToken()}`,
  });

  async function graphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data as T;
  }

  return {
    async fetchDoneTickets(lookbackDays: number): Promise<LinearIssue[]> {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
      type DoneNode = {
        id: string;
        identifier: string;
        createdAt: string;
        team?: { key: string };
        labels: { nodes: Array<{ name: string }> };
        branchName?: string | null;
        state?: { name: string };
        completedAt?: string | null;
        comments?: { nodes: Array<{ id: string; body: string; createdAt: string }> };
      };
      type DoneResp = {
        issues: {
          nodes: DoneNode[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      // INF-719: page through the full result set. `first: 100` alone silently
      // dropped completed tickets beyond the first 100 in the lookback window.
      const nodes: DoneNode[] = [];
      let cursor: string | null = null;
      let hasNextPage = true;
      while (hasNextPage) {
        const data: DoneResp = await graphQL<DoneResp>(
          `query DoneTickets($since: DateTime!, $after: String) {
            issues(
              filter: {
                state: { type: { eq: "completed" } }
                completedAt: { gte: $since }
              }
              first: 100
              after: $after
              orderBy: completedAt
            ) {
              nodes {
                id
                identifier
                createdAt
                team { key }
                labels { nodes { name } }
                branchName
                state { name }
                completedAt
                comments(first: 5) { nodes { id body createdAt } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { since, after: cursor },
        );
        nodes.push(...(data.issues?.nodes ?? []));
        const pageInfo = data.issues?.pageInfo;
        hasNextPage = pageInfo?.hasNextPage === true;
        cursor = pageInfo?.endCursor ?? null;
        if (hasNextPage && !cursor) break;
      }

      return nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        createdAt: n.createdAt,
        teamKey: n.team?.key,
        labels: n.labels?.nodes?.map((l) => l.name) ?? [],
        branchName: n.branchName,
        hasBranch: n.branchName != null && n.branchName.length > 0,
        doneAt: n.completedAt ?? null,
        comments: n.comments?.nodes?.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
        })) ?? [],
      }));
    },

    async applyLabel(issueId: string, label: string): Promise<boolean> {
      // First, find or create the label ID
      // We need the team from the issue to scope label lookup
      const issueData = await graphQL<{
        issue: { team: { id: string } };
      }>(
        `query LabelTeam($id: String!) {
          issue(id: $id) {
            team { id }
          }
        }`,
        { id: issueId },
      );

      const teamId = issueData.issue.team.id;

      const labelData = await graphQL<{
        issueLabels: { nodes: Array<{ id: string, name: string }> };
      }>(
        `query FindLabel($teamId: ID!) {
          issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 50) {
            nodes { id name }
          }
        }`,
        { teamId },
      );

      const labelId = labelData.issueLabels?.nodes?.find(
        (l) => l.name === label,
      )?.id;

      if (!labelId) {
        log.warn(`Label "${label}" not found for team ${teamId}`);
        return false;
      }

      const result = await graphQL<{
        issueUpdate: { success: boolean };
      }>(
        `mutation AddLabel($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }`,
        { id: issueId, labelIds: [labelId] },
      );

      return result.issueUpdate?.success ?? false;
    },

    async postComment(issueId: string, body: string): Promise<boolean> {
      const result = await graphQL<{
        commentCreate: { success: boolean };
      }>(
        `mutation PostComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        { issueId, body },
      );
      return result.commentCreate?.success ?? false;
    },

    async createIssue(input: LinearCreateIssueInput): Promise<{ id: string; identifier: string } | null> {
      // We need a team ID — use a lookup if teamId is empty
      let teamId = input.teamId;
      if (!teamId) {
        // Try to resolve from any accessible team
        log.warn("No teamId provided for re-land issue creation — skipping");
        return null;
      }

      const result = await graphQL<{
        issueCreate: {
          success: boolean;
          issue: { id: string; identifier: string };
        };
      }>(
        `mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $labelIds: [String!], $parentId: String!) {
          issueCreate(
            input: {
              teamId: $teamId
              title: $title
              description: $description
              labelIds: $labelIds
              parentId: $parentId
            }
          ) {
            success
            issue { id identifier }
          }
        }`,
        {
          teamId,
          title: input.title,
          description: input.description,
          labelIds: input.labels ?? null,
          parentId: input.parentId ?? "",
        },
      );

      if (!result.issueCreate?.success || !result.issueCreate?.issue) {
        return null;
      }

      return result.issueCreate.issue;
    },

    async hasExistingComment(issueId: string, bodyPrefix: string): Promise<boolean> {
      const data = await graphQL<{
        issue: {
          comments: { nodes: Array<{ body: string }> };
        };
      }>(
        `query HasComment($id: String!) {
          issue(id: $id) {
            comments(first: 50) { nodes { body } }
          }
        }`,
        { id: issueId },
      );

      return (data.issue?.comments?.nodes ?? []).some((c) =>
        c.body.startsWith(bodyPrefix),
      );
    },
  };
}

// ── Real live-signal deploy verdict implementation (INF-1099) ────────────────

/**
 * Tri-state `git grep` of a hallmark symbol at a ref: `true` present, `false`
 * absent, `null` indeterminate (the ref is not fetched into the clone). We use
 * `git cat-file -e <ref>^{commit}` to distinguish "ref unknown to this clone"
 * (→ null, do not treat as a stall) from "ref present but symbol absent"
 * (→ false). `--fixed-strings` keeps the symbol a literal, not a regex.
 */
function gitGrepSymbolAt(repoPath: string, symbol: string, ref: string): CodePresence {
  try {
    execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${ref}^{commit}`], {
      stdio: "pipe",
      timeout: 15_000,
    });
  } catch {
    return null; // ref not present in this clone — cannot determine presence.
  }
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "grep", "-q", "--fixed-strings", "--", symbol, ref],
      { stdio: "pipe", timeout: 30_000 },
    );
    return true;
  } catch (err) {
    // `git grep -q` exits 1 when the symbol is absent (a real "absent" signal)
    // and >1 on an actual error. Treat only exit-1 as a definitive absence.
    const status = (err as { status?: number }).status;
    return status === 1 ? false : null;
  }
}

/**
 * Read the running commit the deployed connector reports on `/health`.
 * Mirrors deploy-probe.ts: parse `commit` from the JSON body; null when the
 * URL is unconfigured or the probe fails (fail open — never a false stall).
 */
async function fetchHealthCommit(healthUrl: string | undefined): Promise<string | null> {
  if (!healthUrl) return null;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = await res.text();
    try {
      const json = JSON.parse(body) as { commit?: string };
      return json.commit && json.commit !== "unknown" ? json.commit : null;
    } catch {
      const trimmed = body.trim();
      return trimmed && trimmed !== "unknown" ? trimmed.slice(0, 40) : null;
    }
  } catch {
    return null;
  }
}

/**
 * Create a real DeployVerdictApi backed by git grep + a live `/health` fetch.
 * `healthUrl` defaults to HEALTH_CHECK_URL (the same env deploy-probe reads).
 */
export function createDeployVerdictApi(repoPath: string, healthUrl?: string): DeployVerdictApi {
  const url = healthUrl ?? process.env.HEALTH_CHECK_URL;
  return makeDeployVerdictApi({
    symbolPresentAt: (symbol, ref) => gitGrepSymbolAt(repoPath, symbol, ref),
    fetchHealthCommit: () => fetchHealthCommit(url),
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the DoneTicketDetector as an in-process recurring job.
 *
 * The timer is unref'd so it won't prevent graceful shutdown.
 * Registration happens alongside linear-connector-watchdog.py in index.ts.
 */
export function registerDoneDetectorCron(options?: DoneDetectorCronOptions): void {
  const repoPath =
    options?.repoPath ??
    process.env.DONE_DETECTOR_REPO_PATH;
  if (!repoPath) {
    log.warn(
      "[done-ticket-detector] DONE_DETECTOR_REPO_PATH not set — detector will not run. " +
      "Set this env var to the repo path where tickets are tracked.",
    );
    // Don't throw — advisory only. The detector is not configured; log and continue.
    return;
  }

  const lookbackDays = options?.lookbackDays ?? parseInt(process.env.DONE_DETECTOR_LOOKBACK_DAYS ?? "14", 10);
  const graceHours = options?.graceHours ?? parseInt(process.env.DONE_DETECTOR_GRACE_HOURS ?? "4", 10);
  const pollIntervalMs = options?.pollIntervalMs ?? parseInt(process.env.DONE_DETECTOR_POLL_INTERVAL_MS ?? String(60 * 60 * 1000), 10);
  registerCron("done-ticket-detector", `every ${formatIntervalMs(pollIntervalMs)}`);

  // Build real dependencies
  const deps = {
    linear: createLinearApi(options?.linearToken),
    deploy: createDeployVerdictApi(repoPath, options?.healthUrl),
    config: {
      lookbackDays,
      graceHours,
      pollIntervalMs,
      repoPath,
    },
  };

  const detector = new DoneTicketDetector(deps);
  detector.start();

  log.info(
    `[done-ticket-detector] Done ticket detector scheduled — ` +
    `lookbackDays=${lookbackDays} graceHours=${graceHours} ` +
    `pollInterval=${pollIntervalMs}ms repoPath=${repoPath}`,
  );
}
