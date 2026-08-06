/**
 * INF-529 / Layer 2: leaked-credential reopen sweep — cron registration.
 *
 * Registers `LeakedCredentialSweep` as a periodic background job, backed by a
 * real Linear GraphQL API. Mirrors `done-ticket-detector-cron.ts`.
 *
 * Disabled by default: set `LEAKED_CRED_SWEEP_ENABLED=1` to arm it. The proxy
 * gate (Layer 1) is always on; this sweep additionally reopens *human* UI closes
 * and mutates ticket state, so arming it is a deliberate operator step. It is
 * inert until the `sec:leaked-credential` label is actually in use.
 */

import { createModuleLogger } from "../logging.js";
import { resolveServiceCredential } from "../service-credential.js";
import { formatIntervalMs, registerCron, markCronRunSuccess, markCronRunFailure } from "./registry.js";
import {
  LeakedCredentialSweep,
  type LinearSweepApi,
  type SweepIssue,
} from "../leaked-credential-sweep.js";
import { SEC_LEAKED_CREDENTIAL_LABEL } from "../leaked-credential-artifact.js";
import { LINEAR_API_URL } from "../linear-helpers.js";

const log = createModuleLogger("leaked-credential-sweep-cron");

export interface LeakedCredSweepCronOptions {
  lookbackDays?: number;
  pollIntervalMs?: number;
  maxReopensPerCycle?: number;
  linearToken?: string;
  /** Force-enable regardless of env (tests). */
  enabled?: boolean;
}

function resolveToken(token?: string): string | undefined {
  return token ?? (resolveServiceCredential() || undefined);
}

/** Open-state type priority when reopening (first available wins). */
const REOPEN_STATE_TYPE_PRIORITY = ["unstarted", "backlog", "triage"];

export function createSweepLinearApi(linearToken?: string): LinearSweepApi {
  const getToken = () => {
    const t = resolveToken(linearToken);
    if (!t) throw new Error("No Linear API token available for leaked-credential-sweep");
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
    if (!res.ok) throw new Error(`Linear API returned ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(`Linear API errors: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  }

  return {
    async fetchClosedLeakedCredentialTickets(lookbackDays: number): Promise<SweepIssue[]> {
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
      // Closed = state.type in {completed, canceled}. `canceled` covers both
      // Canceled and Invalid (they share the canceled type in Linear).
      type LeakedNode = {
        id: string;
        identifier: string;
        comments?: { nodes: Array<{ body: string }> };
      };
      type LeakedResp = {
        issues: {
          nodes: LeakedNode[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      // INF-719: page through the full result set. `first: 100` alone silently
      // dropped closed tickets beyond the first 100 in the lookback window.
      const nodes: LeakedNode[] = [];
      let cursor: string | null = null;
      let hasNextPage = true;
      while (hasNextPage) {
        const data: LeakedResp = await graphQL<LeakedResp>(
          `query ClosedLeakedCred($since: DateTime!, $label: String!, $after: String) {
            issues(
              filter: {
                labels: { name: { eq: $label } }
                state: { type: { in: ["completed", "canceled"] } }
                updatedAt: { gte: $since }
              }
              first: 100
              after: $after
              orderBy: updatedAt
            ) {
              nodes {
                id
                identifier
                comments(first: 50) { nodes { body } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { since, label: SEC_LEAKED_CREDENTIAL_LABEL, after: cursor },
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
        comments: n.comments?.nodes?.map((c) => c.body ?? "") ?? [],
      }));
    },

    async reopenIssue(issueId: string): Promise<boolean> {
      // Resolve a target open state on the issue's team.
      const stateData = await graphQL<{
        issue: { team: { states: { nodes: Array<{ id: string; type: string; position: number }> } } };
      }>(
        `query ReopenStates($id: String!) {
          issue(id: $id) {
            team { states { nodes { id type position } } }
          }
        }`,
        { id: issueId },
      );
      const states = stateData.issue?.team?.states?.nodes ?? [];
      let target: { id: string } | undefined;
      for (const type of REOPEN_STATE_TYPE_PRIORITY) {
        const candidates = states.filter((s) => s.type === type).sort((a, b) => a.position - b.position);
        if (candidates.length) {
          target = candidates[0];
          break;
        }
      }
      if (!target) {
        log.warn(`no open target state found for ${issueId} — cannot reopen`);
        return false;
      }
      const result = await graphQL<{ issueUpdate: { success: boolean } }>(
        `mutation Reopen($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }`,
        { id: issueId, stateId: target.id },
      );
      return result.issueUpdate?.success ?? false;
    },

    async postComment(issueId: string, body: string): Promise<boolean> {
      const result = await graphQL<{ commentCreate: { success: boolean } }>(
        `mutation PostComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        { issueId, body },
      );
      return result.commentCreate?.success ?? false;
    },
  };
}

export function registerLeakedCredentialSweepCron(options?: LeakedCredSweepCronOptions): LeakedCredentialSweep | null {
  const enabled = options?.enabled ?? process.env.LEAKED_CRED_SWEEP_ENABLED === "1";
  if (!enabled) {
    log.info("leaked-credential reopen sweep NOT armed (set LEAKED_CRED_SWEEP_ENABLED=1 to enable). Proxy gate remains active.");
    return null;
  }

  const token = resolveToken(options?.linearToken);
  if (!token) {
    log.warn("leaked-credential reopen sweep NOT armed — no Linear auth token available.");
    return null;
  }

  const lookbackDays = options?.lookbackDays ?? parseInt(process.env.LEAKED_CRED_SWEEP_LOOKBACK_DAYS ?? "30", 10);
  const pollIntervalMs = options?.pollIntervalMs ?? parseInt(process.env.LEAKED_CRED_SWEEP_POLL_INTERVAL_MS ?? String(60 * 60 * 1000), 10);
  const maxReopensPerCycle = options?.maxReopensPerCycle ?? parseInt(process.env.LEAKED_CRED_SWEEP_MAX_REOPENS ?? "10", 10);

  registerCron("leaked-credential-sweep", `every ${formatIntervalMs(pollIntervalMs)}`);
  const sweep = new LeakedCredentialSweep({
    linear: createSweepLinearApi(options?.linearToken),
    config: { lookbackDays, pollIntervalMs, maxReopensPerCycle },
  });
  sweep.start((result) => {
    if (result && result.errors.length > 0) {
      markCronRunFailure("leaked-credential-sweep", result.errors.join("; "));
    } else {
      markCronRunSuccess("leaked-credential-sweep");
    }
  });
  log.info(`leaked-credential reopen sweep armed — lookbackDays=${lookbackDays} pollInterval=${formatIntervalMs(pollIntervalMs)}`);
  return sweep;
}
