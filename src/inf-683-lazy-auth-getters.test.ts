/**
 * INF-683 — Convert captured-once auth tokens to lazy per-use getters.
 *
 * Root cause (Grover, INF-682): `reconciliationAuthToken`, `migrationAuthToken`
 * and `labelSyncAuthToken` were each `getAccessToken("ai") ?? …` evaluated ONCE
 * at boot and closed over by their sweeps. The token refresher rotates Ai's
 * OAuth token ~5s after boot and every ~20h, invalidating the captured copy →
 * 401 "Authentication required, not authenticated" on every reconciliation read
 * from that instant. Fleet-wide delegation reconciliation went blind.
 *
 * The fix converts each const to a `resolve…() => …` getter resolved at each
 * use-site, and widens the consumer sweep options to accept `string | (() =>
 * string)`, resolving PER PASS — matching the already-correct sibling pattern
 * (resolveCronAuthToken / resolveValidationAuthToken) that never 401'd.
 *
 * Test 1 is the behavioral proof on the headline path (delegation
 * reconciliation): a getter whose value ROTATES between passes must be
 * re-resolved each pass, so the second sweep authenticates with the rotated
 * token — not a value frozen at the first call. Tests 2–4 are source-wiring
 * regression guards over the full change surface (index.ts getters + the six
 * consumer option types).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "@jest/globals";
import { runDelegationReconciliationSweep } from "./delegation-reconciliation-sweep.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

/** A fetch mock that records every Authorization header and returns an empty,
 *  well-formed governed-tickets page so the sweep completes with scanned:0. */
function recordingFetch(captured: Array<string | undefined>): typeof fetch {
  return (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push(init?.headers?.Authorization);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
    };
  }) as unknown as typeof fetch;
}

describe("INF-683: lazy auth-token getters are re-resolved per sweep pass", () => {
  it("delegation reconciliation authenticates with the ROTATED token on the second pass", async () => {
    // Simulate the post-boot / 20h token rotation: the getter returns the boot
    // token first, then the rotated token after `rotate()`.
    const BOOT = "Bearer TOKEN_BOOT";
    const ROTATED = "Bearer TOKEN_ROTATED";
    let current = BOOT;
    const resolveAuthToken = () => current;

    const captured: Array<string | undefined> = [];
    const fetchFn = recordingFetch(captured);
    const store = new OperationalEventStore(":memory:");
    const baseOpts = {
      authToken: resolveAuthToken,
      operationalEventStore: store,
      alertBus: { notify: () => {} } as never,
      wakeFn: async () => {},
      fetchFn,
    };

    // Pass 1 — boot token in effect.
    await runDelegationReconciliationSweep({ ...baseOpts });
    const afterPass1 = [...captured];

    // Token refresher rotates Ai's OAuth token; the old copy is now dead.
    current = ROTATED;

    // Pass 2 — a captured-once token would still send BOOT here (the bug).
    await runDelegationReconciliationSweep({ ...baseOpts });
    const pass2Headers = captured.slice(afterPass1.length);

    // The sweep fired at least one authenticated request per pass.
    expect(afterPass1.length).toBeGreaterThan(0);
    expect(pass2Headers.length).toBeGreaterThan(0);

    // Every header is a resolved string (never the getter function itself).
    for (const h of captured) {
      expect(typeof h).toBe("string");
      expect(h).toMatch(/^Bearer TOKEN_/);
    }

    // Pass 1 used ONLY the boot token; pass 2 used ONLY the rotated token.
    expect(new Set(afterPass1)).toEqual(new Set([BOOT]));
    expect(new Set(pass2Headers)).toEqual(new Set([ROTATED]));
  });
});

describe("INF-683: index.ts wires per-use getters, not captured consts", () => {
  const INDEX_TS = read("index.ts");

  it("defines the three lazy getters", () => {
    expect(INDEX_TS).toContain("const resolveMigrationAuthToken = () =>");
    expect(INDEX_TS).toContain("const resolveReconciliationAuthToken = () =>");
    expect(INDEX_TS).toContain("const resolveLabelSyncAuthToken = () =>");
  });

  it("passes the getter (function reference) to every registration call", () => {
    expect(INDEX_TS).toContain("authToken: resolveMigrationAuthToken,");
    expect(INDEX_TS).toContain("authToken: resolveReconciliationAuthToken,");
    expect(INDEX_TS).toContain("authToken: resolveLabelSyncAuthToken,");
  });

  it("resolves the token freshly inside inline callbacks (message build + crosscheck fetch)", () => {
    expect(INDEX_TS).toContain("resolveMigrationAuthToken(), actionText");
    expect(INDEX_TS).toContain("resolveReconciliationAuthToken(), actionText");
    expect(INDEX_TS).toContain("Authorization: resolveReconciliationAuthToken()");
  });

  it("no longer captures the tokens in boot-time consts", () => {
    // The old captured-once forms — their presence would reintroduce the bug.
    expect(INDEX_TS).not.toContain("const reconciliationAuthToken =");
    expect(INDEX_TS).not.toContain("const migrationAuthToken =");
    // labelSync keeps a resolved local, but ONLY as a boot gate — never passed on.
    expect(INDEX_TS).not.toContain("authToken: labelSyncAuthToken");
  });
});

describe("INF-683: consumer sweep options accept a lazy getter and resolve per pass", () => {
  const consumers: Array<{ file: string; label: string }> = [
    { file: "def-state-migration.ts", label: "migration runner" },
    { file: "bootstrap-reconciliation-sweep.ts", label: "bootstrap reconciliation" },
    { file: "delegation-reconciliation-sweep.ts", label: "delegation reconciliation" },
    { file: "stale-plain-delegate-sweep.ts", label: "stale-plain delegate" },
    { file: "first-action-watchdog.ts", label: "first-action watchdog" },
    { file: "cron/label-sync-audit.ts", label: "label-sync audit" },
  ];

  it.each(consumers)("$label option type accepts string | (() => string)", ({ file }) => {
    const src = read(file);
    expect(src).toMatch(/authToken\??: string \| \(\(\) => string\)/);
  });

  const perPassResolvers: string[] = [
    "def-state-migration.ts",
    "bootstrap-reconciliation-sweep.ts",
    "delegation-reconciliation-sweep.ts",
    "stale-plain-delegate-sweep.ts",
    "cron/label-sync-audit.ts",
  ];

  it.each(perPassResolvers)("%s resolves the token at pass time", (file) => {
    const src = read(file);
    // Either the local resolveAuthToken() helper or the inline typeof guard.
    const resolvesPerPass =
      /resolveAuthToken\((?:options|opts)\.authToken\)/.test(src) ||
      /typeof (?:options|opts)\.authToken === "function" \? (?:options|opts)\.authToken\(\)/.test(src);
    expect(resolvesPerPass).toBe(true);
  });
});
