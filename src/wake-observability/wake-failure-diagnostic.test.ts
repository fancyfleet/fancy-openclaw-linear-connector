/**
 * INF-508 — wake-failure diagnostic classifier.
 *
 * Turns the raw gateway error signal the delivery layer captures into a
 * structured per-container diagnostic. The context-overflow fixtures use the
 * authoritative gateway error format (openclaw dist attempt.tool-run-context:
 * `[context-overflow-precheck] ... provider=<p>/<m> ... estimatedPromptTokens=N
 * promptBudgetBeforeReserve=M overflowTokens=K`) so the parser is tested against
 * the real thing, not an invented string.
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyWakeFailure,
  hasWakeFailureSignal,
  detectTurnFailureInResponse,
  WakeFailureClass,
} from "./wake-failure-diagnostic.js";

/**
 * The EXACT 200-OK body the live dev gateway /v1 path returned for a context
 * overflow (captured 2026-07-24). The overflow is NOT an HTTP error — it is the
 * assistant "reply", with usage.prompt_tokens=0. This is the silent-wake crux.
 */
const LIVE_V1_OVERFLOW_BODY = {
  id: "chatcmpl_512a64ec-b8af-4811-b371-14dfad769031",
  object: "chat.completion",
  model: "openclaw/tdd",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

// The exact shape the gateway emits on a tiny-context primary overflow (INF-506).
const OVERFLOW_SIGNAL =
  "[context-overflow-precheck] pre-prompt check sessionKey=agent:igor:linear-INF-504 " +
  "provider=ollama/gemma4:31b route=primary estimatedPromptTokens=20044 pressureSource=estimate " +
  "promptBudgetBeforeReserve=12768 overflowTokens=7276 toolResultReducibleChars=0 reserveTokens=1024 " +
  "effectiveReserveTokens=1024 contextTokenBudget=13792 messages=3 unwindowedMessages=3 sessionFile=/x";

describe("INF-508 classifyWakeFailure", () => {
  it("classifies a real context-overflow, extracting provider/model + token budgets", () => {
    const d = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: OVERFLOW_SIGNAL });
    expect(d.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(d.resolvedProvider).toBe("ollama");
    expect(d.resolvedModel).toBe("gemma4:31b");
    expect(d.promptTokens).toBe(20044);
    expect(d.promptBudget).toBe(12768);
    expect(d.overflowTokens).toBe(7276);
  });

  it("marks fallbackSkipped=true for context-overflow (a prompt error never cascades)", () => {
    const d = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: OVERFLOW_SIGNAL });
    expect(d.fallbackSkipped).toBe(true);
    // The single most actionable fact must be in the human summary.
    expect(d.summary).toMatch(/fallback skipped/i);
    expect(d.summary).toContain("igor@dev");
    expect(d.summary).toContain("ollama/gemma4:31b");
  });

  it("classifies an auth failure and does NOT mark fallback skipped", () => {
    const d = classifyWakeFailure({
      agentId: "sage",
      gateway: "dev",
      errorSummary: "gateway API responded with 401: {\"error\":\"invalid api key\"}",
      resolvedModelHint: "deepseek/deepseek-chat",
    });
    expect(d.failureClass).toBe(WakeFailureClass.AUTH);
    expect(d.fallbackSkipped).toBe(false);
    // No provider= token in the text — falls back to the config hint.
    expect(d.resolvedProvider).toBe("deepseek");
    expect(d.resolvedModel).toBe("deepseek-chat");
  });

  it("classifies a restricted-tool / MCP error as TOOL", () => {
    const d = classifyWakeFailure({
      agentId: "tdd",
      gateway: "dev",
      rawResponse: { ok: false, error: "InputValidationError: tool not permitted in restricted-tool lane" },
    });
    expect(d.failureClass).toBe(WakeFailureClass.TOOL);
    expect(d.fallbackSkipped).toBe(false);
  });

  it("classifies a timeout/abort as TIMEOUT", () => {
    const d = classifyWakeFailure({ agentId: "igor", errorSummary: "The operation was aborted (AbortError)" });
    expect(d.failureClass).toBe(WakeFailureClass.TIMEOUT);
  });

  it("falls back to UNKNOWN for an unattributable gateway error, keeping the raw text", () => {
    const d = classifyWakeFailure({ agentId: "igor", gateway: "dev", errorSummary: "kaboom 500 internal" });
    expect(d.failureClass).toBe(WakeFailureClass.UNKNOWN);
    expect(d.rawSummary).toContain("kaboom");
  });

  it("reads the error out of rawResponse fields when errorSummary is absent", () => {
    const d = classifyWakeFailure({
      agentId: "igor",
      gateway: "dev",
      rawResponse: { ok: false, summary: OVERFLOW_SIGNAL },
    });
    expect(d.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(d.promptTokens).toBe(20044);
  });

  it("hasWakeFailureSignal is false for an empty/silent miss, true when the gateway spoke", () => {
    expect(hasWakeFailureSignal({ agentId: "igor" })).toBe(false);
    expect(hasWakeFailureSignal({ agentId: "igor", errorSummary: "" })).toBe(false);
    expect(hasWakeFailureSignal({ agentId: "igor", errorSummary: "boom" })).toBe(true);
    expect(hasWakeFailureSignal({ agentId: "igor", rawResponse: { error: "boom" } })).toBe(true);
  });

  it("truncates an oversized raw summary but keeps a bounded record", () => {
    const huge = "context overflow " + "x".repeat(5000);
    const d = classifyWakeFailure({ agentId: "igor", errorSummary: huge });
    expect(d.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(d.rawSummary.length).toBeLessThan(600);
    expect(d.rawSummary.endsWith("…")).toBe(true);
  });
});

