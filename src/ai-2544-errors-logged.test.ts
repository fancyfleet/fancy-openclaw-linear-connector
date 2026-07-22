/**
 * AI-2544: Regression coverage — atomic issueUpdate MUST log the GraphQL errors
 * array on non-success so failed transitions are diagnosable without tracing
 * raw HTTP responses.
 *
 * AC1: On non-success with errors present, the log receives the serialized errors payload.
 * AC2: On non-success without errors, the log includes "none".
 * AC3: On success, the log is NOT called (success path unchanged, Promise<boolean> contract preserved).
 * AC4: No Authorization header or token leaks into the log.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { Logger } from "./logger.js";
import {
  _setLogForTests,
  _setTransitionWritePolicyForTests,
  _issueUpdateAtomicForTests,
} from "./workflow-gate.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const ISSUE_ID = "internal-uuid-abc";
const LABEL_IDS = ["lbl-1", "lbl-2"];
const AUTH_TOKEN = "lin_bearer_secret_xyz789";

const SUCCESS_BODY = { data: { issueUpdate: { success: true } } };

const FAILURE_WITH_ERRORS = {
  data: { issueUpdate: { success: false } },
  errors: [
    { message: "Resource not found", extensions: { code: "NOT_FOUND" } },
    { message: "Insufficient permissions" },
  ],
};

const FAILURE_WITHOUT_ERRORS = {
  data: { issueUpdate: { success: false } },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** A spy logger that captures warn() messages into an array. */
function spyLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    info: jest.fn() as Logger["info"],
    error: jest.fn() as Logger["error"],
    debug: jest.fn() as Logger["debug"],
    warn: ((msg: string) => {
      warns.push(msg);
    }) as Logger["warn"],
    warns,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AI-2544 — issueUpdateAtomic errors logging", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    // Clamp retries to 1 so we don't loop past our single mocked response.
    _setTransitionWritePolicyForTests({ maxAttempts: 1, retryDelayMs: 1 });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    _setLogForTests();           // reset to real logger
    _setTransitionWritePolicyForTests(); // reset to defaults
  });

  // ── AC1: errors present in response → log receives serialized errors ──

  it("AC1: on non-success with errors present, the log receives the serialized errors payload", async () => {
    const spy = spyLogger();
    _setLogForTests(spy);

    // Linear returns success:false WITH a GraphQL errors array.
    globalThis.fetch = async () =>
      new Response(JSON.stringify(FAILURE_WITH_ERRORS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await _issueUpdateAtomicForTests(ISSUE_ID, LABEL_IDS, AUTH_TOKEN);

    expect(result).toBe(false); // non-success → false
    expect(spy.warns.length).toBe(1);
    // The warn entry MUST contain the serialized errors payload, not just the issue id.
    expect(spy.warns[0]).toContain("Resource not found");
    expect(spy.warns[0]).toContain("NOT_FOUND");
    expect(spy.warns[0]).toContain(ISSUE_ID);
  });

  // ── AC2: no errors → log includes "none" ─────────────────────────────

  it("AC2: on non-success without errors, the log includes 'none'", async () => {
    const spy = spyLogger();
    _setLogForTests(spy);

    // Linear returns success:false with NO errors array.
    globalThis.fetch = async () =>
      new Response(JSON.stringify(FAILURE_WITHOUT_ERRORS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await _issueUpdateAtomicForTests(ISSUE_ID, LABEL_IDS, AUTH_TOKEN);

    expect(result).toBe(false);
    expect(spy.warns.length).toBe(1);
    // The warn entry MUST say "none" for the errors — not an empty string or missing field.
    expect(spy.warns[0]).toContain("errors=none");
    expect(spy.warns[0]).toContain(ISSUE_ID);
  });

  // ── AC3: success → log NOT called ────────────────────────────────────

  it("AC3: on success, the warn log is NOT called and the function returns true", async () => {
    const spy = spyLogger();
    _setLogForTests(spy);

    globalThis.fetch = async () =>
      new Response(JSON.stringify(SUCCESS_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await _issueUpdateAtomicForTests(ISSUE_ID, LABEL_IDS, AUTH_TOKEN);

    // Promise<boolean> contract: true on success.
    expect(result).toBe(true);
    // No warn call on the success path — the log is only for non-success responses.
    expect(spy.warns.length).toBe(0);
  });

  // ── AC4: no token leaks ──────────────────────────────────────────────

  it("AC4: the log line never contains the Authorization header value or the token", async () => {
    const spy = spyLogger();
    _setLogForTests(spy);

    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        fetchCalls.push({ url, headers: hdrs });
      }
      return new Response(JSON.stringify(FAILURE_WITH_ERRORS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await _issueUpdateAtomicForTests(ISSUE_ID, LABEL_IDS, AUTH_TOKEN);

    expect(result).toBe(false);
    expect(spy.warns.length).toBe(1);

    // The token value must not appear anywhere in the log message.
    expect(spy.warns[0]).not.toContain(AUTH_TOKEN);
    expect(spy.warns[0]).not.toContain("lin_bearer");
    expect(spy.warns[0]).not.toContain("Authorization");
    expect(spy.warns[0]).not.toContain("Bearer");

    // Sanity: the fetch call DID send the token (the function works correctly).
    const linearCall = fetchCalls.find((c) => c.url.includes("api.linear.app"));
    expect(linearCall).toBeDefined();
    expect(linearCall!.headers["Authorization"]).toBe(AUTH_TOKEN);
  });
});
