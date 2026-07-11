/**
 * AI-1914 — Workflow-def state-removal migration.
 *
 * When a workflow def version removes a state, any governed ticket still labeled
 * `state:<removed>` is stranded: every forward verb fails closed on the unknown
 * state and the only sanctioned exit (`escape`) is lossy. This module provides
 * the non-lossy, agent-reachable path:
 *
 *   - planDefStateMigration()      — AC1/AC5: decide whether a ticket at a removed
 *                                    state has a mapped target (auto-migrate) or is
 *                                    an unmapped strand (leave alone).
 *   - runDefStateMigrationSweep()  — AC1: enumerate governed tickets and migrate
 *                                    each mapped defunct-state ticket atomically
 *                                    (label swap + re-dispatch + operational event).
 *   - validateDefStateRemovals()   — AC3: refuse to activate a def that removes a
 *                                    state without a mapping or an explicit strand ack.
 *   - registerDefStateMigrationRunner() — AC6: bootstrap wiring; runs the sweep on
 *                                    load and exposes liveness for /health.
 *
 * The raw-mutation fail-open that this path replaces is closed in
 * `workflow-gate.ts` (`checkRawMutationInterception`, AC4).
 */
import type { WorkflowDef } from "./workflow-gate.js";
import type { OperationalEventInput } from "./store/operational-event-store.js";
export interface DefStateMigrationPlan {
    fromState: string;
    toState: string;
    /** owner_role of the TARGET state — re-dispatch must reach this role, not the source's. */
    ownerRole?: string;
}
/** Minimal operational-event sink. Supports both the real store (`append`) and the
 *  `record`-shaped sink used elsewhere (rescue sweep); either is honored. */
type OperationalEventPayload = OperationalEventInput;
interface OperationalEventSink {
    append?(event: OperationalEventPayload): unknown;
    record?(event: OperationalEventPayload): unknown;
}
export interface DefStateMigrationSweepOptions {
    /** Linear auth token (Bearer ...). */
    authToken: string;
    /** Workflow registry: map of wf-id → WorkflowDef. */
    workflowRegistry: Map<string, WorkflowDef>;
    /** Operational event store (optional; one event per migrated ticket). */
    operationalEventStore?: OperationalEventSink;
    /** Resolver: label name → Linear label UUID (or null). When omitted, team labels
     *  are fetched per team to build the mapping (mirrors the rescue sweep). */
    labelNameToId?: (name: string) => string | null;
    /** Re-dispatch primitive: wake the target owner for a migrated ticket. */
    wakeFn: (agent: string, identifier: string) => Promise<void>;
}
export interface DefStateMigrationSweepResult {
    scanned: number;
    migrated: Array<{
        ticketId: string;
        identifier: string;
        fromState: string;
        toState: string;
    }>;
    errors: string[];
}
/**
 * Decide whether a ticket's labels indicate a def-state migration.
 *
 * Returns a plan `{fromState, toState, ownerRole}` when the ticket's `state:*`
 * label names a state that is ABSENT from `def.states` but PRESENT as a key in
 * `def.migrations`. Returns null for a still-valid state, a removed state with
 * no mapping (a strand, not an auto-migration), an ungoverned ticket (no wf:*),
 * or a governed ticket with no state:* label.
 */
export declare function planDefStateMigration(labels: string[], def: WorkflowDef): DefStateMigrationPlan | null;
/**
 * Return an error per state present in `previousStateIds` but absent from
 * `nextDef.states` that has NEITHER a `nextDef.migrations` mapping NOR an entry
 * in `nextDef.strand_acknowledged`. Empty array ⇒ safe to activate.
 */
export declare function validateDefStateRemovals(previousStateIds: string[], nextDef: WorkflowDef): string[];
/**
 * Enumerate governed (wf:*) tickets and migrate each ticket stranded at a
 * removed state that carries a `migrations` mapping in its def: atomically swap
 * the `state:*` label (drop defunct, add target), re-dispatch (wake) the target
 * state's owner role, and emit one operational event per migrated ticket.
 *
 * Idempotent: a ticket at a live state (or a removed state with no mapping) is
 * left untouched. Nothing is fetched when no registered def declares a migration
 * map — there is nothing an auto-migration could act on.
 */
export declare function runDefStateMigrationSweep(options: DefStateMigrationSweepOptions): Promise<DefStateMigrationSweepResult>;
export interface DefStateMigrationLiveness {
    /** True once the runner has been registered at bootstrap. */
    ranOnLoad: boolean;
    /** Number of tickets migrated on the most recent load sweep (0 allowed). */
    migratedCount: number;
    /** Number of governed tickets scanned on the most recent load sweep. */
    scanned: number;
    /** ISO timestamp of the last completed sweep, or null if it has not finished yet. */
    lastRunAt: string | null;
    /** Non-fatal errors from the last sweep. */
    errors: string[];
}
/** Liveness snapshot for /health (AC6): confirms the migration check ran on load. */
export declare function getDefStateMigrationLiveness(): DefStateMigrationLiveness;
/** Test hook: reset liveness between app boots. */
export declare function resetDefStateMigrationLiveness(): void;
export interface DefStateMigrationRunnerOptions {
    authToken: string;
    /** Lazily resolve the workflow registry (async load happens off the boot path). */
    loadRegistry: () => Promise<Map<string, WorkflowDef>>;
    operationalEventStore?: OperationalEventSink;
    wakeFn: (agent: string, identifier: string) => Promise<void>;
    labelNameToId?: (name: string) => string | null;
}
/**
 * AC6: register the def-load migration runner at server bootstrap. Marks
 * liveness synchronously (so /health reports a numeric migratedCount of 0
 * immediately) and runs the sweep off the boot path, updating the count when it
 * completes. Reachable from the production entry point (index.ts createApp).
 */
export declare function registerDefStateMigrationRunner(options: DefStateMigrationRunnerOptions): void;
export {};
//# sourceMappingURL=def-state-migration.d.ts.map