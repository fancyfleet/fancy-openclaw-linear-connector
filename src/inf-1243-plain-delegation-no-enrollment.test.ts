/**
 * INF-1243 — Plain ad-hoc delegation must not auto-enroll a workflow.
 *
 * INF-334 introduced `autoEnrollPlainDelegation()`, called from two sites
 * (webhook Issue-event handler, delegation-reconciliation-sweep) to stamp
 * wf:task/state:doing on any plain-delegated (no wf:*) ticket. That is now a
 * regression: workflows are opt-in only, and plain/ad-hoc delegation must
 * dispatch without ever gaining wf:* / state:* labels.
 *
 * The primary, most-robust coverage for this invariant is behavioral and
 * lives alongside the existing conventions for each call site:
 *   - src/webhook/plain-delegation-dispatch.test.ts (webhook call site —
 *     inverted the former INF-334 "AC1/AC5" test)
 *   - src/delegation-reconciliation-sweep.test.ts (sweep call site —
 *     inverted three former INF-334/INF-589 tests)
 *
 * This file adds the AC6 "grep proof" as an actual automated test: a
 * source-inspection backstop asserting neither call site still *invokes*
 * autoEnrollPlainDelegation (as opposed to merely importing it). This is
 * intentionally a secondary/defense-in-depth check — the behavioral tests
 * above are what actually prove the invariant and survive refactors; this
 * one just catches "the call site still literally calls the function."
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Matches an actual invocation — `autoEnrollPlainDelegation(` — not the
 * named import (`autoEnrollPlainDelegation,` / `autoEnrollPlainDelegation }`
 * with no following paren).
 */
const CALL_PATTERN = /autoEnrollPlainDelegation\s*\(/g;

function countCallsExcludingImportLines(source: string): number {
  return source
    .split("\n")
    .filter((line) => !line.includes("import"))
    .reduce((count, line) => count + (line.match(CALL_PATTERN)?.length ?? 0), 0);
}

describe("INF-1243 AC6: no code path auto-applies a workflow on plain delegation", () => {
  it("webhook/index.ts Issue-event handler no longer calls autoEnrollPlainDelegation", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src/webhook/index.ts"), "utf8");
    expect(countCallsExcludingImportLines(source)).toBe(0);
  });

  it("delegation-reconciliation-sweep.ts no longer calls autoEnrollPlainDelegation", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src/delegation-reconciliation-sweep.ts"), "utf8");
    expect(countCallsExcludingImportLines(source)).toBe(0);
  });
});
