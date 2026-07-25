import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { evaluateBarrier } from "./barrier.js";
import { deriveFanoutBarrierOutcome } from "./workflow-gate.js";
import type { FanoutResult } from "./fanout.js";

function baseFanoutResult(overrides: Partial<FanoutResult>): FanoutResult {
  return {
    created: 0,
    childIdentifiers: [],
    errors: [],
    preview: null,
    refused: false,
    pendingApproval: false,
    unmatchedChildren: [],
    attempted: 0,
    specEntryCount: 0,
    specMatchedChildren: [],
    specMatchedTerminalChildren: [],
    ...overrides,
  };
}

describe("INF-620: dedup-zero fanout cannot satisfy barriers with stale terminal children", () => {
  it("records the LIF-45 dedup-zero shape as failed, not waived or awaiting", () => {
    const outcome = deriveFanoutBarrierOutcome(baseFanoutResult({
      specEntryCount: 1,
      attempted: 0,
      created: 0,
      specMatchedChildren: ["LIF-129"],
      specMatchedTerminalChildren: ["LIF-129"],
    }));

    expect(outcome).toEqual({ outcome: "failed" });
  });

  it("preserves same-cycle unchanged spec re-entry with live matched children as awaiting", () => {
    const outcome = deriveFanoutBarrierOutcome(baseFanoutResult({
      specEntryCount: 1,
      attempted: 0,
      created: 0,
      specMatchedChildren: ["LIF-217"],
      specMatchedTerminalChildren: [],
    }));

    expect(outcome).toEqual({ outcome: "awaiting", childIdentifiers: ["LIF-217"] });
  });

  it("preserves legitimate no-op outcomes", () => {
    expect(deriveFanoutBarrierOutcome(baseFanoutResult({
      specEntryCount: 0,
      attempted: 0,
      created: 0,
    }))).toEqual({ outcome: "waived" });

    expect(deriveFanoutBarrierOutcome(baseFanoutResult({
      specEntryCount: 1,
      spawnIfResult: {
        outcome: "waived",
        shouldSpawn: false,
        reason: "no child matched spawn_if",
        matchedChildren: [],
      },
    }))).toEqual({ outcome: "waived" });
  });

  it("ignores prior-cycle terminal children outside the expected current fanout set", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({
        data: {
          issue: {
            children: {
              nodes: [
                { identifier: "LIF-129", labels: { nodes: [{ name: "wf:sprint-scoping" }, { name: "state:done" }] } },
              ],
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    try {
      const result = await evaluateBarrier("LIF-45", "Bearer tok", ["LIF-217"]);
      expect(result.allTerminal).toBe(false);
      expect(result.totalChildren).toBe(0);
      expect(result.terminalCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps unscoped zero-child barrier satisfaction intact", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ data: { issue: { children: { nodes: [] } } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    try {
      const result = await evaluateBarrier("LIF-45", "Bearer tok");
      expect(result.allTerminal).toBe(true);
      expect(result.totalChildren).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("audits registered fanout-to-barrier pairs through the same non-satisfying outcome contract", () => {
    const defsDir = path.resolve(process.cwd(), "src/registered-defs");
    const pairs: string[] = [];

    for (const file of fs.readdirSync(defsDir).filter((name) => name.endsWith(".yaml"))) {
      const def = yaml.load(fs.readFileSync(path.join(defsDir, file), "utf8")) as {
        id?: string;
        states?: Array<{
          id?: string;
          fanout?: unknown;
          barrier?: boolean;
          transitions?: Array<{ to?: string }>;
        }>;
      };
      const states = def.states ?? [];
      for (const state of states) {
        if (!state.fanout) continue;
        for (const transition of state.transitions ?? []) {
          const dest = states.find((candidate) => candidate.id === transition.to);
          if (dest?.barrier === true) pairs.push(`${def.id}:${state.id}->${dest.id}`);
        }
      }
    }

    expect(pairs).toEqual(expect.arrayContaining([
      "sprint-spawner:spawning-scope->scoping",
      "dev-sprint:spawn-impl->managing-impl",
    ]));
    expect(pairs.length).toBeGreaterThanOrEqual(2);

    for (const pair of pairs) {
      expect(deriveFanoutBarrierOutcome(baseFanoutResult({
        specEntryCount: 1,
        attempted: 0,
        created: 0,
        specMatchedChildren: [`${pair}:prior-child`],
        specMatchedTerminalChildren: [`${pair}:prior-child`],
      }))).toEqual({ outcome: "failed" });
    }
  });
});
