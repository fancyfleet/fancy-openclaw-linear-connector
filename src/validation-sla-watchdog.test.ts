/**
 * INF-1286 — Unit tests for the validation SLA watchdog (INF-105): SLA breach
 * detection and the resulting state/delegate mutation (nudge comment + wake).
 *
 * The Linear API boundary is mocked via an injected `fetchFn` (matching the
 * pattern in validation-sla-watchdog-wiring.test.ts) — no live network calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { runValidationWatchdog, type ValidationWatchdogOptions } from "./validation-sla-watchdog.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const VALIDATOR_ID = "validator-1";

interface MockNode {
  id: string;
  identifier: string;
  state: string;
  delegateId: string | null;
  historyCreatedAt: string;
}

function node(overrides: Partial<MockNode> = {}): MockNode {
  return {
    id: "issue-1",
    identifier: "INF-1",
    state: "ac-validate",
    delegateId: VALIDATOR_ID,
    historyCreatedAt: new Date(T0 - 20 * MINUTE).toISOString(),
    ...overrides,
  };
}

/** Builds an injectable fetchFn honoring the GraphQL query shapes the watchdog issues. */
function makeFetch(nodes: MockNode[]) {
  const commentsPosted: Array<{ issueId: string; body: string }> = [];
  let commentShouldSucceed = true;

  const fetchFn = jest.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(body) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";

    if (query.includes("ValidationWatchdogGoverned")) {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: nodes.map((n) => ({
                id: n.id,
                identifier: n.identifier,
                labels: { nodes: [{ name: "wf:dev-impl" }, { name: `state:${n.state}` }] },
                delegate: n.delegateId ? { id: n.delegateId, name: n.delegateId } : null,
                history: { nodes: [{ createdAt: n.historyCreatedAt }] },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("CreateValidationNudge")) {
      commentsPosted.push({
        issueId: (parsed.variables?.issueId as string) ?? "",
        body: (parsed.variables?.body as string) ?? "",
      });
      return new Response(
        JSON.stringify({
          data: { commentCreate: { success: commentShouldSucceed, comment: commentShouldSucceed ? { id: "c1" } : null } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });

  return {
    fetchFn,
    commentsPosted,
    setCommentSuccess: (v: boolean) => { commentShouldSucceed = v; },
  };
}

function makeOpts(
  mock: ReturnType<typeof makeFetch>,
  overrides: Partial<ValidationWatchdogOptions> = {},
) {
  const wakeValidator = jest.fn(async (_id: string) => undefined);
  const opts: ValidationWatchdogOptions = {
    authToken: "Bearer test",
    validatorLinearUserId: VALIDATOR_ID,
    fetchFn: mock.fetchFn as unknown as ValidationWatchdogOptions["fetchFn"],
    wakeValidator,
    now: () => T0,
    thresholdMs: 15 * MINUTE,
    cooldownMs: 10 * MINUTE,
    nudgeStorePath: ":memory:",
    ...overrides,
  };
  return { opts, wakeValidator };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validation-watchdog-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// SLA breach detection
// ════════════════════════════════════════════════════════════════════════════

describe("SLA breach detection", () => {
  it("detects a candidate in a watched state, delegated to the validator, past threshold", async () => {
    const mock = makeFetch([node()]);
    const { opts } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.scanned).toBe(1);
    expect(result.candidatesFound).toBe(1);
    expect(result.staleDetected).toBe(1);
  });

  it("does not flag a ticket still within the threshold", async () => {
    const mock = makeFetch([node({ historyCreatedAt: new Date(T0 - 5 * MINUTE).toISOString() })]);
    const { opts } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.candidatesFound).toBe(1);
    expect(result.staleDetected).toBe(0);
    expect(result.nudgesPosted).toBe(0);
  });

  it("ignores a ticket in an unwatched state", async () => {
    const mock = makeFetch([node({ state: "code-review" })]);
    const { opts } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.candidatesFound).toBe(0);
    expect(result.staleDetected).toBe(0);
  });

  it("ignores a ticket in a watched state delegated to someone other than the validator", async () => {
    const mock = makeFetch([node({ delegateId: "someone-else" })]);
    const { opts } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.candidatesFound).toBe(0);
  });

  it("ignores a ticket delegated to no one", async () => {
    const mock = makeFetch([node({ delegateId: null })]);
    const { opts } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.candidatesFound).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Resulting mutation — nudge comment + validator wake
// ════════════════════════════════════════════════════════════════════════════

describe("resulting mutation on breach", () => {
  it("posts a nudge comment on the breaching ticket and wakes the validator", async () => {
    const mock = makeFetch([node()]);
    const { opts, wakeValidator } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.nudgesPosted).toBe(1);
    expect(result.wakesDispatched).toBe(1);
    expect(mock.commentsPosted).toHaveLength(1);
    expect(mock.commentsPosted[0].issueId).toBe("issue-1");
    expect(mock.commentsPosted[0].body).toMatch(/INF-1/);
    expect(wakeValidator).toHaveBeenCalledWith("INF-1");
  });

  it("does not wake the validator when posting the nudge comment fails", async () => {
    const mock = makeFetch([node()]);
    mock.setCommentSuccess(false);
    const { opts, wakeValidator } = makeOpts(mock);

    const result = await runValidationWatchdog(opts);

    expect(result.nudgesPosted).toBe(0);
    expect(result.wakesDispatched).toBe(0);
    expect(wakeValidator).not.toHaveBeenCalled();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("still counts the nudge as posted when the validator wake itself throws", async () => {
    const mock = makeFetch([node()]);
    const wakeValidator = jest.fn(async () => { throw new Error("wake failed"); });
    const { opts } = makeOpts(mock, { wakeValidator });

    const result = await runValidationWatchdog(opts);

    expect(result.nudgesPosted).toBe(1);
    expect(result.wakesDispatched).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Idempotent cooldown — nudge dedup across sweeps
// ════════════════════════════════════════════════════════════════════════════

describe("idempotent cooldown", () => {
  it("does not re-nudge the same (ticket, state-entry) within the cooldown window", async () => {
    const dbPath = path.join(tmpDir, "nudges.db");
    const n = node();

    const first = makeFetch([n]);
    const { opts: opts1 } = makeOpts(first, { nudgeStorePath: dbPath, now: () => T0 });
    const r1 = await runValidationWatchdog(opts1);
    expect(r1.nudgesPosted).toBe(1);

    // Second sweep, shortly after — still within the 10m cooldown.
    const second = makeFetch([n]);
    const { opts: opts2 } = makeOpts(second, { nudgeStorePath: dbPath, now: () => T0 + 2 * MINUTE });
    const r2 = await runValidationWatchdog(opts2);

    expect(r2.staleDetected).toBe(1); // still stale...
    expect(r2.nudgesPosted).toBe(0); // ...but cooldown suppresses the re-nudge
    expect(second.commentsPosted).toHaveLength(0);
  });

  it("re-nudges once the cooldown has elapsed", async () => {
    const dbPath = path.join(tmpDir, "nudges.db");
    const n = node();

    const first = makeFetch([n]);
    const { opts: opts1 } = makeOpts(first, { nudgeStorePath: dbPath, now: () => T0 });
    await runValidationWatchdog(opts1);

    const later = makeFetch([n]);
    const { opts: opts2 } = makeOpts(later, { nudgeStorePath: dbPath, now: () => T0 + 20 * MINUTE });
    const r2 = await runValidationWatchdog(opts2);

    expect(r2.nudgesPosted).toBe(1);
    expect(later.commentsPosted).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Error paths
// ════════════════════════════════════════════════════════════════════════════

describe("error handling", () => {
  it("records a GraphQL error from the governed-tickets query without throwing", async () => {
    const fetchFn = jest.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const wakeValidator = jest.fn(async () => undefined);
    const opts: ValidationWatchdogOptions = {
      authToken: "Bearer test",
      validatorLinearUserId: VALIDATOR_ID,
      fetchFn: fetchFn as unknown as ValidationWatchdogOptions["fetchFn"],
      wakeValidator,
      nudgeStorePath: ":memory:",
    };

    const result = await runValidationWatchdog(opts);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.nudgesPosted).toBe(0);
  });
});
