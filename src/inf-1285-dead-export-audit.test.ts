/**
 * INF-1285: Remove dead exports from workflow-gate.ts
 *
 * This is a behavior-preserving deletion refactor, not feature work (see
 * ticket + intake comment). There is no new behavior to red-test, so these
 * are dead-export guards: each assertion is red today (the export/violation
 * is present) and goes green once the implementer's deletion lands.
 *
 * AC1 requires re-confirming zero non-test importers "at implementation
 * time — the codebase may have moved since the audit." That re-check was
 * performed for this test-authoring pass (2026-08-05) against the ticket's
 * 18 named exports + candidates for the remaining 4. Three of the ticket's
 * 18 named exports are NO LONGER dead — the codebase moved since the
 * original audit, exactly as AC1 warned could happen:
 *   - deriveWorkflowInstanceScope: imported by src/routing-guard.ts
 *   - describeMissingInstanceScope: imported by src/routing-guard.ts
 *   - resolveStakesLevel: imported by src/delivery/build-message.ts
 * Deleting any of these three would be a behavior change and would break
 * the full suite (AC5). They are NOT in the FULLY_DEAD or
 * JUDGMENT_CALL lists below and must be left alone. See the "does not
 * regress" describe block for guard tests protecting against wrongfully
 * deleting them.
 *
 * Everything else in the ticket's 18-name list, plus newly-identified
 * candidates re-derived from the "remaining 4" the ticket asked the
 * implementer to find, sort into two buckets:
 *
 *   FULLY_DEAD — zero references anywhere, including tests and
 *   conformance-matrix.ts. AC3: delete outright.
 *
 *   JUDGMENT_CALL — referenced only by test files and/or
 *   conformance-matrix.ts. AC2: implementer's call per case — either keep
 *   with an `@internal` doc comment explaining why it's exported, or inline
 *   the test usage and remove the export. Either resolution satisfies the
 *   guard test below.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_PATH = path.resolve(__dirname, "workflow-gate.ts");

function readGateSource(): string {
  return fs.readFileSync(GATE_PATH, "utf8");
}

// Baseline captured 2026-08-05 against origin/main (66390dfa) at test-authoring
// time. `grep -c 'export' src/workflow-gate.ts` — AC4.
const BASELINE_EXPORT_LINE_COUNT = 80;
const MIN_GUARANTEED_DELETIONS = 8; // FULLY_DEAD.length — JUDGMENT_CALL outcomes vary per case.

const FULLY_DEAD = [
  "_resetNoActivityTimeoutCache",
  "hasCapabilityStatementEvidence",
  "hasPassedDemonstrationWalkEvidence",
  "isTerminalStateId",
  "buildStateRank",
  "classifyRoutineTransition",
  "analyzeStateRoutine",
  "legalMovesFor",
];

const JUDGMENT_CALL = [
  "_setLogForTests",
  "resetWorkflowRegistry",
  "validateNativeStateMappings",
  "validateGateAnchorDefs",
  "validateTransitionTargets",
  "validateFanoutBarrierConfig",
  "resetNativeStateCache",
  "resolveSingletonDelegate",
  "resolveRoutineEdge",
  "_postCommentForTests",
  "_issueUpdateAtomicForTests",
  "_setTransitionWritePolicyForTests",
  "cliVerbFor",
];

// Ticket's audit named these as dead; re-verification at test-authoring time
// (grep across src/**/*.ts) found real non-test importers for each. Must
// NOT be deleted — see file header.
const WRONGLY_FLAGGED_STILL_ALIVE = [
  "deriveWorkflowInstanceScope",
  "describeMissingInstanceScope",
  "resolveStakesLevel",
];

function findExportLineIndex(lines: string[], name: string): number {
  const re = new RegExp(
    `^export\\s+(async\\s+function|function|const|class)\\s+${name}\\b`,
  );
  return lines.findIndex((line) => re.test(line));
}

describe("INF-1285: dead-export removal from workflow-gate.ts", () => {
  describe("AC3 — fully-dead exports (zero references anywhere) are deleted", () => {
    for (const name of FULLY_DEAD) {
      it(`removes \`${name}\` from the export surface (currently exported with zero non-test, zero-test references)`, () => {
        const source = readGateSource();
        const lines = source.split("\n");
        const idx = findExportLineIndex(lines, name);
        expect(idx).toBe(-1);
      });
    }
  });

  describe("AC2 — test-only / conformance-matrix-only exports are resolved per implementer judgment", () => {
    for (const name of JUDGMENT_CALL) {
      it(`\`${name}\` is either removed from the export surface, or kept with an @internal doc comment explaining why`, () => {
        const source = readGateSource();
        const lines = source.split("\n");
        const idx = findExportLineIndex(lines, name);

        if (idx === -1) {
          // Inlined into its (test) callers and the export removed — AC2 path B.
          expect(idx).toBe(-1);
          return;
        }

        // Kept — AC2 path A requires an @internal doc comment directly above
        // the export explaining why it's still exported.
        const precedingWindow = lines.slice(Math.max(0, idx - 15), idx).join("\n");
        expect(precedingWindow).toMatch(/@internal/);
      });
    }
  });

  describe("AC4 — export surface shrinks by roughly the number of exports removed", () => {
    it("export line count drops by at least the number of fully-dead exports", () => {
      const source = readGateSource();
      const currentCount = (source.match(/^export /gm) ?? []).length;
      expect(currentCount).toBeLessThanOrEqual(
        BASELINE_EXPORT_LINE_COUNT - MIN_GUARANTEED_DELETIONS,
      );
    });
  });

  describe("AC1 — re-verification catches exports the original audit got wrong; these must not regress", () => {
    for (const name of WRONGLY_FLAGGED_STILL_ALIVE) {
      it(`\`${name}\` remains exported — it has real non-test importers despite being named in the ticket's stale audit`, () => {
        const source = readGateSource();
        const lines = source.split("\n");
        const idx = findExportLineIndex(lines, name);
        expect(idx).not.toBe(-1);
      });
    }

    it("routing-guard.ts still imports deriveWorkflowInstanceScope and describeMissingInstanceScope", () => {
      const routingGuardSource = fs.readFileSync(
        path.resolve(__dirname, "routing-guard.ts"),
        "utf8",
      );
      expect(routingGuardSource).toMatch(/\bderiveWorkflowInstanceScope\b/);
      expect(routingGuardSource).toMatch(/\bdescribeMissingInstanceScope\b/);
    });

    it("delivery/build-message.ts still imports resolveStakesLevel", () => {
      const buildMessageSource = fs.readFileSync(
        path.resolve(__dirname, "delivery", "build-message.ts"),
        "utf8",
      );
      expect(buildMessageSource).toMatch(/\bresolveStakesLevel\b/);
    });
  });
});
