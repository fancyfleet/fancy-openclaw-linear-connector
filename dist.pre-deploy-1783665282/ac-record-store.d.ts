/**
 * Phase 6.5 / H-7 — Verbatim AC record store (AI-1482).
 *
 * Connector-side immutable record of the verbatim acceptance criteria
 * captured at intake time. When a Matt-via-Ai task is accepted, the
 * ticket's AC (from the description) are captured verbatim as the AC
 * of record — not Ai's restatement. Ai may annotate alongside, but
 * sign-off is judged against the verbatim original.
 *
 * Storage is persisted to a JSON file. The path resolves as: the explicit
 * AC_RECORDS_PATH override, else `<DATA_DIR>/ac-records.json`, using the same
 * `process.env.DATA_DIR ?? <cwd>/data` convention every other connector store
 * uses (see src/db.ts, src/store/*.ts, src/bag/*.ts) so AC records live
 * alongside the rest of the connector state. On startup, existing records are
 * loaded from disk. The store is keyed by ticket identifier (e.g. "AI-1482").
 *
 * Design: design.md §13b (Phase 6.5 hardening).
 */
/**
 * Resolve the on-disk path for persisted AC records.
 *
 * Precedence: the explicit AC_RECORDS_PATH override, else the shared data
 * directory (`DATA_DIR` env, else `<cwd>/data`) joined with "ac-records.json".
 * Resolving at call time — not module load — lets DATA_DIR / AC_RECORDS_PATH be
 * set before the first store operation (e.g. by tests). Exported as a test seam
 * so AC1 can be proven by asserting on the resolved string, with no disk I/O to
 * the real data directory. (AI-1827)
 */
export declare function acRecordsPath(): string;
/** A verbatim AC record captured at intake. */
export interface AcRecord {
    /** The verbatim AC text from Matt (extracted from the issue description at accept time). */
    verbatimAc: string;
    /** ISO timestamp when the AC was captured. */
    capturedAt: string;
    /** The agent/body that captured (accepted) the AC. */
    capturedBy: string;
    /** The source field — indicates where the AC was extracted from (e.g. "description"). */
    source: string;
}
/**
 * Capture the verbatim AC for a ticket at accept time.
 * Overwrites any existing record (re-accept from intake).
 * Persists to disk after capture.
 */
export declare function captureAc(ticketId: string, record: AcRecord): Promise<void>;
/**
 * Retrieve the verbatim AC record for a ticket.
 * Returns null if no AC has been captured (ad-hoc or pre-H-7 tickets).
 */
export declare function getAcRecord(ticketId: string): Promise<AcRecord | null>;
/**
 * Check whether a ticket has a captured verbatim AC record.
 */
export declare function hasAcRecord(ticketId: string): Promise<boolean>;
/**
 * Remove the AC record for a ticket (cleanup on escape/demote).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export declare function removeAcRecord(ticketId: string): Promise<boolean>;
/** Clear all AC records. Used in tests. */
export declare function clearAcRecordStore(): void;
/**
 * Extract acceptance criteria from an issue description.
 * Looks for "### Acceptance" or "## Acceptance" or "### AC" headers
 * and returns the text under that section.
 *
 * Returns null when no AC section header is found — a ticket without
 * an explicit Acceptance section should NOT have its full description
 * treated as the AC of record (the description includes scope, routing,
 * and context that are NOT acceptance criteria).
 */
export declare function extractAcFromDescription(description: string): string | null;
/**
 * AI-1776 AC3: Steward-gated recapture of the AC of record.
 *
 * Allows a steward to (re)capture the verbatim AC from the ticket's current
 * description after the accept transition — for tickets that entered the spine
 * without a snapshot (e.g. capture failed at accept, or the description was
 * finalized after accept).
 *
 * Authorization: the caller must be a body that fills the `steward` role
 * (resolved via the capability policy). Non-steward callers are rejected.
 *
 * Overwrite semantics: if a record already exists, `force: true` is required.
 * A forced overwrite posts a Linear comment trail naming the steward and the
 * action, so the audit path is preserved. Fresh creates post no comment.
 *
 * @param ticketId      Linear ticket identifier (e.g. "AI-1776")
 * @param authToken     Linear auth token (Bearer ...) for API calls
 * @param callerBodyId  The body ID of the caller (must be a steward)
 * @param opts.force    When true, allows overwriting an existing record
 */
export declare function recaptureAc(ticketId: string, authToken: string, callerBodyId: string, opts?: {
    force?: boolean;
}): Promise<void>;
//# sourceMappingURL=ac-record-store.d.ts.map