/**
 * AI-2036 — Bootstrap registry + counters for the observation write path.
 *
 * Why this module exists
 * ----------------------
 * `observations` sat at 0 rows from the day P4-1 shipped (AI-1378) until
 * AI-2036. Nothing was broken loudly — the write was gated behind preconditions
 * that were never met, and the skip produced no row, no counter, and (for the
 * decisive precondition) no log line. The failure was invisible.
 *
 * Two things prevent a repeat:
 *
 *  1. **Registration is structural.** The proxy cannot obtain an ObservationStore
 *     except through `getRegisteredObservationStore()`, and that returns
 *     `undefined` until `registerObservationWriter()` runs at the production
 *     entry point. If a future refactor drops the bootstrap call, the write path
 *     goes dark *and says so* — `/health.observations.registered` flips to false
 *     and every transition emits a counted `store-unwired` skip. This is the
 *     AI-1773/AI-1775 dead-code-in-prod guard (AI-1808 addendum).
 *
 *  2. **Every outcome is counted.** Appended, degraded, and each distinct skip
 *     reason increment an in-process counter projected at `/health.observations`
 *     and mirrored to operational_events. A silent skip is no longer possible.
 *
 * Counters are in-process and reset on restart, matching DispatchIdempotencyStore.
 * The durable count of rows comes from the store itself (`rows`).
 */
import type { ObservationStore } from "./store/observation-store.js";
/**
 * Why a feedback-required transition produced no observation row.
 * Each value is a counted, logged, telemetry-visible outcome (AC1.3).
 */
export declare const OBSERVATION_SKIP_REASONS: readonly ["store-unwired", "from-body-unresolved", "write-failed"];
export type ObservationSkipReason = (typeof OBSERVATION_SKIP_REASONS)[number];
export interface ObservationCounters {
    /** Rows successfully appended since process start. */
    appended: number;
    /** Subset of `appended` written with the `unspecified` degraded reason code. */
    degraded: number;
    /** Feedback-required transitions that produced no row. */
    skipped: number;
    /** `skipped`, broken down by cause. Always has every key present. */
    skipsByReason: Record<ObservationSkipReason, number>;
}
export interface ObservationLiveness extends ObservationCounters {
    /** True only once `registerObservationWriter()` has run. Never a literal. */
    registered: boolean;
    /** Backing SQLite file, or null when unregistered. */
    dbPath: string | null;
    /** Durable row count read from the store, or null when unregistered. */
    rows: number | null;
}
/**
 * Register the observation write path at server bootstrap (AC1.5).
 *
 * Returns the store so callers wire it by *using the return value* — the
 * registration cannot be dropped without also dropping the store.
 */
export declare function registerObservationWriter(store: ObservationStore): ObservationStore;
/**
 * The registered store, or `undefined` if bootstrap never registered one.
 *
 * Callers that need to write observations MUST source the store from here so
 * that "wired at bootstrap" and "usable by the write path" are the same fact.
 */
export declare function getRegisteredObservationStore(): ObservationStore | undefined;
/** Record a successful append. `degraded` marks an `unspecified` reason code. */
export declare function countObservationAppended(degraded: boolean): void;
/** Record a skipped observation write. */
export declare function countObservationSkip(reason: ObservationSkipReason): void;
/**
 * Liveness snapshot for `/health.observations` (AC1.6).
 *
 * `registered` reflects a real bootstrap call, and `rows` is read from SQLite —
 * neither is a hardcoded literal, so a dead write path is visible here without
 * waiting for a feedback-required transition to occur.
 */
export declare function getObservationLiveness(): ObservationLiveness;
/** Test isolation only — drops the registration and zeroes the counters. */
export declare function resetObservationWiring(): void;
//# sourceMappingURL=observation-wiring.d.ts.map