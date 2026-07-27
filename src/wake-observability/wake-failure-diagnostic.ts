/**
 * INF-508 — loud per-container diagnostics for silent dispatch-wake failures.
 *
 * When a connector dispatch is accepted at the gateway but the hook turn errors
 * before producing any Linear activity (context overflow on a tiny-context
 * primary, an auth failure, a restricted-tool error), the failure today
 * collapses into a generic "unreachable" at the first-action watchdog. The
 * operator never learns WHICH model resolved, WHY the turn died, or whether the
 * fallback stack was even given a chance.
 *
 * This is the classifier: it turns the raw gateway error signal the delivery
 * layer already captures (`hookErrorSummary` + `rawResponse`) into a structured,
 * per-container diagnostic — resolved provider/model, error class, gateway id,
 * and whether the fallback was skipped.
 *
 * The load-bearing insight from INF-506: a context-overflow is a *prompt* error,
 * so it does NOT cascade to the fallback stack — the turn dies on the primary
 * without ever trying `claude-sonnet` / `deepseek` / `gemma`. That is exactly why
 * clearing `OPENCLAW_HOOKS_MODEL` (the Charles/INF-502 fix) did not help igor:
 * it dropped dispatched turns onto the dev gateway's own tiny-context default,
 * which then overflowed silently. `fallbackSkipped: true` on this class is the
 * single most actionable field a human can see.
 */

// ── Enums ─────────────────────────────────────────────────────────────────────

