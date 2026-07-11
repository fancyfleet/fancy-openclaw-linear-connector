/** Adapt one C3 `GeneratedProposal` into the `ApplyProposal` the pipeline consumes. */
export function toApplyProposal(generated) {
    return {
        // Stable, dedupe-friendly id: the console/retry-apply route key IS the key
        // the apply pipeline looks the proposal up by.
        id: generated.idempotencyKey,
        idempotencyKey: generated.idempotencyKey,
        // ProposalTarget ≡ ApplyTarget — pass the deterministic core through verbatim.
        targets: generated.targets,
        evidenceCluster: generated.evidenceCluster,
    };
}
/**
 * Persist freshly generated proposals into the unified store so they surface in
 * the `/admin/api/proposals` console queue and are applyable by idempotency key.
 * Returns the adapted `ApplyProposal`s — their `id`s are the console / retry
 * route keys.
 */
export function persistGeneratedProposals(store, generated) {
    const applied = generated.map(toApplyProposal);
    for (const proposal of applied) {
        store.saveProposal(proposal);
    }
    return applied;
}
//# sourceMappingURL=generated-proposal-adapter.js.map