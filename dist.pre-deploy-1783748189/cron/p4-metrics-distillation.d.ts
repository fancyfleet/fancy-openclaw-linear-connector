/**
 * Phase 4 / P4-C3 — Periodic distillation of reject metrics into review-queue
 * proposals, via the deterministic generation engine and the unified C4 store.
 *
 * Scheduled job that, per run:
 * 1. Reads P4-C2 metric aggregation from the ObservationStore.
 * 2. Detects (workflow, step, reason_code) patterns exceeding threshold.
 * 3. Bridges each crossing pattern to a `FailureCluster` (AI-2037 shape).
 * 4. Feeds the clusters to `generateProposals` (AI-2038, deterministic engine).
 * 5. Persists the results into the unified C4 `ProposalStore` via
 *    `persistGeneratedProposals` (AI-2069 adapter) — so they surface in the
 *    `/admin/api/proposals` review console and are applyable by idempotency key.
 *
 * AI-2070: this replaces the legacy path, which emitted `skill_workshop`
 * proposals over the gateway `/tools/invoke` HTTP API and never touched the
 * unified store — the learning loop never actually looped. There is no gateway
 * round-trip anymore: dedup is inherent (the store upserts on the idempotency
 * key), so a stable pattern re-persists the same row rather than duplicating it.
 *
 * Design: design.md §8 (learning loop), §8.2 (system-level fix), §8.3 (propose → review → apply)
 */
import type { ObservationStore } from "../store/observation-store.js";
import { type GenerationContext } from "../proposal/proposal-generator.js";
import { type GeneratedProposalSink } from "../proposal/generated-proposal-adapter.js";
export interface DistillationResult {
    proposalsCreated: number;
    patternsCrossed: number;
    skipped: {
        pattern: string;
        reason: string;
    }[];
    error?: string;
}
/**
 * Prod `GenerationContext`: reads the real editable step-guidance surface for a
 * (workflow, state) from the instance-config root
 * (`{configRoot}/workflows/{workflowId}/{stateId}.md`). The generator's contract
 * is that an empty surface array ⇒ the cluster is skipped and no proposal is
 * emitted (AI-2038 steward ruling), so a missing guidance file returns `[]`.
 * The surface `path` is repo-relative (`workflows/<wf>/<state>.md`) — the same
 * form the apply pipeline resolves against the config root.
 */
export declare function createProdGenerationContext(): GenerationContext;
/**
 * Run P4-C3 distillation: scan metrics, generate deterministic proposals for the
 * threshold-crossing patterns, and persist them into the unified C4 store.
 *
 * The store upserts on the idempotency key, so re-running against a stable
 * pattern refreshes the same row rather than duplicating it — dedup is inherent,
 * no gateway round-trip.
 */
export declare function runDistillation(observationStore: ObservationStore, proposalStore: GeneratedProposalSink, ctx: GenerationContext, options?: {
    threshold?: number;
}): Promise<DistillationResult>;
/**
 * Register the P4-C3 distillation as an in-process recurring job.
 * Interval is controlled by P4_DISTILL_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export declare function registerDistillationCron(observationStore: ObservationStore, proposalStore: GeneratedProposalSink, ctx: GenerationContext): void;
//# sourceMappingURL=p4-metrics-distillation.d.ts.map