describe("INF-508 detectTurnFailureInResponse — overflow hidden in a 200-OK delivery", () => {
  it("detects the live /v1 context-overflow surfaced as assistant content", () => {
    const hit = detectTurnFailureInResponse(LIVE_V1_OVERFLOW_BODY as unknown as Record<string, unknown>);
    expect(hit).not.toBeNull();
    expect(hit!.errorText).toMatch(/context overflow/i);
  });

  it("that detected text classifies as CONTEXT_OVERFLOW with fallback skipped", () => {
    const hit = detectTurnFailureInResponse(LIVE_V1_OVERFLOW_BODY as unknown as Record<string, unknown>)!;
    const d = classifyWakeFailure({ agentId: "tdd", gateway: "dev", errorSummary: hit.errorText, resolvedModelHint: "ollama/gemma4:31b" });
    expect(d.failureClass).toBe(WakeFailureClass.CONTEXT_OVERFLOW);
    expect(d.fallbackSkipped).toBe(true);
    expect(d.resolvedModel).toBe("gemma4:31b"); // from the config hint (content has no provider= token)
  });

  it("returns null for a genuine (non-failure) turn reply", () => {
    const ok = {
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4213, completion_tokens: 1, total_tokens: 4214 },
    };
    expect(detectTurnFailureInResponse(ok as unknown as Record<string, unknown>)).toBeNull();
  });

  it("detects an ok:false hooks body even on a 2xx response", () => {
    const hit = detectTurnFailureInResponse({ ok: false, error: "hook agent run returned non-ok status" });
    expect(hit).not.toBeNull();
    expect(hit!.errorText).toMatch(/non-ok status/);
  });

  it("returns null for empty / malformed bodies", () => {
    expect(detectTurnFailureInResponse(null)).toBeNull();
    expect(detectTurnFailureInResponse(undefined)).toBeNull();
    expect(detectTurnFailureInResponse({})).toBeNull();
    expect(detectTurnFailureInResponse({ choices: [] })).toBeNull();
  });
});
