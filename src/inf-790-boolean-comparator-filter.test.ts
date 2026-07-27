/**
 * INF-790 — AdhocDelegationReconciliation must use Linear's current
 * BooleanComparator shape for delegate.isMe.
 *
 * Linear now rejects bare booleans in filter fields typed as BooleanComparator:
 *   Expected value of type "BooleanComparator", found false.
 *
 * These tests cover only the query/filter contract. They must stay red until
 * src/delegation-reconciliation-sweep.ts sends:
 *   delegate: { isMe: { eq: false } }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, jest } from "@jest/globals";
import { AlertBus } from "./alerts/alert-bus.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { runDelegationReconciliationSweep } from "./delegation-reconciliation-sweep.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;

function emptyIssuesPage(): Response {
  return new Response(
    JSON.stringify({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function linearBooleanComparatorError(): Response {
  return new Response(
    JSON.stringify({
      data: null,
      errors: [
        {
          message: 'Expected value of type "BooleanComparator", found false.',
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function collapseGraphql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

describe("INF-790: delegation reconciliation ad-hoc query BooleanComparator filter", () => {
  it("uses delegate.isMe as a BooleanComparator and does not trip Linear's bare-boolean validation", async () => {
    let adhocQuery = "";
    const fetchFn = jest.fn<typeof fetch>(async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(body) as { query?: string };
      const query = parsed.query ?? "";

      if (query.includes("AdhocDelegationReconciliation")) {
        adhocQuery = query;
        if (/delegate\s*:\s*\{\s*isMe\s*:\s*false\s*\}/.test(query)) {
          return linearBooleanComparatorError();
        }
        return emptyIssuesPage();
      }

      if (query.includes("DelegationReconciliation")) {
        return emptyIssuesPage();
      }

      throw new Error(`unexpected Linear query in INF-790 test: ${collapseGraphql(query)}`);
    });

    const result = await runDelegationReconciliationSweep({
      authToken: "linear-token",
      fetchFn,
      operationalEventStore: new OperationalEventStore(":memory:"),
      alertBus: new AlertBus({ pushEnabled: false }),
      wakeFn: async () => undefined,
    });

    expect(result.errors).toEqual([]);
    expect(adhocQuery).toContain("AdhocDelegationReconciliation");
    expect(collapseGraphql(adhocQuery)).toMatch(
      /filter:\s*\{\s*delegate:\s*\{\s*isMe:\s*\{\s*eq:\s*false\s*\}\s*\}\s*\}/,
    );
    expect(adhocQuery).not.toMatch(/delegate\s*:\s*\{\s*isMe\s*:\s*false\s*\}/);
  });
});

describe("INF-790: non-test source contains no bare boolean isMe filters", () => {
  it("rejects bare boolean isMe filters in src non-test files", () => {
    const offenders: string[] = [];

    function scan(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }

        const source = fs.readFileSync(fullPath, "utf8");
        const lines = source.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (/\bisMe\s*:\s*(?:true|false)\b/.test(line)) {
            offenders.push(`${path.relative(SRC_DIR, fullPath)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }

    scan(SRC_DIR);

    expect(offenders).toEqual([]);
  });
});
