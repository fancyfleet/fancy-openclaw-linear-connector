/**
 * INF-1196 AC5 — registered workflow-def drift regression lock.
 *
 * AC5 is already satisfied on main as of INF-1164 (commit d6d49a24); this test
 * locks it in as a regression guard for INF-1196.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";
import {
  checkWorkflowDefSync,
  fixturePathFor,
  KNOWN_DRIFT,
  registeredDefIds,
  registeredDefPathFor,
  structurallyEqual,
} from "../scripts/check-workflow-def-sync.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const INF1196_DRIFT_LOCK_IDS = ["dept-engine", "dev-sprint", "dev-impl"];

describe("INF-1196 AC5 workflow-def sync regression lock", () => {
  it("keeps dept-engine, dev-sprint, and dev-impl registered-defs in sync with canonical fixtures", () => {
    const registeredIds = registeredDefIds(REPO_ROOT);
    const sync = checkWorkflowDefSync(REPO_ROOT);

    expect(registeredIds).toEqual(expect.arrayContaining(INF1196_DRIFT_LOCK_IDS));
    expect(sync.ok).toBe(true);

    for (const id of INF1196_DRIFT_LOCK_IDS) {
      expect(KNOWN_DRIFT.has(id)).toBe(false);
      expect(sync.violations.filter((violation: string) => violation.includes(id))).toEqual([]);
      expect(
        structurallyEqual(
          fs.readFileSync(registeredDefPathFor(REPO_ROOT, id), "utf8"),
          fs.readFileSync(fixturePathFor(REPO_ROOT, id), "utf8"),
        ),
      ).toBe(true);
    }
  });
});
