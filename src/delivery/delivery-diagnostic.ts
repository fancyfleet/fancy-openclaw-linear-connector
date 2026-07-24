/**
 * INF-507 — Loud per-container dispatch diagnostic.
 *
 * A dispatched hook/agent turn can die *after* the gateway accepts it but
 * *before* it produces any Linear activity. The archetype (INF-502, INF-506) is
 * a **context overflow on a tiny-context primary model**: the ~20k-token
 * bootstrap exceeds the resolved model's usable prompt budget, the turn dies as
 * a *prompt* error — which does NOT cascade to the fallback stack — and the
 * connector, seeing no activity, eventually reports a generic "unreachable."
 * Diagnosing it has twice required a human reading gateway logs by hand.
 *
 * This module turns whatever failure detail the connector *does* capture (an
 * `{ ok:false }` hook body, a non-2xx `/v1` error body, or a fetch/abort error)
 * into a **structured, machine-readable diagnostic** that names the resolved
 * model and classifies the failure — crucially distinguishing a
 * *prompt/context* error (non-cascading, "the model can't even read the
 * bootstrap") from a genuine *provider* error, *timeout*, or *unreachable*
 * host. The diagnostic is persisted on the dispatch outcome and carried into
 * the watchdog's unreachable verdict so the next instance surfaces its own root
 * cause instead of a blank "unreachable."
 *
 * IMPORTANT SCOPE NOTE (the residual gateway dependency): the *hooks* dispatch
 * path is fire-and-forget — the gateway returns `{ ok:true, runId }` before the
 * turn runs, so a context-overflow there is structurally invisible to the
 * connector and lands only in the gateway's own logs. Classifying it end-to-end
 * on that path requires the gateway to EMIT the failure diagnostic back to the
 * connector (tracked separately). This module classifies every failure the
 * connector can already see today — the synchronous `/v1` error path and any
 * hook `{ ok:false }` / non-2xx body — and is written so that, once a gateway
 * emit lands, the same classifier consumes it unchanged.
 */

/** Machine-readable failure classes for a dispatch attempt. */
export type DispatchErrorClass =
  /** Prompt/context overflow — the (bootstrap) prompt exceeds the model's usable
   *  budget. A PROMPT error: it does NOT cascade to the fallback stack. This is
   *  the silent-wake class INF-507 exists to make loud. */
  | "context-overflow"
  /** The dispatch timed out / was aborted before the gateway confirmed. */
  | "timeout"
  /** The host/gateway could not be reached (connection refused, DNS, TLS). */
  | "unreachable"
  /** The gateway/provider returned an error that WOULD cascade (5xx, provider
   *  outage, auth) — distinct from a non-cascading prompt error. */
  | "provider-error"
  /** A failure we captured but could not classify. */
  | "unknown";

export interface DeliveryDiagnostic {
  errorClass: DispatchErrorClass;
  /** True only for a prompt/context error — the non-cascading class. This is the
   *  bit that explains "accepts dispatch, produces no activity": the turn died
   *  on the prompt, so no fallback was tried and no activity was produced. */
  promptError: boolean;
  /** The underlying model that resolved for the turn, when recoverable from the
   *  failure detail (e.g. `ollama/gemma4:31b`). Undefined when not present. */
  resolvedModel?: string;
  /** Estimated prompt tokens at the LLM boundary (context-overflow only). */
  estimatedPromptTokens?: number;
  /** The model's usable prompt budget before reserve (context-overflow only). */
  promptBudgetBeforeReserve?: number;
  /** How far over budget the prompt was, when both figures are present. */
  overflowTokens?: number;
  /** A compact, human-readable one-liner suitable for an alert title/log. */
  summary: string;
}

/** Minimal shape this classifier reads off a DeliveryResult (avoids an import
 *  cycle with deliver.ts, which imports this type). */
export interface DeliveryFailureInput {
  hookError?: boolean;
  hookErrorSummary?: string;
  pendingAck?: boolean;
  rawResponse?: Record<string, unknown>;
}

// Context-overflow markers the gateway emits across its precheck variants
// (attempt.tool-run-context / selection): "Context overflow: ...",
// "prompt too large for the model", and the structured precheck line.
const OVERFLOW_TEXT = /context overflow|prompt too large for the model/i;
// `estimatedPromptTokens=20044` / `promptBudgetBeforeReserve=12768` (log form)
const EST_TOKENS_RE = /estimatedPromptTokens[=:]\s*(\d+)/i;
const BUDGET_RE = /promptBudgetBeforeReserve[=:]\s*(\d+)/i;
const OVERFLOW_TOKENS_RE = /overflowTokens[=:]\s*(\d+)/i;
// `provider=ollama/gemma4:31b` or `provider=ollama/gemma4:31b/route` — capture
// the provider/model pair. Falls back to a bare `model=<id>` token.
const PROVIDER_RE = /provider[=:]\s*([\w./:-]+)/i;
const MODEL_RE = /\bmodel[=:]\s*([\w./:-]+)/i;
// Transport-level unreachability from fetch/undici error messages.
const UNREACHABLE_TEXT =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|self.signed|certificate|TLS/i;
const TIMEOUT_TEXT = /abort|timed?\s*out|timeout|deadline/i;

