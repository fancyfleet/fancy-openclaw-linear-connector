import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

const sweepAuthSources = [
  {
    label: "production entrypoint sweeps",
    file: "index.ts",
    expectedResolverCalls: 3,
    preservedLogic: [
      "registerDefStateMigrationRunner",
      "registerBootstrapReconciliationCron",
      "registerDelegationReconciliationCron",
      "registerFirstActionWatchdogCron",
      "runDelegationReconciliationSweep",
      "registerSlaSweepCron",
    ],
  },
  {
    label: "webhook reconciliation hooks",
    file: "webhook/index.ts",
    expectedResolverCalls: 3,
    preservedLogic: [
      "onChildTerminal",
      "enrollIfMissing",
      "maybeBootstrapWorkflow",
    ],
  },
  {
    label: "rescue sweep cron",
    file: "cron/rescue-sweep-cron.ts",
    expectedResolverCalls: 1,
    preservedLogic: [
      "loadWorkflowRegistry",
      "runRescueSweep",
      "recordRescueSweepRun",
      "recordRescueSweepSkip",
      "recordRescueSweepFail",
    ],
  },
];

describe("INF-1212 static auth migration gate", () => {
  it.each(sweepAuthSources)("$label has no getAccessToken(\"ai\") sweep auth dependency", ({ file }) => {
    const source = readSource(file);

    expect(count(source, /getAccessToken\("ai"\)/g)).toBe(0);
  });

  it.each(sweepAuthSources)("$label resolves sweep auth through resolveServiceCredential", ({ file, expectedResolverCalls }) => {
    const source = readSource(file);

    expect(count(source, /\bresolveServiceCredential\s*\(/g)).toBeGreaterThanOrEqual(expectedResolverCalls);
  });

  it.each(sweepAuthSources)("$label keeps the existing reconciliation logic and only substitutes auth", ({ file, preservedLogic }) => {
    const source = readSource(file);

    expect(count(source, /\bresolveServiceCredential\s*\(/g)).toBeGreaterThan(0);
    for (const symbol of preservedLogic) {
      expect(source).toContain(symbol);
    }
  });

  it("wires /health to the dedicated credential liveness provider from index.ts", () => {
    const source = readSource("index.ts");

    expect(count(source, /\bgetDedicatedCredentialLiveness\b/g)).toBeGreaterThan(0);
    expect(source).toMatch(/serviceCredential:\s*getDedicatedCredentialLiveness\(\)/);
  });
});
