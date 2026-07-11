/**
 * AI-2036 — the `unclassified` fallback must not feed proposal generation.
 *
 * Adding an `unclassified` reason code makes the observations table finally
 * populate, which in turn wakes the P4-C3 distillation cron that has never once
 * run against real data. Its threshold is 3 and it fires hourly, so the first
 * cluster to cross it would be `unclassified` — filing a proposal that reads
 * "unclassified rejected 3× — add checklist + update docs".
 *
 * There is no lesson to distil from "we don't know why". Count it, surface it at
 * /health, never propose from it.
 *
 * AI-2070 rewired the distillation guts: it now drives the deterministic engine
 * (`generateProposals`) into the unified C4 `ProposalStore` instead of emitting
 * skill_workshop proposals over the gateway. This regression guard therefore
 * asserts the SAME contract against the new mechanism — the unified store, not a
 * mocked gateway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { ObservationStore } from "../store/observation-store.js";
import { ProposalStore } from "../store/proposal-store.js";
import { runDistillation } from "./p4-metrics-distillation.js";
import type { GenerationContext } from "../proposal/proposal-generator.js";

const WORKFLOW = "dev-impl";
const STEP = "code-review";
const guidanceRel = path.join("workflows", WORKFLOW, `${STEP}.md`);

/** Prod-shaped ctx: one editable guidance surface for the group under test. */
const ctx: GenerationContext = {
  readSurfaces: (workflowId, stateId) => {
    if (workflowId !== WORKFLOW || stateId !== STEP) return [];
    return [
      {
        kind: "guidance",
        path: guidanceRel,
        content: `# ${STEP}\n\nReview the diff before approving.\n`,
      },
    ];
  },
};

function seed(store: ObservationStore, reasonCode: string, times: number): void {
  for (let i = 0; i < times; i++) {
    store.append({
      ticket: `AI-${1000 + i}`,
      workflow: WORKFLOW,
      step: STEP,
      fromBody: "igor",
      reviewerBody: "cra",
      reasonCode: reasonCode as never,
    });
  }
}

describe("AI-2036: P4-C3 distillation ignores the unclassified fallback", () => {
  let dir: string;
  let store: ObservationStore;
  let proposalStore: ProposalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-2036-distill-"));
    store = new ObservationStore(path.join(dir, "observations.db"));
    proposalStore = new ProposalStore(path.join(dir, "proposals.db"));
  });

  afterEach(() => {
    store.close();
    proposalStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates no proposal when the only threshold-crossing cluster is unclassified", async () => {
    seed(store, "unclassified", 5);

    const result = await runDistillation(store, proposalStore, ctx, { threshold: 3 });

    expect(result.proposalsCreated).toBe(0);
    expect(proposalStore.list()).toHaveLength(0);
  });

  it("still proposes for genuine categories, and ignores unclassified alongside them", async () => {
    seed(store, "missing-tests", 4);
    seed(store, "unclassified", 9); // the larger cluster — must not win

    const result = await runDistillation(store, proposalStore, ctx, { threshold: 3 });

    expect(result.proposalsCreated).toBe(1);
    const queued = proposalStore.list();
    expect(queued).toHaveLength(1);
    // The persisted proposal is for the genuine category and carries no trace of
    // the unclassified cluster in its rendered edit.
    expect(queued[0].proposal?.targets?.[0]?.path).toBe(guidanceRel);
    expect(JSON.stringify(queued[0].proposal)).not.toContain("unclassified");
  });

  it("reports uncategorized clusters as crossed, so they stay visible", async () => {
    seed(store, "unclassified", 5);

    // Silence is what caused AI-2036 in the first place: the cluster is real and
    // counted, it simply is not something to write a checklist about.
    const result = await runDistillation(store, proposalStore, ctx, { threshold: 3 });
    expect(result.patternsCrossed).toBe(1);
    expect(result.proposalsCreated).toBe(0);
  });
});
