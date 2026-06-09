/**
 * Phase 6.5 / H-7 — Verbatim AC record store (AI-1482).
 *
 * Connector-side immutable record of the verbatim acceptance criteria
 * captured at intake time. When a Matt-via-Ai task is accepted, the
 * ticket's AC (from the description) are captured verbatim as the AC
 * of record — not Ai's restatement. Ai may annotate alongside, but
 * sign-off is judged against the verbatim original.
 *
 * Storage is in-memory with optional JSON file persistence. The store is
 * keyed by ticket identifier (e.g. "AI-1482").
 *
 * Design: design.md §13b (Phase 6.5 hardening).
 */

import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "ac-record-store");

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

/** In-memory store: ticket identifier → AcRecord. */
const _store = new Map<string, AcRecord>();

/**
 * Capture the verbatim AC for a ticket at accept time.
 * Overwrites any existing record (re-accept from intake).
 */
export function captureAc(ticketId: string, record: AcRecord): void {
  _store.set(ticketId, record);
  log.info(`ac-record-store: captured verbatim AC for ${ticketId} (by ${record.capturedBy}, ${record.verbatimAc.length} chars)`);
}

/**
 * Retrieve the verbatim AC record for a ticket.
 * Returns null if no AC has been captured (ad-hoc or pre-H-7 tickets).
 */
export function getAcRecord(ticketId: string): AcRecord | null {
  return _store.get(ticketId) ?? null;
}

/**
 * Check whether a ticket has a captured verbatim AC record.
 */
export function hasAcRecord(ticketId: string): boolean {
  return _store.has(ticketId);
}

/**
 * Remove the AC record for a ticket (cleanup on escape/demote).
 * Returns true if a record was removed, false if none existed.
 */
export function removeAcRecord(ticketId: string): boolean {
  const had = _store.delete(ticketId);
  if (had) {
    log.info(`ac-record-store: removed AC record for ${ticketId}`);
  }
  return had;
}

/** Clear all AC records. Used in tests. */
export function clearAcRecordStore(): void {
  _store.clear();
}

/**
 * Extract acceptance criteria from an issue description.
 * Looks for "### Acceptance" or "## Acceptance" or "### AC" headers
 * and returns the text under that section.
 * Returns the full description if no AC section header is found.
 */
export function extractAcFromDescription(description: string): string {
  if (!description) return "";

  // Try to find an "### Acceptance" or "### AC" or "## Acceptance" section
  const acPatterns = [
    /^#{1,3}\s*(?:Acceptance(?:\s+Criteria)?|AC)\s*$/mi,
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

  // No AC section header found — return the full description
  return description.trim();
}
