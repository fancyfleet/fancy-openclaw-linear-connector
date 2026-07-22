import { parseArtifactMarkers, parseCodeArtifact, sameArtifact, formatCodeArtifact, type CodeArtifact } from "./artifact.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "artifact-disclosure");
const LINEAR_API_URL = "https://api.linear.app/graphql";

interface DisclosureComment {
  body: string;
  user: { id: string } | null;
}

function readDelegateId(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const vars = (body as { variables?: unknown }).variables;
  if (!vars || typeof vars !== "object") return undefined;
  const input = (vars as { input?: unknown }).input;
  if (!input || typeof input !== "object") return undefined;
  return (input as Record<string, unknown>).delegateId;
}

function decodeSubstitutionReason(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Fetch the ticket's recent comments, NEWEST FIRST.
 *
 * ⚠️ The ordering is load-bearing and NOT verifiable by this repo's tests, which
 * all mock the transport: `mostRecentMarkerFromAnotherUser` takes the first
 * match it finds and would silently select the OLDEST marker if Linear returned
 * ascending. Every test here would still pass, because the mock chooses the
 * order the assertion expects.
 *
 * `comments(first: N, orderBy: createdAt)` returns DESCENDING. Live-probed
 * against AI-2479 itself on 2026-07-16 (7 comments, strictly descending), and
 * corroborated by the CLI, which pairs this exact query with a `.reverse()` to
 * render comments oldest-first (AI-2494).
 *
 * If that ever changes, this guard fails silently rather than loudly — it would
 * compare against a stale artifact. Re-probe before trusting it.
 */
async function fetchRecentComments(issueId: string, authToken: string): Promise<DisclosureComment[] | null> {
  const query = `
    query ArtifactDisclosureComments($id: String!) {
      issue(id: $id) {
        comments(first: 50, orderBy: createdAt) {
          nodes {
            body
            user { id }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });
    if (!res.ok) throw new Error(`Linear API returned ${res.status}`);

    type CommentsResp = {
      errors?: unknown;
      data?: {
        issue?: {
          comments?: { nodes?: Array<{ body?: unknown; user?: { id?: unknown } | null }> };
        } | null;
      };
    };
    const data = (await res.json()) as CommentsResp;
    if (data.errors) throw new Error("Linear API returned GraphQL errors");

    const issue = data.data?.issue;
    if (!issue) throw new Error(`issue ${issueId} not found`);

    return (issue.comments?.nodes ?? [])
      .filter((n): n is { body: string; user?: { id?: unknown } | null } => typeof n.body === "string")
      .map((n) => ({
        body: n.body,
        user: n.user && typeof n.user.id === "string" ? { id: n.user.id } : null,
      }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`comment fetch failed for ${issueId}: ${msg}`);
    return null;
  }
}

/**
 * The most recent declaration that was handed TO this caller by someone else.
 *
 * Two filters, both load-bearing:
 *
 * - `to === callerLinearUserId`: a declaration obliges only its recipient. A
 *   marker addressed to someone else must not stop the scan and must never
 *   oblige a bystander — that was the AC4 failure Ai refused on.
 * - author `!== callerLinearUserId`: your own declaration can never be the thing
 *   you are measured against. This is also what stops laundering — an agent
 *   cannot re-address the obligation to itself with a fresh self-handoff and
 *   walk away clean, because its own marker is skipped and the original one
 *   addressed to it is still found underneath.
 */
function mostRecentRecordHandedTo(comments: DisclosureComment[], callerLinearUserId: string): CodeArtifact | null {
  for (const comment of comments) {
    if (comment.user?.id === callerLinearUserId) continue;
    const mine = parseArtifactMarkers(comment.body).find((r) => r.to === callerLinearUserId);
    if (mine) return mine;
  }
  return null;
}

export async function checkArtifactDisclosure(
  body: unknown,
  issueId: string | null,
  authToken: string,
  agentId: string,
  callerLinearUserId: string | null,
  declaredHeader: string | null,
  substitutionReasonHeader: string | null,
): Promise<string | null> {
  if (!issueId) return null;

  const inputDelegateId = readDelegateId(body);
  if (inputDelegateId === undefined || inputDelegateId === null) return null;

  if (!callerLinearUserId) {
    log.warn(`identity-unresolvable-skip agent=${agentId} ticket=${issueId}`);
    return null;
  }

  // ⚠️ Delegating to YOURSELF is accepting work, not handing it on. Skip it.
  //
  // This guard hangs off `!intent`, and "intent-less delegate write" is a strict
  // SUPERSET of "handoff". The full set of intent-less delegate writers in the
  // CLI is exactly three — `consider-work` and `manage-work` (both
  // `delegateToSelf: true`, neither with a setProxyIntent call site) and
  // `handoff-work`. Without this line the first two are refused the moment any
  // declaration exists on the ticket: the validator is blocked at its FIRST
  // command, told to re-run with a `--code-artifact` flag that `consider-work`
  // does not have, and the ticket strands with no forward exit. That is the same
  // "blocked the only forward exit + named an illegal verb ⇒ infinite retry"
  // class this ticket was filed about, reproduced by its own fix. Caught by Ai's
  // refusal on AI-2479 with an e2e repro; `manage-work` was a third victim the
  // refusal did not name.
  //
  // Self-delegation cannot be a substitution: you are taking delivery, not
  // passing anything on. The obligation is checked on the way OUT, where the
  // caller hands a named artifact to someone else.
  if (typeof inputDelegateId === "string" && inputDelegateId === callerLinearUserId) {
    return null;
  }

  const comments = await fetchRecentComments(issueId, authToken);
  if (!comments) return null;

  const recorded = mostRecentRecordHandedTo(comments, callerLinearUserId);
  if (!recorded) return null;

  const declared = declaredHeader ? parseCodeArtifact(declaredHeader) : null;
  if (declaredHeader && !declared) {
    return `[Proxy] 'handoff-work' blocked: declared code artifact '${declaredHeader}' is invalid. Re-run with --code-artifact <branch>@<sha>.`;
  }

  const recordedText = formatCodeArtifact(recorded);
  if (!declared) {
    return `[Proxy] 'handoff-work' blocked: this ticket was handed to you declaring artifact '${recordedText}', but this handoff declares none. Re-run with --code-artifact <branch>@<sha> naming what you actually reviewed. If you are handing on different code, add --substitution-reason "<why>".`;
  }

  if (sameArtifact(declared, recorded)) return null;

  if (substitutionReasonHeader) {
    const reason = decodeSubstitutionReason(substitutionReasonHeader);
    log.info(`substitution-declared agent=${agentId} ticket=${issueId} recorded=${recordedText} declared=${formatCodeArtifact(declared)} reason=${JSON.stringify(reason)}`);
    return null;
  }

  return `[Proxy] 'handoff-work' blocked: you were handed artifact '${recordedText}' but this handoff declares '${formatCodeArtifact(declared)}'. If you reviewed or are handing on different code, say so: re-run with --substitution-reason "<why>". Undeclared artifact substitution is what this guard exists to catch.`;
}
