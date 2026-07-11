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

import fs from "node:fs";
import path from "node:path";

import type { ObservationStore } from "../store/observation-store.js";
import { UNCLASSIFIED_REASON_CODE } from "../store/observation-store.js";
import {
  generateProposals,
  type FailureCluster,
  type GenerationContext,
  type EditableSurface,
} from "../proposal/proposal-generator.js";
import {
  persistGeneratedProposals,
  type GeneratedProposalSink,
} from "../proposal/generated-proposal-adapter.js";
import { defaultGuidanceDir, instanceConfigRoot } from "../instance-config.js";
import { createLogger, componentLogger } from "../logger.js";
import { registerCron, markCronRun, formatIntervalMs } from "./registry.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "p4-metrics-distillation");

const DEFAULT_THRESHOLD = parseInt(process.env.P4_DISTILL_THRESHOLD ?? "3", 10);
const MAX_PROPOSALS_PER_RUN = parseInt(process.env.MAX_PROPOSALS_PER_RUN ?? "10", 10);
const DEFAULT_INTERVAL_MS = parseIntervalMs(process.env.P4_DISTILL_INTERVAL ?? "1h");

/** Registry key — shared by the registrar and the post-run liveness stamp. */
const DISTILLATION_CRON_NAME = "p4-metrics-distillation";

export interface DistillationResult {
  proposalsCreated: number;
  patternsCrossed: number;
  skipped: { pattern: string; reason: string }[];
  error?: string;
}

/** Parse a duration string like "1h", "30m", "3600s" or raw milliseconds. */
function parseIntervalMs(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return 60 * 60 * 1000; // default 1h
  const n = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
    case "d":  return n * 86_400_000;
    default:   return 3_600_000;
  }
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
export function createProdGenerationContext(): GenerationContext {
  return {
    readSurfaces(workflowId: string, stateId: string): EditableSurface[] {
      const abs = path.join(defaultGuidanceDir(), workflowId, `${stateId}.md`);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        return []; // no editable surface → generator skips this cluster
      }
      return [
        {
          kind: "guidance",
          path: path.relative(instanceConfigRoot(), abs),
          content,
        },
      ];
    },
  };
}

/**
 * Run P4-C3 distillation: scan metrics, generate deterministic proposals for the
 * threshold-crossing patterns, and persist them into the unified C4 store.
 *
 * The store upserts on the idempotency key, so re-running against a stable
 * pattern refreshes the same row rather than duplicating it — dedup is inherent,
 * no gateway round-trip.
 */
export async function runDistillation(
  observationStore: ObservationStore,
  proposalStore: GeneratedProposalSink,
  ctx: GenerationContext,
  options?: { threshold?: number },
): Promise<DistillationResult> {
  const actualThreshold = options?.threshold ?? DEFAULT_THRESHOLD;

  try {
    log.info(`[P4-C3] Running distillation with threshold=${actualThreshold}`);

    const metrics = observationStore.metrics({ threshold: actualThreshold });
    const crossedPatterns = metrics.items.filter((item) => item.exceedsThreshold);

    // AI-2036: `unclassified` means the reviewer named no category. It clusters
    // like any other code, but there is no lesson to distil from "we don't know
    // why" — a proposal for it would be noise. Count it, surface it, never
    // propose from it.
    const proposable = crossedPatterns.filter((item) => item.reasonCode !== UNCLASSIFIED_REASON_CODE);
    const uncategorized = crossedPatterns.length - proposable.length;

    log.info(
      `[P4-C3] Found ${crossedPatterns.length} crossed pattern(s)` +
        (uncategorized > 0 ? ` — ${uncategorized} uncategorized, not proposable` : ""),
    );

    // Bridge each crossing metric row to a FailureCluster (MetricRow.tickets →
    // FailureCluster.ticketIds). The generator only considers exceedsThreshold
    // clusters, so we mark these true and let it merge by (workflow, state).
    const clusters: FailureCluster[] = proposable.map((item) => ({
      workflow: item.workflow,
      step: item.step,
      reasonCode: item.reasonCode,
      count: item.count,
      exceedsThreshold: true,
      ticketIds: item.tickets,
    }));

    const generated = generateProposals(clusters, ctx);

    // Bound the writes per run: a single run should not flood the review queue.
    // The generator's output order is stable (by workflow/state), so the cap is
    // deterministic. Clusters whose state has no editable surface already
    // produced no proposal and are reported as skipped.
    const capped = generated.slice(0, MAX_PROPOSALS_PER_RUN);
    const skipped: { pattern: string; reason: string }[] = [];
    if (generated.length > capped.length) {
      for (const p of generated.slice(MAX_PROPOSALS_PER_RUN)) {
        skipped.push({ pattern: `${p.workflowId}/${p.stateId}`, reason: "max-proposals-per-run" });
      }
    }

    // Persist through the C4 adapter — the unified store the console + apply
    // pipeline read. NOT the legacy skill_workshop gateway path.
    persistGeneratedProposals(proposalStore, capped);

    log.info(`[P4-C3] Distillation complete: ${capped.length} persisted, ${skipped.length} skipped`);

    return { proposalsCreated: capped.length, patternsCrossed: crossedPatterns.length, skipped };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`[P4-C3] Distillation failed: ${errorMessage}`);
    return { proposalsCreated: 0, patternsCrossed: 0, skipped: [], error: errorMessage };
  }
}

/**
 * Register the P4-C3 distillation as an in-process recurring job.
 * Interval is controlled by P4_DISTILL_INTERVAL env var (default: 1h).
 * The timer is unref'd so it won't prevent graceful shutdown.
 */
export function registerDistillationCron(
  observationStore: ObservationStore,
  proposalStore: GeneratedProposalSink,
  ctx: GenerationContext,
): void {
  const intervalMs = DEFAULT_INTERVAL_MS;
  registerCron(DISTILLATION_CRON_NAME, `every ${formatIntervalMs(intervalMs)}`);
  const timer = setInterval(() => {
    runDistillation(observationStore, proposalStore, ctx)
      .then(() => markCronRun(DISTILLATION_CRON_NAME))
      .catch((err) => {
        log.error(`[P4-C3] Scheduled distillation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, intervalMs);
  timer.unref();
  log.info(`[P4-C3] Distillation scheduled every ${intervalMs}ms (P4_DISTILL_INTERVAL=${process.env.P4_DISTILL_INTERVAL ?? "1h"})`);
}
