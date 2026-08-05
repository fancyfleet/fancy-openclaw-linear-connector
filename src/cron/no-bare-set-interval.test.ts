/**
 * INF-1263 AC3: no cron driver may rely on a bare setInterval.
 *
 * Contract for implementers: every non-test TypeScript file under src/ that
 * arms a cron/background driver with setInterval(...) must also queue a
 * startup kick with setTimeout(..., 0) before the interval is armed. This
 * keeps deploy churn from starving jobs whose interval never reaches its first
 * tick before the next restart.
 *
 * The heuristic is intentionally mechanical: for each setInterval occurrence,
 * this test requires a literal "setTimeout(" earlier in the same file. If a
 * setInterval is truly not a cron/background driver, add a narrow allowlist
 * entry here with the ticket-backed reason.
 */
import { describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(process.cwd(), "src");

const NON_CRON_INTERVAL_FILES = new Set<string>([
  // Express/SSE connection heartbeat, not a cron/background driver.
  "admin-stream.ts",
  // INF-1263: pure in-memory, per-process session tracker — all state resets
  // on restart, so there is no cross-restart staleness for a startup kick to
  // recover, and an immediate kick actively races the short-timeout unit
  // tests that manually drive cleanupStale() (bag/session-tracker.test.ts).
  "bag/session-tracker.ts",
  // INF-1263: every cycle unconditionally calls loadWorkflowDef(), which
  // reads a process-wide, test-mutated cache (workflow-gate.ts's
  // _registryCache, invalidated via resetWorkflowCache()). createApp() wires
  // this detector for real (non-fake) timers in hundreds of test files; an
  // immediate kick races the many tests that assume no concurrent access to
  // that cache while manipulating WORKFLOW_DEF_PATH — confirmed concretely
  // via proxy.test.ts's "malformed workflow def YAML" test, which passes in
  // isolation but fails when the kick is live and other describe blocks in
  // the same file don't stop this detector between tests. The detector's own
  // interval already provides restart-churn coverage at a low-risk cadence;
  // the credential sweeps (AC4) are the ticket's actual dark-cron target.
  "bag/stuck-delegate-detector.ts",
]);

function tsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...tsFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("INF-1263 AC3: no bare setInterval cron drivers", () => {
  test("every cron/background-driver interval has a startup kick before it", () => {
    const offenders: string[] = [];

    for (const file of tsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (NON_CRON_INTERVAL_FILES.has(rel)) continue;

      const source = fs.readFileSync(file, "utf8");
      let searchFrom = 0;
      while (true) {
        const intervalIndex = source.indexOf("setInterval(", searchFrom);
        if (intervalIndex === -1) break;

        const hasEarlierStartupKick = source.lastIndexOf("setTimeout(", intervalIndex) !== -1;
        if (!hasEarlierStartupKick) {
          offenders.push(rel);
          break;
        }
        searchFrom = intervalIndex + "setInterval(".length;
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});
