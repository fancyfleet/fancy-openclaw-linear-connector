/**
 * AI-2069 — the explicit adapter that closes the C3 generation ↔ C4 apply seam.
 *
 * Two `ProposalStore`s coexist on `main`: C3 (AI-2038, `proposal-store.ts`) is
 * where generated proposals were meant to land, while C4 (AI-2039,
 * `../store/proposal-store.ts`) is the store the apply pipeline and the
 * `/admin/api/proposals` review console (C5, AI-2040) actually read. Nothing
 * bridged them, so the apply pipeline was inert end to end.
 *
 * This module makes the **C4 store the single source of truth** and provides
 * the "explicit adapter" the AI-2069 AC allows: the generation path writes
 * through here, and the console + apply pipeline read the same row. The two
 * `targets[]` shapes (`ProposalTarget` / `ApplyTarget`) are structurally
 * identical (`kind`/`path`/`oldContent`/`newContent`/`diff`), so the bridge is a
 * field re-map plus a stable id.
 *
 * `id` is the idempotency key: distinct proposals derive distinct keys
 * (`proposal-generator.computeIdempotencyKey`), and re-persisting the same
 * proposal upserts the same row (`ProposalStore.saveProposal` ON CONFLICT(id)),
 * so generation is naturally idempotent end to end. `getByIdempotencyKey`
 * (apply-pipeline lookup) and `getById` (console retry route) therefore resolve
 * to one and the same persisted proposal.
 */
import type { ApplyProposal } from "./apply-pipeline.js";
import type { GeneratedProposal } from "./proposal-generator.js";
/**
 * The C4 store surface this adapter writes through. Kept to the single method it
 * needs so the seam is exercised against the real store, not a DI fake — any
 * `ProposalStore` from `../store/proposal-store.ts` satisfies it.
 */
export interface GeneratedProposalSink {
    saveProposal(proposal: ApplyProposal, status?: string): void;
}
/** Adapt one C3 `GeneratedProposal` into the `ApplyProposal` the pipeline consumes. */
export declare function toApplyProposal(generated: GeneratedProposal): ApplyProposal;
/**
 * Persist freshly generated proposals into the unified store so they surface in
 * the `/admin/api/proposals` console queue and are applyable by idempotency key.
 * Returns the adapted `ApplyProposal`s — their `id`s are the console / retry
 * route keys.
 */
export declare function persistGeneratedProposals(store: GeneratedProposalSink, generated: GeneratedProposal[]): ApplyProposal[];
//# sourceMappingURL=generated-proposal-adapter.d.ts.map