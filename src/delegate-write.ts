import { LINEAR_API_URL } from "./linear-helpers.js";
import { createLogger, componentLogger } from "./logger.js";

const log = componentLogger(createLogger(), "delegate-write");

export interface WriteDelegateResult {
  /**
   * Safe to treat the write as applied. True when the write reported success AND
   * either the read-back confirmed it OR verification was unavailable (INF-984 —
   * a failed *read* must not be reported as a failed *write*). False only on a
   * definite failure: the write was rejected, or a successful read-back proved a
   * silent revert.
   */
  ok: boolean;
  /** True iff a read-back actually confirmed the current delegate. False when verification was unavailable. */
  verified: boolean;
  /** The delegate id the read-back observed (null = unset, or verification unavailable). */
  persistedDelegateId: string | null;
  /** Populated on failure or unverified with the reason (loudly logged as well). */
  error?: string;
}

/** Read-back retry budget. Reads fail transiently under API stress (INF-984). */
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 150;

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
      return { ok: false, verified: false, persistedDelegateId: null, error: msg };
    }
    if (data.data?.issueUpdate?.success !== true) {
      log.error(`writeDelegate: issueUpdate did not report success for ${issueId} (delegateId=${delegateId ?? "null"})`);
      return { ok: false, verified: false, persistedDelegateId: null, error: "issueUpdate did not report success" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`writeDelegate: issueUpdate failed for ${issueId} (delegateId=${delegateId ?? "null"}): ${msg}`);
    return { ok: false, verified: false, persistedDelegateId: null, error: msg };
  }

  // Read-back. `success: true` is NOT proof of persistence — Linear silently
  // reverts app-user delegate writes. Verify what actually stuck.
  //
  // INF-984 hardening: a *read* failure must NOT be reported as a failed *write*.
  // Single-issue reads fail under API stress, and this helper now sits on every
  // delegate write — asserting non-persistence on a read error would false-fail
  // fleet-wide during a read storm and make callers churn on good writes. So we
  // retry the read, and only on a *confirmed* read do we compare; a read that
  // never confirms returns an explicit UNVERIFIED result, trusting the write's
  // own success rather than asserting it reverted.
  let persisted: string | null = null;
  let readConfirmed = false;
  let lastReadErr = "read-back unavailable";
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    try {
      const query = `query VerifyDelegate($issueId: String!) { issue(id: $issueId) { delegate { id } } }`;
      const res = await fetchFn(LINEAR_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authToken },
        body: JSON.stringify({ query, variables: { issueId } }),
      });
      type QResp = {
        data?: { issue?: { delegate?: { id: string } | null } | null };
        errors?: Array<{ message: string }>;
      };
      const data = (await res.json()) as QResp;
      if (data.errors?.length) {
        lastReadErr = data.errors.map((e) => e.message).join("; ");
      } else if (data.data && data.data.issue) {
        // A real issue object came back — this read is authoritative.
        persisted = data.data.issue.delegate?.id ?? null;
        readConfirmed = true;
        break;
      } else {
        lastReadErr = "read-back returned no issue";
      }
    } catch (err) {
      lastReadErr = err instanceof Error ? err.message : String(err);
    }
    if (attempt < VERIFY_ATTEMPTS) await new Promise((r) => setTimeout(r, VERIFY_RETRY_MS));
  }

  if (!readConfirmed) {
    // Could not READ the delegate back (not a mismatch — a read failure). Do NOT
    // assert non-persistence. Trust the write's reported success, but mark it
    // unverified and loud so it is auditable. (INF-984.)
    log.warn(
      `writeDelegate: could not verify persistence for ${issueId} after ${VERIFY_ATTEMPTS} attempts ` +
        `(${lastReadErr}); the write reported success — returning UNVERIFIED, not asserting non-persistence (INF-984).`,
    );
    return { ok: true, verified: false, persistedDelegateId: null, error: `unverified: ${lastReadErr}` };
  }

  if (persisted !== delegateId) {
    log.error(
      `writeDelegate: delegate did not persist on ${issueId} — expected ${delegateId ?? "null"}, ` +
        `got ${persisted ?? "null"} (AI-1395/INF-973 silent app-user delegate revert)`,
    );
    return { ok: false, verified: true, persistedDelegateId: persisted, error: "delegate write did not persist" };
  }

  return { ok: true, verified: true, persistedDelegateId: persisted };
}