function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstMatch(re: RegExp, ...sources: (string | undefined)[]): string | undefined {
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/**
 * Classify a failed dispatch attempt into a structured diagnostic. Reads the
 * captured error summary and any structured `rawResponse` body; never throws.
 * A caller passes the whole failed DeliveryResult.
 */
export function classifyDeliveryFailure(input: DeliveryFailureInput): DeliveryDiagnostic {
  const summaryText = input.hookErrorSummary ?? "";
  const raw = input.rawResponse ?? {};
  // The gateway may nest the error under `error`, `error.message`, `summary`,
  // `diagnostics.summary`, or a flat `message`. Flatten the searchable text so
  // the classifier works regardless of which envelope carried it.
  const rawError = raw.error as Record<string, unknown> | string | undefined;
  const rawErrorMessage =
    typeof rawError === "string"
      ? rawError
      : typeof rawError?.message === "string"
        ? (rawError.message as string)
        : undefined;
  const diagnostics = raw.diagnostics as Record<string, unknown> | undefined;
  const rawText = [
    summaryText,
    rawErrorMessage,
    typeof raw.summary === "string" ? raw.summary : undefined,
    typeof raw.message === "string" ? raw.message : undefined,
    typeof diagnostics?.summary === "string" ? (diagnostics.summary as string) : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  // Structured numeric fields, if the gateway body carried them directly, win
  // over regex-scraped ones. (types-*.d.ts declares these on overflow bodies.)
  const estimatedPromptTokens =
    toNum(raw.estimatedPromptTokens) ??
    toNum(diagnostics?.estimatedPromptTokens) ??
    (firstMatch(EST_TOKENS_RE, rawText) ? Number(firstMatch(EST_TOKENS_RE, rawText)) : undefined);
  const promptBudgetBeforeReserve =
    toNum(raw.promptBudgetBeforeReserve) ??
    toNum(diagnostics?.promptBudgetBeforeReserve) ??
    (firstMatch(BUDGET_RE, rawText) ? Number(firstMatch(BUDGET_RE, rawText)) : undefined);

  const resolvedModel =
    (typeof raw.provider === "string" && typeof raw.model === "string"
      ? `${raw.provider}/${raw.model}`
      : undefined) ??
    (typeof raw.resolvedModel === "string" ? (raw.resolvedModel as string) : undefined) ??
    firstMatch(PROVIDER_RE, rawText) ??
    (typeof raw.model === "string" ? (raw.model as string) : undefined) ??
    firstMatch(MODEL_RE, rawText);

  // 1) Context overflow — the load-bearing class. Detected by explicit overflow
  //    text OR by the presence of both boundary figures with the estimate over
  //    budget (the gateway sometimes logs the numbers without the prose).
  const numbersShowOverflow =
    estimatedPromptTokens !== undefined &&
    promptBudgetBeforeReserve !== undefined &&
    estimatedPromptTokens > promptBudgetBeforeReserve;
  if (OVERFLOW_TEXT.test(rawText) || numbersShowOverflow) {
    const overflowTokens =
      toNum(raw.overflowTokens) ??
      (firstMatch(OVERFLOW_TOKENS_RE, rawText)
        ? Number(firstMatch(OVERFLOW_TOKENS_RE, rawText))
        : estimatedPromptTokens !== undefined && promptBudgetBeforeReserve !== undefined
          ? Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve)
          : undefined);
    const parts: string[] = ["context-overflow-on-primary"];
    if (resolvedModel) parts.push(`model=${resolvedModel}`);
    if (estimatedPromptTokens !== undefined) parts.push(`estimatedPromptTokens=${estimatedPromptTokens}`);
    if (promptBudgetBeforeReserve !== undefined) parts.push(`promptBudgetBeforeReserve=${promptBudgetBeforeReserve}`);
    parts.push("promptError=true (non-cascading)");
    return {
      errorClass: "context-overflow",
      promptError: true,
      resolvedModel,
      estimatedPromptTokens,
      promptBudgetBeforeReserve,
      overflowTokens,
      summary: parts.join(" "),
    };
  }

  // 2) Timeout / abort — a queued-but-unconfirmed connect abort surfaces here.
  //    (pendingAck aborts are handled by the caller as "not a failure"; this
  //    branch covers a summary that names a timeout without pendingAck.)
  if (input.pendingAck || TIMEOUT_TEXT.test(rawText)) {
    return {
      errorClass: "timeout",
      promptError: false,
      resolvedModel,
      summary: `timeout/abort before gateway confirmation${resolvedModel ? ` model=${resolvedModel}` : ""}`,
    };
  }

  // 3) Transport unreachable — the host/gateway itself could not be reached.
  if (UNREACHABLE_TEXT.test(rawText)) {
    return {
      errorClass: "unreachable",
      promptError: false,
      resolvedModel,
      summary: `host/gateway unreachable: ${summaryText.slice(0, 160) || "connection error"}`,
    };
  }

  // 4) Any other captured error is a provider/gateway error that WOULD cascade —
  //    explicitly distinct from a non-cascading prompt error (AC3).
  if (input.hookError || summaryText) {
    return {
      errorClass: "provider-error",
      promptError: false,
      resolvedModel,
      summary: `provider/gateway error${resolvedModel ? ` model=${resolvedModel}` : ""}: ${summaryText.slice(0, 160) || "non-ok status"}`,
    };
  }

  // 5) No detail at all — the genuine "silent miss." This is what a fire-and-
  //    forget hooks overflow looks like from the connector today: nothing to
  //    classify. Named explicitly so it is distinguishable from a real error.
  return {
    errorClass: "unknown",
    promptError: false,
    resolvedModel,
    summary: "no failure detail captured (silent miss)",
  };
}

/** True when the diagnostic is the non-cascading prompt/context-overflow class —
 *  the one where re-dispatching into the same primary is futile (it will just
 *  overflow again) and the verdict should name the model, not say "unreachable." */
export function isContextOverflow(d: DeliveryDiagnostic | null | undefined): boolean {
  return d?.errorClass === "context-overflow";
}
