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
