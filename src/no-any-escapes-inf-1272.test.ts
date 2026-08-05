/**
 * INF-1272: `as any` escape removal.
 *
 * AC mapping:
 *   AC1: OperationalEventStore's outcome union covers the stale-delegate outcome
 *        values used in stale-plain-delegate-sweep.ts; the 3 `as any` casts there
 *        are removed.
 *   AC2: DispatchWatchdog exposes a public config accessor so index.ts can read
 *        exponentialBackoffMs/maxResignals without casting; the 2 `as any` casts
 *        at index.ts:757-758 are removed.
 *   AC3: `grep -rn 'as any' src/**\/*.ts` (excluding tests) returns zero matches
 *        for these 5 sites.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";

const STALE_SWEEP_PATH = path.resolve(process.cwd(), "src", "stale-plain-delegate-sweep.ts");
const INDEX_PATH = path.resolve(process.cwd(), "src", "index.ts");

const SITES: Array<{ file: string; label: string; needle: string }> = [
  {
    file: STALE_SWEEP_PATH,
    label: "stale-plain-delegate-sweep.ts: stale-delegate-escalated outcome cast",
    needle: `outcome: "stale-delegate-escalated" as any`,
  },
  {
    file: STALE_SWEEP_PATH,
    label: "stale-plain-delegate-sweep.ts: stale-plain-delegate-redispatch outcome cast",
    needle: `outcome: "stale-plain-delegate-redispatch" as any`,
  },
  {
    file: STALE_SWEEP_PATH,
    label: "stale-plain-delegate-sweep.ts: stale-plain-delegate-redispatch-failed outcome cast",
    needle: `outcome: "stale-plain-delegate-redispatch-failed" as any`,
  },
  {
    file: INDEX_PATH,
    label: "index.ts:757 — (watchdog as any).config?.exponentialBackoffMs",
    needle: `(watchdog as any).config?.exponentialBackoffMs`,
  },
  {
    file: INDEX_PATH,
    label: "index.ts:758 — (watchdog as any).config?.maxResignals",
    needle: `(watchdog as any).config?.maxResignals`,
  },
];

describe("INF-1272: no `as any` escapes at the 5 known sites", () => {
  for (const { file, label, needle } of SITES) {
    it(`removes the cast at ${label}`, () => {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toContain(needle);
    });
  }
});
