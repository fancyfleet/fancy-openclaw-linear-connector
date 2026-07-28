import { LINEAR_API_URL } from "./linear-helpers.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "delegate-write");

export interface WriteDelegateResult {
  /** True iff the delegate write was verified persisted by a read-back. */
  ok: boolean;
  /** The delegate id actually on the issue after the write (null = unset). */
  persistedDelegateId: string | null;
  /** Populated on failure with the reason (loudly logged as well). */
  error?: string;
}

/**
 * INF-1002 — the single chokepoint for writing an issue's delegate.
 *
 * Setting an *app-user* (agent) delegate on Linear silently reverts unless the
 * assignee is cleared in the same `issueUpdate` (AI-1395 / INF-973). A bare
 * `issueUpdate(input: { delegateId })` reports `success: true` and then the seat
 * is gone on the next read — which is exactly what reverted Felix's handoff to
 * Grover and pinballed INF-943. Every delegate write MUST therefore:
 *   1. send `assigneeId: null` alongside a **non-null** delegate (never on a
 *      pure clear — that would wipe a human assignee), and
 *   2. re-fetch and fail loud if the delegate did not persist.
 *
 * Route ALL delegate writes through here. Never hand-roll a delegateId
 * `issueUpdate` again — that is how the drift this closes crept back in.
 *
 * @param issueId    Linear issue id (internal UUID).
 * @param delegateId Linear user id to seat, or `null` to clear the delegate.
 * @param authToken  Authorization header value (e.g. `"Bearer ..."`).
 * @param fetchFn    Injected for tests; defaults to global `fetch`.
 */
export async function writeDelegate(
  issueId: string,
  delegateId: string | null,
  authToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<WriteDelegateResult> {
  const seating = delegateId !== null;

  // Clear the assignee ONLY when seating a delegate (the app-user constraint).
  // On a pure clear we must not touch assigneeId, or we would wipe a human
  // assignee that is legitimately set on the ticket.
  const mutation = seating
    ? `mutation WriteDelegate($issueId: String!, $delegateId: String!, $assigneeId: String) {
         issueUpdate(id: $issueId, input: { delegateId: $delegateId, assigneeId: $assigneeId }) {
           success
         }
       }`
    : `mutation WriteDelegate($issueId: String!) {
         issueUpdate(id: $issueId, input: { delegateId: null }) {
           success
         }
       }`;

  try {
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authToken },
      body: JSON.stringify({
        query: mutation,
        // assigneeId is sent as an explicit null variable only when seating a
        // delegate (the AI-1395 app-user constraint); a pure clear leaves the
        // assignee untouched.
        variables: seating ? { issueId, delegateId, assigneeId: null } : { issueId },
      }),
    });
    type MResp = {
      data?: { issueUpdate?: { success?: boolean } };
      errors?: Array<{ message: string }>;
    };
    const data = (await res.json()) as MResp;
    if (data.errors?.length) {
      const msg = data.errors.map((e) => e.message).join("; ");
      log.error(`writeDelegate: issueUpdate errored for ${issueId} (delegateId=${delegateId ?? "null"}): ${msg}`);
      return { ok: false, persistedDelegateId: null, error: msg };
    }
    if (data.data?.issueUpdate?.success !== true) {
      log.error(`writeDelegate: issueUpdate did not report success for ${issueId} (delegateId=${delegateId ?? "null"})`);
      return { ok: false, persistedDelegateId: null, error: "issueUpdate did not report success" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`writeDelegate: issueUpdate failed for ${issueId} (delegateId=${delegateId ?? "null"}): ${msg}`);
    return { ok: false, persistedDelegateId: null, error: msg };
  }

  // Read-back. `success: true` is NOT proof of persistence — Linear silently
  // reverts app-user delegate writes. Verify what actually stuck.
  let persisted: string | null;
  try {
    const query = `query VerifyDelegate($issueId: String!) { issue(id: $issueId) { delegate { id } } }`;
    const res = await fetchFn(LINEAR_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authToken },
      body: JSON.stringify({ query, variables: { issueId } }),
    });
    type QResp = { data?: { issue?: { delegate?: { id: string } | null } | null } };
    const data = (await res.json()) as QResp;
    persisted = data.data?.issue?.delegate?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`writeDelegate: read-back failed for ${issueId}: ${msg}`);
    return { ok: false, persistedDelegateId: null, error: `read-back failed: ${msg}` };
  }

  if (persisted !== delegateId) {
    log.error(
      `writeDelegate: delegate did not persist on ${issueId} — expected ${delegateId ?? "null"}, ` +
        `got ${persisted ?? "null"} (AI-1395/INF-973 silent app-user delegate revert)`,
    );
    return { ok: false, persistedDelegateId: persisted, error: "delegate write did not persist" };
  }

  return { ok: true, persistedDelegateId: persisted };
}
