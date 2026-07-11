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
import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";
import { resolveBodiesForRole } from "./escalation-gate.js";
const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "ac-record-store");
/** Linear GraphQL API endpoint (used by recaptureAc to fetch description / post comments). */
const LINEAR_API_URL = "https://api.linear.app/graphql";
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
export function acRecordsPath() {
    if (process.env.AC_RECORDS_PATH)
        return process.env.AC_RECORDS_PATH;
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    return path.join(dataDir, "ac-records.json");
}
/** In-memory store: ticket identifier → AcRecord. */
const _store = new Map();
/** Whether the initial load from disk has been attempted. */
let _loaded = false;
/** The path from which _store was last loaded — invalidated when the path changes. */
let _loadedFromPath = null;
/**
 * Load persisted AC records from disk. Idempotent — only loads once per path.
 * Re-loads automatically when AC_RECORDS_PATH changes (test isolation).
 * Fail-open: if the file doesn't exist or is corrupt, we start with an empty store
 * and log a warning.
 */
async function ensureLoaded() {
    const currentPath = acRecordsPath();
    if (_loaded && _loadedFromPath === currentPath)
        return;
    _store.clear();
    _loaded = true;
    _loadedFromPath = currentPath;
    try {
        const raw = await fs.readFile(acRecordsPath(), "utf8");
        const data = JSON.parse(raw);
        for (const [key, record] of Object.entries(data)) {
            _store.set(key, record);
        }
        log.info(`ac-record-store: loaded ${_store.size} record(s) from ${acRecordsPath()}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err?.code === "ENOENT") {
            log.info(`ac-record-store: no persisted records file at ${acRecordsPath()} — starting fresh`);
        }
        else {
            log.warn(`ac-record-store: failed to load persisted records from ${acRecordsPath()}: ${msg}`);
        }
    }
}
/**
 * Persist the current store to disk. Fail-open: logs errors but never throws.
 */
async function persist() {
    try {
        const data = {};
        for (const [key, record] of _store) {
            data[key] = record;
        }
        const target = acRecordsPath();
        // Ensure the data directory exists — DATA_DIR may point at a location the
        // rest of the service hasn't created yet. Without this, writeFile would
        // ENOENT and (fail-open) silently drop the record.
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`ac-record-store: failed to persist records to ${acRecordsPath()}: ${msg}`);
    }
}
/**
 * Capture the verbatim AC for a ticket at accept time.
 * Overwrites any existing record (re-accept from intake).
 * Persists to disk after capture.
 */
export async function captureAc(ticketId, record) {
    await ensureLoaded();
    _store.set(ticketId, record);
    log.info(`ac-record-store: captured verbatim AC for ${ticketId} (by ${record.capturedBy}, ${record.verbatimAc.length} chars)`);
    await persist();
}
/**
 * Retrieve the verbatim AC record for a ticket.
 * Returns null if no AC has been captured (ad-hoc or pre-H-7 tickets).
 */
export async function getAcRecord(ticketId) {
    await ensureLoaded();
    return _store.get(ticketId) ?? null;
}
/**
 * Check whether a ticket has a captured verbatim AC record.
 */
export async function hasAcRecord(ticketId) {
    await ensureLoaded();
    return _store.has(ticketId);
}
/**
 * Remove the AC record for a ticket (cleanup on escape/demote).
 * Returns true if a record was removed, false if none existed.
 * Persists to disk after removal.
 */
export async function removeAcRecord(ticketId) {
    await ensureLoaded();
    const had = _store.delete(ticketId);
    if (had) {
        log.info(`ac-record-store: removed AC record for ${ticketId}`);
        await persist();
    }
    return had;
}
/** Clear all AC records. Used in tests. */
export function clearAcRecordStore() {
    _store.clear();
    _loaded = false;
    _loadedFromPath = null;
}
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
export function extractAcFromDescription(description) {
    if (!description)
        return null;
    // Try to find an "### Acceptance" or "### AC" or "## Acceptance" section.
    // AI-1776 AC1: tolerate trailing decoration on the header line (e.g.
    // "## Acceptance criteria (draft — final at intake)", "### AC — final").
    // The word-boundary anchor (`\b`) after the keyword prevents matching
    // unrelated words while allowing trailing qualifier text.
    const acPatterns = [
        /^#{1,3}\s*(?:Acceptance(?:\s+Criteria)?|AC)\b.*$/mi,
    ];
    for (const pattern of acPatterns) {
        const match = pattern.exec(description);
        if (match) {
            const startIdx = match.index + match[0].length;
            // Extract until the next ## heading or end of string
            const remaining = description.slice(startIdx);
            const nextHeading = /^#{1,3}\s/m.exec(remaining);
            if (nextHeading) {
                return remaining.slice(0, nextHeading.index).trim();
            }
            return remaining.trim();
        }
    }
    // No AC section header found — return null rather than the full description.
    log.warn(`ac-record-store: extractAcFromDescription: no '### Acceptance' or '### AC' header found in description — returning null (full description will NOT be treated as AC of record)`);
    return null;
}
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
export async function recaptureAc(ticketId, authToken, callerBodyId, opts) {
    // ── Authorization: steward-only ──────────────────────────────────────────
    const stewardBodies = await resolveBodiesForRole("steward");
    if (!stewardBodies.includes(callerBodyId)) {
        throw new Error(`recaptureAc: caller '${callerBodyId}' is not authorized — only steward bodies can recapture the AC of record`);
    }
    const force = opts?.force === true;
    // ── Overwrite guard ────────────────────────────────────────────────────────
    const existing = await getAcRecord(ticketId);
    if (existing && !force) {
        throw new Error(`recaptureAc: an AC record already exists for ${ticketId} (captured by ${existing.capturedBy}). Use { force: true } to overwrite.`);
    }
    // ── Fetch description ─────────────────────────────────────────────────────
    const descriptionQuery = `query IssueDescription($id: String!) { issue(id: $id) { description } }`;
    let description;
    try {
        const res = await fetch(LINEAR_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authToken },
            body: JSON.stringify({ query: descriptionQuery, variables: { id: ticketId } }),
        });
        const data = (await res.json());
        const desc = data.data?.issue?.description;
        if (desc === undefined || desc === null) {
            throw new Error("description fetch returned no description");
        }
        description = desc;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`recaptureAc: could not fetch description for ${ticketId}: ${msg}`);
    }
    // ── Extract AC ─────────────────────────────────────────────────────────────
    const verbatimAc = extractAcFromDescription(description);
    if (!verbatimAc) {
        throw new Error(`recaptureAc: no acceptance criteria header found in the description for ${ticketId} — cannot create AC record`);
    }
    // ── Store (capture) ─────────────────────────────────────────────────────────
    const capturedAt = new Date().toISOString();
    await captureAc(ticketId, {
        verbatimAc,
        capturedAt,
        capturedBy: callerBodyId,
        source: "description",
    });
    log.info(`recaptureAc: captured AC for ${ticketId} (by ${callerBodyId}, force=${force}, ${verbatimAc.length} chars)`);
    // ── Comment trail on forced overwrite ───────────────────────────────────────
    if (existing && force) {
        const commentMutation = `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
      }
    `;
        const commentBody = `[AC Recapture] AC of record force-overwritten by steward **${callerBodyId}** at ${capturedAt}. ` +
            `The previous record (captured by ${existing.capturedBy}) has been replaced with the current description's acceptance criteria.`;
        try {
            await fetch(LINEAR_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: authToken },
                body: JSON.stringify({
                    query: commentMutation,
                    variables: { issueId: ticketId, body: commentBody },
                }),
            });
            log.info(`recaptureAc: posted force-overwrite comment trail for ${ticketId}`);
        }
        catch (err) {
            log.warn(`recaptureAc: failed to post force-overwrite comment for ${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
//# sourceMappingURL=ac-record-store.js.map