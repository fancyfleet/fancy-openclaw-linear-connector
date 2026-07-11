/**
 * Phase 5 / B-2 — Fan-out edge: spawning 1→N (AI-1439).
 *
 * Engine logic for the fan-out. On the researcher's `auditing → spawning` submit,
 * the findings list is the runtime cardinality (§5.2): the engine creates N
 * `dev-impl` children, links each to the parent, and transitions the parent → `managing`.
 *
 * Design: design.md §5.2, §5.4, §14.
 *
 * ACs:
 *   1. `submit` from `auditing` carries the findings list; engine mints N `dev-impl`
 *      children (each at `state:intake`, wf:dev-impl), one per finding.
 *   2. Each child is linked to the parent (parent/child relation set).
 *   3. Parent auto-transitions to `managing` once children are minted.
 *   4. A child may itself be an orchestrator — minting is uniform regardless (§5.4);
 *      no special-casing.
 *
 * This module is called from workflow-gate's applyStateTransition when the `spawn`
 * command is processed for a ux-audit ticket in the `spawning` state.
 */
import { type SpawnPreview, type SpawnCaps } from "./spawn-preview.js";
import type { FanoutConfig, WorkflowDef } from "./workflow-gate.js";
/** A single finding to fan out into its own child issue. */
export interface Finding {
    /** Short title / summary of the finding. */
    title: string;
    /** Detailed description (optional). */
    description?: string;
}
/** Result of a fan-out operation. */
export interface FanoutResult {
    /** Number of children successfully created. */
    created: number;
    /** Identifiers of created child issues (e.g. ["AI-1443", "AI-1444"]). */
    childIdentifiers: string[];
    /** Errors encountered during creation (non-fatal; partial success allowed). */
    errors: FanoutError[];
    /** Phase 6.5 / H-2: spawn-preview generated before instantiation. */
    preview: SpawnPreview | null;
    /** Phase 6.5 / H-2: whether the fan-out was refused by caps. */
    refused: boolean;
    /** Phase 6.5 / H-2: whether steward approval is pending. */
    pendingApproval: boolean;
}
export interface FanoutError {
    findingIndex: number;
    message: string;
}
/**
 * Parse findings from the ticket description.
 *
 * The researcher submits the findings list as part of the `complete-audit`
 * transition. The findings are embedded in the issue description in a structured
 * format. This parser extracts them.
 *
 * Expected format in the description (Markdown):
 * ```
 * ## Findings
 * - **Finding 1**: Short title
 * - **Finding 2**: Another title
 * ```
 *
 * Or as a structured block:
 * ```
 * ### Findings
 * 1. Title one
 * 2. Title two
 * 3. Title three
 * ```
 *
 * Falls back to line-by-line extraction if no structured block found.
 * Returns at least one finding (the ticket title itself as fallback) so the
 * fan-out always produces at least one child (§5.2).
 */
export declare function extractFindings(description: string | null | undefined, fallbackTitle: string): Finding[];
/**
 * AI-1992: Strict, config-driven spec extraction — NO title fallback.
 *
 * The declarative fan-out (AC5) refuses the transition on a malformed, ambiguous,
 * or empty spawn spec: the engine never guesses or partially spawns. Unlike
 * {@link extractFindings} (which always yields ≥1 finding via the ticket title),
 * this returns an EMPTY array when the parent description has no parseable spec
 * section named by `spec_source`. The caller treats [] as "refuse the transition".
 *
 * `spec_source` names the description section to read (e.g. "findings" → a
 * `## Findings` / `### Findings` markdown section). Parsing strategies mirror
 * extractFindings (markdown bullets/numbered list, JSON block, inline markers)
 * but are scoped to the named section and carry no fallback.
 */
export declare function extractSpecFindings(description: string | null | undefined, specSource: string): Finding[];
/**
 * AI-1992: Validate a fan-out spec ahead of the atomic transition (AC5).
 *
 * Returns the extracted findings when the spec is well-formed, or a structured
 * refusal reason otherwise. Used by the workflow engine to refuse the transition
 * BEFORE any state mutation or child spawn when the spec cannot be fully validated.
 */
export declare function validateFanoutSpec(description: string | null | undefined, config: FanoutConfig): {
    ok: true;
    findings: Finding[];
} | {
    ok: false;
    reason: string;
};
/**
 * Execute the fan-out: create N dev-impl children from the findings list.
 *
 * Called by the workflow engine when the `spawn` command is processed on a
 * ux-audit ticket in the `spawning` state.
 *
 * Steps:
 *   1. Fetch the parent issue's team, title, and description.
 *   2. Extract findings from the description.
 *   3. Ensure required labels exist (wf:dev-impl, state:intake).
 *   4. Create one child issue per finding, each linked to the parent.
 *   5. Return the result with created count and any partial errors.
 *
 * The caller (applyStateTransition) transitions the parent to `managing`
 * after a successful fan-out (or logs a warning on partial failure).
 *
 * AC4 (§5.4): Minting is uniform — children are always created as dev-impl
 * at intake, regardless of whether the child itself might be an orchestrator
 * archetype. No special-casing.
 */
export declare function executeFanout(parentIssueId: string, authToken: string, config: FanoutConfig, options?: {
    caps?: SpawnCaps;
    skipPreview?: boolean;
    findingsOverride?: Finding[];
}): Promise<FanoutResult>;
/**
 * AI-1992: Config-driven fan-out trigger — replaces the hardcoded ux-audit/sprint
 * allowlist. The fan-out fires when the current state declares a `fanout` block
 * and the incoming intent is that state's forward (non-break-glass) transition
 * command. Behavior is entirely YAML-driven: ANY workflow id fans out if its
 * state declares the config; a state with no fanout block never fans out.
 *
 * Returns the {@link FanoutConfig} (truthy) when the fan-out should fire, else
 * null. Returning the config lets the caller mint children under the configured
 * child_workflow and spec_source without re-reading the def.
 */
export declare function shouldTriggerFanout(def: WorkflowDef, currentState: string, intent: string): FanoutConfig | null;
//# sourceMappingURL=fanout.d.ts.map