/** Machine-readable class of a wake-turn failure. */
export enum WakeFailureClass {
  /** Prompt/context budget exceeded before the model ran. Does NOT cascade to fallback. */
  CONTEXT_OVERFLOW = "context-overflow",
  /** Provider/model auth rejected (bad or missing token/key, 401/403). */
  AUTH = "auth",
  /** Tool/MCP wiring error (restricted-tool lane, InputValidationError, MCP down). */
  TOOL = "tool",
  /** The gateway accepted then the request timed out / was aborted before a turn. */
  TIMEOUT = "timeout",
  /** A gateway error we could not attribute to a more specific class. */
  UNKNOWN = "unknown",
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WakeFailureDiagnostic {
  /** Delegate agent id the wake was dispatched to. */
  agentId: string;
  /** Gateway/container the delegate lives on (e.g. "dev", "grover"), if known. */
  gateway: string | null;
  /** Resolved provider (e.g. "ollama", "anthropic"), parsed from the error or hinted. */
  resolvedProvider: string | null;
  /** Resolved model (e.g. "gemma4:31b", "claude-opus-4-8"), parsed or hinted. */
  resolvedModel: string | null;
  /** The failure class. */
  failureClass: WakeFailureClass;
  /**
   * Whether the fallback stack was skipped. True for context-overflow (a prompt
   * error dies on the primary without cascading) — the INF-506 root cause.
   */
  fallbackSkipped: boolean;
  /** Estimated prompt tokens at the point of overflow (context-overflow only). */
  promptTokens: number | null;
  /** Usable prompt budget before reserve (context-overflow only). */
  promptBudget: number | null;
  /** Tokens over budget (context-overflow only). */
  overflowTokens: number | null;
  /** A one-line human-readable summary suitable for an alert title. */
  summary: string;
  /** The raw (redaction-safe, truncated) error text the classification was made from. */
  rawSummary: string;
}

export interface ClassifyWakeFailureInput {
  agentId: string;
  gateway?: string | null;
  /** The `hookErrorSummary` from the DeliveryResult, if any. */
  errorSummary?: string | null;
  /** The `rawResponse` body from the DeliveryResult, if any (gateway JSON). */
  rawResponse?: Record<string, unknown> | null;
  /**
   * Best-known resolved model hint from config (e.g. the agent's default
   * primary), used when the error text does not carry an explicit
   * `provider=<x>/<y>` token.
   */
  resolvedModelHint?: string | null;
}

// ── Signal extraction ─────────────────────────────────────────────────────────

const MAX_RAW_BYTES = 480;

/** Collapse the error signal into a single searchable string. */
function collectSignal(input: ClassifyWakeFailureInput): string {
  const parts: string[] = [];
  if (input.errorSummary) parts.push(input.errorSummary);
  const raw = input.rawResponse;
  if (raw && typeof raw === "object") {
    for (const field of ["error", "summary", "reason", "hint", "message", "detail"]) {
      const v = raw[field];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join(" — ").trim();
}

/**
 * Parse `provider=<provider>/<model>` from the gateway's context-overflow
 * precheck line (authoritative format, see openclaw dist
 * attempt.tool-run-context). Falls back to a bare `model=<x>` token.
 */
function parseProviderModel(signal: string): { provider: string | null; model: string | null } {
  const pm = signal.match(/provider=([A-Za-z0-9._-]+)\/([A-Za-z0-9._:@-]+)/);
  if (pm) return { provider: pm[1], model: pm[2] };
  const bare = signal.match(/\bmodel=([A-Za-z0-9._:@/-]+)/);
  if (bare) {
    const slash = bare[1].indexOf("/");
    if (slash > 0) return { provider: bare[1].slice(0, slash), model: bare[1].slice(slash + 1) };
    return { provider: null, model: bare[1] };
  }
  return { provider: null, model: null };
}

/** Split a "provider/model" hint into parts. */
function splitHint(hint: string | null | undefined): { provider: string | null; model: string | null } {
  if (!hint) return { provider: null, model: null };
  const slash = hint.indexOf("/");
  if (slash > 0) return { provider: hint.slice(0, slash), model: hint.slice(slash + 1) };
  return { provider: null, model: hint };
}

function parseIntField(signal: string, field: string): number | null {
  const m = signal.match(new RegExp(`${field}=(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

// ── Classification ─────────────────────────────────────────────────────────────

const CONTEXT_OVERFLOW_RE = /context[-\s]?overflow|promptBudgetBeforeReserve|estimatedPromptTokens|overflowTokens/i;
const AUTH_RE = /\b(401|403)\b|unauthor|forbidden|invalid\s+(?:api[-_\s]?key|token|credential)|authentication\s+fail|missing[-_\s]?token/i;
const TOOL_RE = /\btool\b|\bmcp\b|InputValidationError|toolsAllow|restricted[-_\s]?tool|tool[-_\s]?run/i;
const TIMEOUT_RE = /timeout|timed\s?out|AbortError|ETIMEDOUT|ECONNRESET|deadline/i;

/**
 * Classify a wake-turn failure from the raw gateway signal the delivery layer
 * captured. Pure — no I/O — so it is unit-tested against real error strings.
 *
 * Ordering is deliberate: context-overflow is checked first because its signal
 * (a `provider=.../...` precheck line) can co-occur with generic words like
 * "error", and it is the one class with fallback-skip semantics.
 */
export function classifyWakeFailure(input: ClassifyWakeFailureInput): WakeFailureDiagnostic {
  const signal = collectSignal(input);
  const parsed = parseProviderModel(signal);
  const hint = splitHint(input.resolvedModelHint);
  const resolvedProvider = parsed.provider ?? hint.provider;
  const resolvedModel = parsed.model ?? hint.model;

  let failureClass = WakeFailureClass.UNKNOWN;
  if (CONTEXT_OVERFLOW_RE.test(signal)) failureClass = WakeFailureClass.CONTEXT_OVERFLOW;
  else if (AUTH_RE.test(signal)) failureClass = WakeFailureClass.AUTH;
  else if (TOOL_RE.test(signal)) failureClass = WakeFailureClass.TOOL;
  else if (TIMEOUT_RE.test(signal)) failureClass = WakeFailureClass.TIMEOUT;

  const promptTokens = failureClass === WakeFailureClass.CONTEXT_OVERFLOW
    ? parseIntField(signal, "estimatedPromptTokens") : null;
  const promptBudget = failureClass === WakeFailureClass.CONTEXT_OVERFLOW
    ? parseIntField(signal, "promptBudgetBeforeReserve") : null;
  const overflowTokens = failureClass === WakeFailureClass.CONTEXT_OVERFLOW
    ? parseIntField(signal, "overflowTokens") : null;

  // Only a context-overflow is guaranteed not to cascade to the fallback stack:
  // it is a prompt error raised before any provider call, so the fallbacks never
  // run. Every other class can (and usually does) walk the fallback chain.
  const fallbackSkipped = failureClass === WakeFailureClass.CONTEXT_OVERFLOW;

  const modelLabel = resolvedProvider && resolvedModel
    ? `${resolvedProvider}/${resolvedModel}`
    : resolvedModel ?? "unknown-model";

  const summary = buildSummary({
    agentId: input.agentId,
    gateway: input.gateway ?? null,
    modelLabel,
    failureClass,
    fallbackSkipped,
    promptTokens,
    promptBudget,
  });

  const rawSummary = signal.length > MAX_RAW_BYTES ? `${signal.slice(0, MAX_RAW_BYTES)}…` : signal;

  return {
    agentId: input.agentId,
    gateway: input.gateway ?? null,
    resolvedProvider,
    resolvedModel,
    failureClass,
    fallbackSkipped,
    promptTokens,
    promptBudget,
    overflowTokens,
    summary,
    rawSummary,
  };
}

function buildSummary(p: {
  agentId: string;
  gateway: string | null;
  modelLabel: string;
  failureClass: WakeFailureClass;
  fallbackSkipped: boolean;
  promptTokens: number | null;
  promptBudget: number | null;
}): string {
  const where = p.gateway ? `${p.agentId}@${p.gateway}` : p.agentId;
  const base = `wake turn for ${where} failed: ${p.failureClass} on ${p.modelLabel}`;
  if (p.failureClass === WakeFailureClass.CONTEXT_OVERFLOW && p.promptTokens != null && p.promptBudget != null) {
    return `${base} (prompt ${p.promptTokens} tok > budget ${p.promptBudget} tok; fallback skipped)`;
  }
  if (p.fallbackSkipped) return `${base} (fallback skipped)`;
  return base;
}

/**
 * True when the delivery signal indicates a real turn-level failure worth a
 * diagnostic. A silent miss with no error text is not one — the WAKE_NOT_DELIVERED
 * / SESSION_DEAD reasons already cover an empty delivery.
 */
export function hasWakeFailureSignal(input: ClassifyWakeFailureInput): boolean {
  return collectSignal(input).length > 0;
}

// ── Turn failure hidden in a "successful" delivery response ────────────────────
//
// The crux of the INF-506 silent-wake class: a context overflow does NOT make
// the gateway return an HTTP error. On the live /v1 path it comes back as a
// 200-OK ChatCompletion whose assistant content IS the overflow message and
// whose `usage.prompt_tokens` is 0 — so the delivery layer records a clean
// "delivered" and the turn dies with zero Linear activity. To catch it we must
// inspect the body of a *successful* delivery, not just the failure branch.
//
// Observed live (dev gateway, 2026-07-24):
//   {"choices":[{"message":{"content":"Context overflow: prompt too large for
//   the model. Try /reset (or /new) to start a fresh session, or use a
//   larger-context model."},"finish_reason":"stop"}],"usage":{"prompt_tokens":0}}

const TURN_FAILURE_CONTENT_RE =
  /context overflow|prompt too large|larger[-\s]?context model|hook agent run (?:returned|failed)|non-ok status|\[context-overflow/i;

/**
 * Inspect a *delivered* (dispatched:true) gateway response body for a turn-level
 * failure surrogate the gateway injects in place of a real reply. Returns the
 * offending error text, or null when the response looks like a genuine turn.
 *
 * Conservative by construction: the trigger phrases (a canned overflow/error
 * message) cannot appear as an agent's own reply to a dispatch (that reply is
 * truncated to a single token), and `usage.prompt_tokens === 0` corroborates —
 * a real turn always consumes prompt tokens.
 */
export function detectTurnFailureInResponse(
  rawResponse: Record<string, unknown> | null | undefined,
): { errorText: string } | null {
  if (!rawResponse || typeof rawResponse !== "object") return null;

  // Top-level error/ok:false even on a 2xx body.
  if (rawResponse.ok === false) {
    const err = firstString(rawResponse, ["error", "summary", "reason", "message"]);
    if (err) return { errorText: err };
  }

  // OpenAI-compatible /v1 chat completion: overflow surfaces as assistant content.
  const choices = rawResponse.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const content = (choice as { message?: { content?: unknown } })?.message?.content;
      if (typeof content === "string" && TURN_FAILURE_CONTENT_RE.test(content)) {
        return { errorText: content };
      }
    }
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
