/**
 * AI-2039 (P4-C4) — Apply pipeline: atomic, TOCTOU-guarded, versioned applies.
 *
 * An approved proposal mutates live step-guidance files
 * (`workflows/<wf>/<state>.md`) or workflow-def YAML (`workflows/<wf>.yaml`)
 * in the instance config dir — safely, idempotently, versioned, and reversibly.
 *
 * Guarantees (AC of record AI-2039 AC4.1–4.8):
 *  - **Atomic** (AC4.1): every file is written to a sibling temp file and
 *    renamed into place, so a concurrent wake read only ever observes the
 *    complete old or complete new bytes — never a torn/partial file — and no
 *    temp file is left behind.
 *  - **Hot-reload** (AC4.2/4.3): step guidance is read fresh per dispatch, so a
 *    guidance apply needs no invalidation. Workflow-def YAML *is* cached, so a
 *    YAML apply calls the injected `reloadWorkflowDefs()` (wired to
 *    `resetWorkflowCache` in prod) — an explicit def-cache reload, no restart.
 *  - **TOCTOU guard** (AC4.4): each target's current on-disk bytes are re-hashed
 *    and compared to the captured `oldContent.hash`. Any mismatch refuses the
 *    whole apply as `stale` (no write, no commit, no version bump) — a manual
 *    edit landing between generation and approval is preserved.
 *  - **Idempotent** (AC4.5): keyed by `idempotencyKey`; a second (or concurrent)
 *    apply of the same proposal is a no-op that returns `alreadyApplied`. An
 *    in-process per-key lock serializes double-clicks so exactly one apply and
 *    one version bump happen.
 *  - **Versioned + reversible** (AC4.6): every apply increments the `version:`
 *    field of the owning workflow-def YAML and commits both the changed file and
 *    the bumped def to git in the config dir. `git revert` restores prior content
 *    AND prior version.
 *  - **Baseline capture** (AC4.7): the cluster metrics snapshot + observation
 *    window is captured at apply time and stored with the applied record so a
 *    before/after comparison is computable at pilot. Not captured on a stale
 *    refusal.
 *  - **Failure surfacing** (AC4.8): any failure (e.g. the git commit) rolls the
 *    files back to their pre-apply bytes (no half-write), records `apply-failed`
 *    with a `retryable` flag, and is re-runnable via {@link retryApply}.
 *
 * Proposal shape is C3's amended `targets[]` (AI-2038 AC3.1):
 *   { id, idempotencyKey, targets: [{ kind, path, oldContent:{hash,snapshot}, newContent, diff }] }
 * where `path` is relative to `deps.configRoot`.
 */
export type TargetKind = "guidance" | "yaml";
export interface ApplyTarget {
    kind: TargetKind;
    /** Path relative to deps.configRoot. */
    path: string;
    oldContent: {
        hash: string;
        snapshot: string;
    };
    newContent: string;
    diff: string;
}
export interface ApplyProposal {
    id: string;
    idempotencyKey: string;
    targets: ApplyTarget[];
    /** Optional evidence cluster carried from C3; passed through to the record. */
    evidenceCluster?: unknown;
}
export interface MetricsBaseline {
    snapshot: unknown;
    window: {
        since: string;
        until: string;
    };
}
export interface ApplyStore {
    getByIdempotencyKey(key: string): unknown | null;
    record(rec: AppliedRecord): void;
}
export interface AppliedRecord {
    id: string;
    idempotencyKey: string;
    status: ApplyStatus;
    version?: number;
    commit?: string;
    metricsBaseline?: MetricsBaseline;
    staleTargets?: string[];
    error?: string;
    retryable?: boolean;
    updatedAt: number;
}
export interface ApplyDeps {
    /** Instance config dir — a git-tracked repo; target paths resolve against it. */
    configRoot: string;
    store: ApplyStore;
    /** Cluster metrics snapshot + observation window, captured at apply time (AC4.7). */
    captureMetrics: () => MetricsBaseline;
    /** Explicit def-cache reload for YAML applies (AC4.3); wired to resetWorkflowCache in prod. */
    reloadWorkflowDefs: () => void;
    /** Injected clock (Date.now() is banned in some modules). */
    now: () => number;
}
export type ApplyStatus = "applied" | "apply-failed" | "stale";
export interface ApplyResult {
    status: ApplyStatus;
    version?: number;
    commit?: string;
    metricsBaseline?: MetricsBaseline;
    staleTargets?: string[];
    error?: string;
    retryable?: boolean;
    alreadyApplied?: boolean;
}
/**
 * Apply an approved proposal. Atomic, TOCTOU-guarded, idempotent, versioned,
 * and reversible. See the module header for the AC mapping.
 */
export declare function applyProposal(proposal: ApplyProposal, deps: ApplyDeps): Promise<ApplyResult>;
/**
 * Re-run a previously failed (or not-yet-applied) apply — the API's retry
 * affordance (AC4.8). Identical to {@link applyProposal}: an already-applied
 * proposal short-circuits to `alreadyApplied`, so a retry after success still
 * bumps the version exactly once total.
 */
export declare function retryApply(proposal: ApplyProposal, deps: ApplyDeps): Promise<ApplyResult>;
//# sourceMappingURL=apply-pipeline.d.ts.map