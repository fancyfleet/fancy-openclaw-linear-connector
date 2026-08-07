/**
 * INF-1300 — pilot/dev-impl-pilot.ts
 *
 * AC: pilot enrollment/exit decisions and state mutations.
 * Mocks: ObservationStore + ProposalStore via :memory:, no live Linear, mocked clock via now().
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../store/observation-store.js";
import { ProposalStore } from "../store/proposal-store.js";
import {
  seedSyntheticObservations,
  syntheticObservationIds,
  compareBeforeAfter,
  stageDevImplPilot,
  applyStagedProposal,
  runDevImplPilot,
  SignOffRequiredError,
} from "./dev-impl-pilot.js";

function freshStores(): { obs: ObservationStore; prop: ProposalStore } {
  return { obs: new ObservationStore(":memory:"), prop: new ProposalStore(":memory:") };
}

function generationContext(): Parameters<typeof stageDevImplPilot>[0]["generationContext"] {
  return {
    readSurfaces: (workflowId: string, stateId: string) => [
      {
        kind: "guidance",
        path: `workflows/${workflowId}/${stateId}.md`,
        content: `# ${stateId}\noriginal guidance\n`,
      },
    ],
  };
}

function humanSignOff(): { approver: string; kind: "human" } {
  return { approver: "Matt", kind: "human" };
}
function aiSignOff(): { approver: string; kind: "ai" } {
  return { approver: "bot", kind: "ai" };
}

describe("dev-impl-pilot", () => {
  let obs: ObservationStore;
  let prop: ProposalStore;

  beforeEach(() => {
    const s = freshStores();
    obs = s.obs;
    prop = s.prop;
  });

  afterEach(() => {
    obs.close();
    prop.close();
  });

  describe("seedSyntheticObservations + syntheticObservationIds (enrollment provenance)", () => {
    it("seeded rows are flagged synthetic and surface via syntheticObservationIds", () => {
      const ids = seedSyntheticObservations(obs, [
        { ticket: "INF-1", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" },
      ]);
      expect(ids).toHaveLength(1);
      expect(syntheticObservationIds(obs).has(ids[0]!)).toBe(true);
    });

    it("organic rows are not flagged synthetic", () => {
      seedSyntheticObservations(obs, [{ ticket: "INF-2", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "style" }]);
      obs.append({ ticket: "INF-3", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "style" });
      const syn = syntheticObservationIds(obs);
      const all = obs.query({ workflow: "dev-impl", step: "code-review" });
      const organic = all.find((r) => r.ticket === "INF-3")!;
      expect(syn.has(organic.id)).toBe(false);
    });
  });

  describe("compareBeforeAfter (baseline window / exit decision input)", () => {
    it("counts before/after relative to the baseline window for same-category only", () => {
      const until = new Date("2026-06-10T12:00:00.000Z").toISOString();
      const beforeIso = new Date("2026-06-05T12:00:00.000Z").toISOString();
      const afterIso = new Date("2026-06-15T12:00:00.000Z").toISOString();
      obs.append({ ticket: "INF-10", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests", timestamp: beforeIso });
      obs.append({ ticket: "INF-11", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests", timestamp: beforeIso });
      obs.append({ ticket: "INF-12", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests", timestamp: afterIso });
      // different reasonCode must not count
      obs.append({ ticket: "INF-13", workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "style", timestamp: beforeIso });

      const comp = compareBeforeAfter(obs, { snapshot: { workflow: "dev-impl", step: "code-review" }, window: { since: beforeIso, until } }, { workflow: "dev-impl", step: "code-review", reasonCode: "missing-tests" });
      expect(comp.before).toBe(2);
      expect(comp.after).toBe(1);
    });
  });

  describe("stageDevImplPilot — enrollment gating", () => {
    it("synthetic without realDataFollowupTicket throws (AC6.3)", async () => {
      await expect(
        stageDevImplPilot({ observationStore: obs, proposalStore: prop, generationContext: generationContext(), now: () => Date.now(), synthetic: true, realDataFollowupTicket: null }),
      ).rejects.toThrow(/synthetic.*follow-up/i);
    });

    it("synthetic with followupTicket proceeds (does not throw AC6.3)", async () => {
      // Need enough observations to cross threshold and generate a proposal
      for (let i = 0; i < 4; i++) {
        obs.append({ ticket: `INF-S${i}`, workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" });
      }
      const res = await stageDevImplPilot({
        observationStore: obs,
        proposalStore: prop,
        generationContext: generationContext(),
        now: () => Date.now(),
        synthetic: true,
        realDataFollowupTicket: "INF-999",
      });
      expect(res.status).toBe("staged");
      expect(res.synthetic).toBe(true);
      expect(res.realDataFollowupTicket).toBe("INF-999");
      expect(res.proposalId).toBeTruthy();
    });

    it("no threshold-crossing observations → throws (cannot stage without a proposal)", async () => {
      await expect(
        stageDevImplPilot({ observationStore: obs, proposalStore: prop, generationContext: generationContext(), now: () => Date.now() }),
      ).rejects.toThrow(/no proposal was generated/i);
    });

    it("sufficient observations produce a staged proposal id (state mutation: persisted in proposal store)", async () => {
      for (let i = 0; i < 4; i++) {
        obs.append({ ticket: `INF-P${i}`, workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" });
      }
      const res = await stageDevImplPilot({ observationStore: obs, proposalStore: prop, generationContext: generationContext(), now: () => Date.now() });
      expect(res.proposalId).toBeTruthy();
      expect(prop.getById(res.proposalId)).not.toBeNull();
    });
  });

  describe("applyStagedProposal — exit gating + state mutation (human sign-off, version bump + commit)", () => {
    it("without human sign-off throws SignOffRequiredError (no write)", async () => {
      for (let i = 0; i < 4; i++) obs.append({ ticket: `INF-A${i}`, workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" });
      const staged = await stageDevImplPilot({ observationStore: obs, proposalStore: prop, generationContext: generationContext(), now: () => Date.now() });
      const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-apply-"));
      try {
        await expect(
          applyStagedProposal({ proposalId: staged.proposalId, proposalStore: prop, observationStore: obs, configRoot, now: () => Date.now(), signOff: null }),
        ).rejects.toBeInstanceOf(SignOffRequiredError);
        await expect(
          applyStagedProposal({ proposalId: staged.proposalId, proposalStore: prop, observationStore: obs, configRoot, now: () => Date.now(), signOff: aiSignOff() }),
        ).rejects.toBeInstanceOf(SignOffRequiredError);
      } finally {
        fs.rmSync(configRoot, { recursive: true, force: true });
      }
    });

    it("missing staged id throws", async () => {
      const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-apply2-"));
      try {
        await expect(
          applyStagedProposal({ proposalId: "no-such-id", proposalStore: prop, observationStore: obs, configRoot, now: () => Date.now(), signOff: humanSignOff() }),
        ).rejects.toThrow(/not found/i);
      } finally {
        fs.rmSync(configRoot, { recursive: true, force: true });
      }
    });
  });

  describe("runDevImplPilot — composed pilot (enrollment → staged → applied)", () => {
    it("without human sign-off throws before staging (no state mutation)", async () => {
      for (let i = 0; i < 4; i++) obs.append({ ticket: `INF-R${i}`, workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" });
      const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-run-"));
      try {
        await expect(
          runDevImplPilot({ observationStore: obs, proposalStore: prop, generationContext: generationContext(), configRoot, now: () => Date.now(), signOff: null }),
        ).rejects.toBeInstanceOf(SignOffRequiredError);
      } finally {
        fs.rmSync(configRoot, { recursive: true, force: true });
      }
    });

    it("synthetic without followup ticket throws (AC6.3) via composed path", async () => {
      for (let i = 0; i < 4; i++) obs.append({ ticket: `INF-RS${i}`, workflow: "dev-impl", step: "code-review", fromBody: "a", reviewerBody: "b", reasonCode: "missing-tests" });
      const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-run-syn-"));
      try {
        await expect(
          runDevImplPilot({
            observationStore: obs,
            proposalStore: prop,
            generationContext: generationContext(),
            configRoot,
            now: () => Date.now(),
            signOff: humanSignOff(),
            synthetic: true,
            realDataFollowupTicket: null,
          }),
        ).rejects.toThrow(/synthetic/i);
      } finally {
        fs.rmSync(configRoot, { recursive: true, force: true });
      }
    });
  });
});
