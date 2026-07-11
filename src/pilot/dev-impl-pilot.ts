/**
 * AI-2041 (P4-C6) — Dev-impl learning-loop pilot harness.
 *
 * ⚠️ SCAFFOLD ONLY — written by the test-author (tdd) to pin the contract the
 * failing AI-2041 tests grade against. Every function throws `NotImplemented`;
 * the implementer (Igor) replaces the bodies to turn the red bar green. Do NOT
 * treat this as a real implementation.
 *
 * The pilot drives the full loop on real infrastructure under the C6 elevated-
 * stakes guarantees:
 *
 *   observation-store data
 *     → distillation (cluster + deterministic generation)
 *     → unified proposal store (console-visible)
 *     → apply pipeline (versioned, git-committed)   [AC6.1]
 *   with a baseline observation window captured at apply             [AC6.2]
 *   gated on a HUMAN (Matt) sign-off — no AI self-sign-off           [AC6.4]
 *   and, when fed synthetic seed data, a mandatory real-data
 *   verification follow-up ticket + synthetic-flagged rows           [AC6.3]
 *
 * Contract types below are the seam the tests bind to. The implementer may
 * refine internals freely, but the exported signatures and the AC behaviours the
 * tests assert are the graded contract — escalate to Ai if any is untestable as
 * written rather than quietly changing it.
 */
import type { ObservationStore, ReasonCode } from "../store/observation-store.js";
import type { ProposalStore } from "../store/proposal-store.js";
import type { GenerationContext } from "../proposal/proposal-generator.js";
import type { MetricsBaseline } from "../proposal/apply-pipeline.js";

class NotImplemented extends Error {
  constructor(what: string) {
    super(`AI-2041 pilot harness not implemented: ${what}`);
    this.name = "NotImplemented";
  }
}

// ── AC6.4 — human sign-off ───────────────────────────────────────────────────

export type SignOffKind = "human" | "ai";

/** An apply/deploy authorization. Only a `human` sign-off may apply to prod. */
export interface SignOff {
  approver: string;
  kind: SignOffKind;
}

/**
 * Thrown when the apply/deploy is not authorized by a human sign-off (AC6.4,
 * elevated stakes level 0). Refusal is terminal for that run: no write, no git
 * commit, no version bump.
 */
export class SignOffRequiredError extends Error {
  constructor(message = "human sign-off required to apply the pilot proposal (AC6.4)") {
    super(message);
    this.name = "SignOffRequiredError";
  }
}

// ── AC6.3 — synthetic seed rows ──────────────────────────────────────────────

/** One synthetic observation seed row (AC6.3), written explicitly flagged synthetic. */
export interface SyntheticSeedRow {
  ticket: string;
  workflow: string;
  step: string;
  fromBody: string;
  reviewerBody: string;
  reasonCode: ReasonCode;
  freeText?: string | null;
  timestamp?: string;
}

/**
 * Seed synthetic observation rows into the store, each EXPLICITLY flagged as
 * synthetic (AC6.3). Returns the inserted observation ids.
 */
export function seedSyntheticObservations(
  _store: ObservationStore,
  _rows: SyntheticSeedRow[],
): number[] {
  throw new NotImplemented("seedSyntheticObservations");
}

/** The set of observation ids currently flagged synthetic in the store (AC6.3). */
export function syntheticObservationIds(_store: ObservationStore): Set<number> {
  throw new NotImplemented("syntheticObservationIds");
}

// ── AC6.2 — before/after same-category comparison ────────────────────────────

export interface CategoryComparison {
  workflow: string;
  step: string;
  reasonCode: string;
  /** Same-category observation count inside the captured baseline window. */
  before: number;
  /** Same-category observation count after the window closes. */
  after: number;
  window: { since: string; until: string };
}

/**
 * Produce a before/after same-category comparison purely from stored observation
 * data, given the baseline window captured at apply (AC6.2).
 */
export function compareBeforeAfter(
  _store: ObservationStore,
  _baseline: MetricsBaseline,
  _key: { workflow: string; step: string; reasonCode: string },
): CategoryComparison {
  throw new NotImplemented("compareBeforeAfter");
}

// ── AC6.1 — the pilot orchestrator ───────────────────────────────────────────

export interface PilotDeps {
  observationStore: ObservationStore;
  proposalStore: ProposalStore;
  generationContext: GenerationContext;
  /** Git-tracked instance-config root the apply pipeline commits into. */
  configRoot: string;
  now: () => number;
  /** Distillation threshold; defaults to the distillation job default when omitted. */
  threshold?: number;
  /** Def-cache reload for YAML applies; wired to resetWorkflowCache in prod. */
  reloadWorkflowDefs?: () => void;
  /** AC6.4 — must be a human sign-off, or the run is refused. */
  signOff: SignOff | null;
  /** AC6.3 — true when any observation feeding this run is synthetic. */
  synthetic?: boolean;
  /** AC6.3 — required when `synthetic` is true; the real-data verification ticket. */
  realDataFollowupTicket?: string | null;
}

export interface PilotResult {
  proposalId: string;
  status: "applied";
  version: number;
  commit: string;
  baseline: MetricsBaseline;
  synthetic: boolean;
  realDataFollowupTicket: string | null;
}

/**
 * Run the dev-impl learning-loop pilot end to end. See the module header for the
 * AC mapping. Throws {@link SignOffRequiredError} without a human sign-off
 * (AC6.4); throws when `synthetic` is set without a `realDataFollowupTicket`
 * (AC6.3). On success, returns the applied proposal's version, commit, and the
 * baseline observation window captured at apply (AC6.2).
 */
export async function runDevImplPilot(_deps: PilotDeps): Promise<PilotResult> {
  throw new NotImplemented("runDevImplPilot");
}
