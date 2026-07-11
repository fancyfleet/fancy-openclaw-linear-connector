/**
 * AI-2038 (P4-C3) — Proposal generation engine: deterministic, rule-based.
 *
 * Given failure clusters from C2 (AI-2037, AC2.1), emit concrete guidance/schema
 * edit proposals for human review. Pure and rule-based: no ML, no clock, no RNG.
 * The same input cluster always renders a byte-identical proposal (AC3.2).
 *
 * AC3.1 — the amended `targets[]` core. A single (workflow_id, state_id) fix can
 * touch more than one on-disk surface (its step-guidance `.md` AND its workflow
 * YAML def), so a proposal carries a NON-EMPTY `targets[]` array rather than the
 * superseded flat oldContent/newContent/diff. Each target is
 * {kind, path, old_content:{hash,snapshot}, new_content, diff}; `kind` is emitted
 * by the fired rule template (via the surface) and is NEVER inferred by consumers
 * from the path or file extension.
 *
 * AC3.5 — multi-workflow findings produce separate proposals per workflow, never
 * one combined proposal. `targets[]` groups the files touched WITHIN a single
 * (workflow, state); it is not a back door to a cross-workflow merge. Clusters
 * that share a (workflow, state) but differ by reasonCode merge into ONE
 * proposal whose evidence counts are keyed by reasonCode and whose failureCount
 * is the sum. Clusters in different workflows never merge.
 *
 * The deterministic core carries NO lifecycle fields (id/status/timestamps) —
 * those belong to the stored record (see proposal-store.ts). A timestamp in here
 * would break AC3.2.
 */
export type TargetKind = "guidance" | "yaml";
/**
 * A failure cluster produced by C2 (AI-2037, AC2.1). The generator consumes it
 * verbatim — it never derives ticket ids itself. `step` is C2's name for what
 * this engine surfaces as `stateId`.
 */
export interface FailureCluster {
    workflow: string;
    step: string;
    reasonCode: string;
    count: number;
    fromBody?: string;
    exceedsThreshold: boolean;
    ticketIds: string[];
}
/**
 * The mutation surfaces the fired rule template selects for a (workflowId,
 * stateId) — each with its canonical on-disk path, `kind` (from the template,
 * NOT sniffed from the extension) and current content. One (workflow, state) can
 * expose both a guidance file and a YAML def, so the generator emits one target
 * per surface. An EMPTY array means no editable surface exists (e.g. the guidance
 * file is absent) → the generator skips the cluster and emits no proposal
 * (steward ruling, AI-2038 16:12Z).
 */
export interface EditableSurface {
    kind: TargetKind;
    path: string;
    content: string;
}
export interface GenerationContext {
    readSurfaces(workflowId: string, stateId: string): EditableSurface[];
}
export interface ProposalTarget {
    kind: TargetKind;
    path: string;
    oldContent: {
        hash: string;
        snapshot: string;
    };
    newContent: string;
    diff: string;
}
export interface GeneratedProposal {
    workflowId: string;
    stateId: string;
    targets: ProposalTarget[];
    confidenceScore: number;
    evidenceCluster: {
        ticketIds: string[];
        counts: Record<string, number>;
    };
    failureCount: number;
    version: number;
    idempotencyKey: string;
}
/**
 * Normative idempotency derivation (AC3.1), the single source of truth so the
 * generator, the store and the revision path all agree:
 *
 *   sha256hex( concat( sorted.map(t => sha256hex(t.path) + sha256hex(t.diff)) ) )
 *
 * where `sorted` is `targets` sorted ascending by `path` (byte order). All
 * digests lowercase hex, input bytes utf-8. Sorts internally so callers may pass
 * targets in any order.
 */
export declare function computeIdempotencyKey(targets: Array<{
    path: string;
    diff: string;
}>): string;
/**
 * Generate deterministic, rule-based proposals from a set of failure clusters.
 *
 * Only clusters that exceed the threshold are considered. Surviving clusters are
 * grouped by (workflow, state); each group yields at most one proposal, touching
 * every editable surface that state exposes. A group whose state has no editable
 * surface is skipped (emits no proposal).
 */
export declare function generateProposals(clusters: FailureCluster[], ctx: GenerationContext): GeneratedProposal[];
//# sourceMappingURL=proposal-generator.d.ts.map