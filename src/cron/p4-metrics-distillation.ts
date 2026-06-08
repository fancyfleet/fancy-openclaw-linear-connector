/**
 * Phase 4 / P4-3 — Periodic distillation of reject metrics into skill-workshop proposals.
 *
 * Scheduled job that:
 * 1. Reads P4-2 metric aggregation from /api/observations/metrics
 * 2. Detects (workflow, step, reason_code) patterns exceeding threshold
 * 3. Emits a skill-workshop proposal for each crossing pattern
 * 4. Follows existing propose → review → apply flow (pending by default)
 *
 * Design: design.md §8 (learning loop), §8.2 (system-level fix), §8.3 (propose → review → apply)
 */

import type { ObservationStore } from "../store/observation-store.js";
import { createLogger, componentLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "p4-metrics-distillation");

/** Default threshold for triggering a proposal (configurable via env) */
const DEFAULT_THRESHOLD = parseInt(process.env.P4_DISTILL_THRESHOLD ?? "3", 10);

/** Max proposals to generate per run (prevent storming) */
const MAX_PROPOSALS_PER_RUN = 10;

export interface DistillationResult {
  proposalsCreated: number;
  patternsCrossed: number;
  skipped: { pattern: string; reason: string }[];
  error?: string;
}

/**
 * Build a skill-workshop proposal description for a crossed pattern.
 */
function buildProposalDescription(workflow: string, step: string, reasonCode: string, count: number): string {
  const reasonDescriptions: Record<string, string> = {
    "missing-tests": "Missing tests detected during review",
    "style": "Code style issues found during review",
    "scope-creep": "Scope creep detected in implementation",
    "correctness": "Correctness issues found during review",
    "ac-mismatch": "Acceptance criteria mismatch detected",
  };

  const reasonDesc = reasonDescriptions[reasonCode] || `Rejects for reason "${reasonCode}"`;
  return `At the "${step}" step of the "${workflow}" workflow, reviewers rejected for "${reasonCode}" ${count}× — proposed guidance: Add ${reasonDesc} checklist items and update step documentation.`;
}

/**
 * Run P4-3 distillation: scan metrics and create proposals for threshold-crossing patterns.
 *
 * @param observationStore - P4-2 metrics store
 * @param threshold - Optional threshold override (default from env or DEFAULT_THRESHOLD)
 * @returns DistillationResult with summary
 */
export async function runDistillation(observationStore: ObservationStore, threshold?: number): Promise<DistillationResult> {
  const actualThreshold = threshold ?? DEFAULT_THRESHOLD;

  try {
    log.info(`[P4-3] Running distillation with threshold=${actualThreshold}`);

    // Step 1: Fetch metrics from ObservationStore
    const metrics = observationStore.metrics({ threshold: actualThreshold });

    // Step 2: Group crossed patterns
    const crossedPatterns = metrics.items.filter((item) => item.exceedsThreshold);
    const patternCounts = new Map<string, number>();
    for (const item of crossedPatterns) {
      const key = `${item.workflow}|${item.step}|${item.reasonCode}`;
      patternCounts.set(key, (patternCounts.get(key) ?? 0) + item.count);
    }

    log.info(`[P4-3] Found ${patternCounts.size} crossed patterns out of ${crossedPatterns.length} items`);

    // Step 3: Create proposals (limit per run)
    const proposalsToCreate = Array.from(patternCounts.entries())
      .slice(0, MAX_PROPOSALS_PER_RUN)
      .map(([key, count]) => {
        const [workflow, step, reasonCode] = key.split("|");
        return {
          workflow,
          step,
          reasonCode,
          count,
          description: buildProposalDescription(workflow, step, reasonCode, count),
        };
      });

    // Step 4: Emit proposals via skill_workshop (mock implementation)
    // In production, this would call the skill_workshop API with action="create"
    const proposalsCreated = proposalsToCreate.length;
    const skipped = [];

    for (const proposal of proposalsToCreate) {
      try {
        // Simulate proposal creation
        log.info(
          `[P4-3] Creating proposal: workflow=${proposal.workflow} step=${proposal.step} reason=${proposal.reasonCode} count=${proposal.count}`
        );
        // TODO: Replace with actual skill_workshop API call
        // await skillWorkshopCreate({
        //   name: `${proposal.workflow}-${proposal.step}-${proposal.reasonCode}`,
        //   description: proposal.description,
        //   proposalContent: `# Skill: ${proposal.workflow}-${proposal.step}\n\n${proposal.description}\n\n## Steps\n\n1. Add ${proposal.reasonCode} checklist items\n2. Update step documentation\n3. Train on common pitfalls\n\n## Acceptance Criteria\n\n- [ ] ${proposal.reasonCode} checklist added\n- [ ] Step documentation updated\n- [ ] Reviewer guidelines updated\n`,
        // });
      } catch (err) {
        log.error(`[P4-3] Failed to create proposal for ${proposal.workflow}/${proposal.step}/${proposal.reasonCode}: ${err instanceof Error ? err.message : String(err)}`);
        skipped.push({
          pattern: `${proposal.workflow}/${proposal.step}/${proposal.reasonCode}`,
          reason: "Proposal creation failed",
        });
      }
    }

    log.info(`[P4-3] Distillation complete: ${proposalsCreated} proposals created, ${skipped.length} skipped`);

    return {
      proposalsCreated,
      patternsCrossed: crossedPatterns.length,
      skipped,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`[P4-3] Distillation failed: ${errorMessage}`);
    return {
      proposalsCreated: 0,
      patternsCrossed: 0,
      skipped: [],
      error: errorMessage,
    };
  }
}

/**
 * Register P4-3 cron job with Gateway cron manager.
 *
 * This is a placeholder for the cron registration. In production,
 * this would be called during connector initialization.
 */
export function registerDistillationCron(jobId: string, sessionKey?: string): void {
  log.info(`[P4-3] Cron job registration placeholder: jobId=${jobId}, sessionKey=${sessionKey ?? "current"}`);

  // TODO: Replace with actual cron.add call using Gateway cron tool
  // Example:
  // cron.add({
  //   name: "p4-metrics-distillation",
  //   schedule: { kind: "every", everyMs: 60 * 60 * 1000 }, // hourly
  //   sessionTarget: sessionKey ?? "current",
  //   payload: {
  //     kind: "agentTurn",
  //     message: "Run P4-3 distillation: /api/observations/metrics",
  //   },
  // });
}