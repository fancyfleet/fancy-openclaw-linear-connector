/**
 * INF-205: single source of truth for native terminal-state classification.
 *
 * Linear's native workflow-state `type` is authoritative for "this issue is
 * closed": `completed`, `canceled`, and `duplicate` (a first-class type since
 * INF-203, NOT a flavor of canceled) all mean nothing will ever move the issue
 * again. Several engine subsystems additionally track a workflow-label notion
 * of terminality (`state:done` / `state:escape`); those label sets stay local
 * to their subsystems, but every subsystem that asks "is this issue natively
 * closed?" must answer it through this module so the classification cannot
 * drift between barrier evaluation, sweeps, and detectors again.
 *
 * Policy (INF-205 ask #1): a natively-closed child — including Duplicate and
 * Canceled — SATISFIES a parent's N→1 barrier. A duplicated child is closed;
 * holding the parent forever on it is the deadlock, not the safety.
 */

/** Native Linear state types that mean the issue is closed for good. */
export const TERMINAL_NATIVE_STATE_TYPES: ReadonlySet<string> = new Set([
  "completed",
  "canceled",
  "duplicate",
]);

/** Is this native Linear state type terminal? Null/undefined → false. */
export function isNativelyTerminal(stateType: string | null | undefined): boolean {
  return typeof stateType === "string" && TERMINAL_NATIVE_STATE_TYPES.has(stateType);
}
