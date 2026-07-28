/**
 * INF-923 — Linear API rate-limit-aware client + 429 circuit breaker.
 *
 * The connector's re-dispatch / reconciliation path had no rate-limit-aware
 * backoff on its Linear API query volume. A false-C4 storm therefore
 * self-amplified into a genuine 10,000-req/hr budget exhaustion, which caused
 * *real* C4 never-starts (a freshly dispatched session 429s fetching its ticket
 * context, produces no output, and is re-dispatched — a self-reinforcing loop).
 *
 * This module is the single choke point every Linear API query path routes
 * through. It:
 *   1. Reads Linear's `x-ratelimit-remaining` / `ratelimit-remaining` (and
 *      `*-reset`) response headers and tracks the live remaining budget.
 *   2. Exposes a per-sweep re-dispatch budget that collapses to zero as the
 *      remaining budget approaches a configurable safety floor — so re-dispatch
 *      volume backs off instead of hammering the API (AC1).
 *   3. Trips a 429 circuit breaker on rate-limit exhaustion, emitting exactly
 *      one escalation and short-circuiting every subsequent query until the
 *      window recovers (AC2). `wrap()` throws `RateLimitBreakerOpenError` when
 *      the breaker is open, so callers stop issuing queries.
 *   4. Surfaces breaker state + remaining budget for observability at
 *      `/admin/api/ratelimit` and `/health.linearApiRateLimit` (AC4/AC6).
 *
 * The client is resolved per AlertBus (getRateLimitClient) so the production
 * bootstrap and every gated consumer share one breaker, while each test's
 * isolated bus gets its own — no cross-test breaker leakage.
 */

import type { AlertBus } from "./alerts/alert-bus.js";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(
  createLogger(process.env.LOG_LEVEL ?? "info"),
  "linear-rate-limit",
);

/**
 * Consumers whose Linear query path routes through the rate-limit-aware client
 * + breaker. Surfaced at /health so "wired at bootstrap" is provable at
 * ac-validate without waiting for a real 429 (AC5/AC6).
 */
export const RATE_LIMIT_GATED_CONSUMERS = [
  "stale-c4-repoke",
  "delegation-reconciliation-sweep",
  "bootstrap-reconciliation-sweep",
  "stale-plain-delegate-sweep",
] as const;

/** The subset of gated consumers driven by a periodic cron at bootstrap. */
export const RATE_LIMIT_CRON_CONSUMERS = [
  "delegation-reconciliation-sweep",
  "bootstrap-reconciliation-sweep",
] as const;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Linear's documented budget: 10,000 requests per rolling hour. */
const DEFAULT_BUDGET_TOTAL = envInt("LINEAR_API_BUDGET_TOTAL", 10_000);
/** Safety floor: re-dispatch volume collapses to zero at/below this remaining. */
const DEFAULT_BUDGET_FLOOR = envInt("LINEAR_API_BUDGET_FLOOR", 500);
/** Consecutive 429s that trip the breaker. A 429 means the budget is already
 *  exhausted, so the default trips on the first one — halting immediately is
 *  the correct response to a hard budget wall. */
const DEFAULT_TRIP_THRESHOLD = Math.max(1, envInt("LINEAR_API_429_TRIP_THRESHOLD", 1));

export type BreakerState = "closed" | "open" | "half-open";

/** Thrown by wrap()'d fetch when the breaker is open, so query callers abort. */
export class RateLimitBreakerOpenError extends Error {
  readonly code = "LINEAR_RATE_LIMIT_BREAKER_OPEN";
  constructor(message = "Linear API rate-limit breaker is open") {
    super(message);
    this.name = "RateLimitBreakerOpenError";
  }
}

export interface RateLimitLiveness {
  registered: boolean;
  remaining: number;
  floor: number;
  source: "header" | "live" | "unknown";
  breaker: { state: BreakerState; tripped: boolean };
  gatedConsumers: string[];
  cronConsumers: string[];
}

export interface LinearRateLimitClientOptions {
  alertBus: AlertBus;
  budgetTotal?: number;
  floor?: number;
  tripThreshold?: number;
  now?: () => number;
}

export class LinearRateLimitClient {
  private readonly alertBus: AlertBus;
  private readonly floorValue: number;
  private readonly tripThreshold: number;
  private readonly now: () => number;

  private remaining: number;
  private source: "header" | "live" | "unknown" = "unknown";
  private breakerState: BreakerState = "closed";
  private consecutive429 = 0;
  private escalated = false;
  private resetAtMs: number | null = null;
  private registered = false;

  constructor(opts: LinearRateLimitClientOptions) {
    this.alertBus = opts.alertBus;
    this.remaining = opts.budgetTotal ?? DEFAULT_BUDGET_TOTAL;
    this.floorValue = opts.floor ?? DEFAULT_BUDGET_FLOOR;
    this.tripThreshold = Math.max(1, opts.tripThreshold ?? DEFAULT_TRIP_THRESHOLD);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Marked by createApp() when the client is constructed + held at bootstrap. */
  markRegistered(): void {
    this.registered = true;
  }

  get floor(): number {
    return this.floorValue;
  }

  /**
   * True while the breaker is open and the reset window has not elapsed. Once
   * the `ratelimit-reset` window passes the breaker moves to half-open and a
   * probe query is allowed through.
   */
  isBreakerOpen(): boolean {
    if (this.breakerState !== "open") return false;
    if (this.resetAtMs !== null && this.now() >= this.resetAtMs) {
      this.breakerState = "half-open";
      return false;
    }
    return true;
  }

  /**
   * Per-sweep re-dispatch budget (AC1). Zero when the breaker is open or the
   * remaining budget is at/below the floor; otherwise the headroom above the
   * floor. Re-dispatch loops cap their volume at this value so a false-C4 storm
   * backs off as the budget approaches exhaustion instead of finishing the job
   * of exhausting it.
   */
  redispatchBudget(): number {
    if (this.isBreakerOpen()) return 0;
    return this.remaining > this.floorValue ? this.remaining - this.floorValue : 0;
  }

  /**
   * Wrap a fetch implementation so every Linear API call updates the live
   * budget and is gated by the breaker. Throws RateLimitBreakerOpenError when
   * the breaker is open (before issuing the request) and when a response is a
   * 429 (after recording it), so the calling query path stops immediately.
   */
  wrap(fetchFn: typeof fetch): typeof fetch {
    const self = this;
    const wrapped = async function (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> {
      if (self.isBreakerOpen()) {
        throw new RateLimitBreakerOpenError(
          "Linear API rate-limit breaker is open — query suppressed until budget recovers",
        );
      }
      const res = await fetchFn(input, init);
      self.observeResponse(res);
      if (res.status === 429) {
        self.record429();
        throw new RateLimitBreakerOpenError(
          `Linear API 429 — request budget exhausted (remaining=${self.remaining})`,
        );
      }
      self.onSuccessfulResponse();
      return res;
    };
    return wrapped as typeof fetch;
  }

  private observeResponse(res: Response): void {
    const headers = res.headers;
    if (!headers || typeof headers.get !== "function") return;
    const remainingHeader =
      headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining");
    if (remainingHeader !== null && remainingHeader !== undefined && remainingHeader !== "") {
      const parsed = Number(remainingHeader);
      if (Number.isFinite(parsed)) {
        this.remaining = parsed;
        this.source = "header";
      }
    }
    const resetHeader = headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset");
    if (resetHeader) {
      const secs = Number(resetHeader);
      if (Number.isFinite(secs) && secs > 0) {
        this.resetAtMs = this.now() + secs * 1000;
      }
    }
  }

  private onSuccessfulResponse(): void {
    // A clean response resets the consecutive-429 streak; a recovered budget in
    // a half-open/open state closes the breaker and re-arms escalation.
    this.consecutive429 = 0;
    if (this.breakerState !== "closed" && this.remaining > this.floorValue) {
      this.breakerState = "closed";
      this.escalated = false;
      this.resetAtMs = null;
      log.info("linear-rate-limit: breaker closed — Linear API budget recovered");
    }
  }

  private record429(): void {
    this.consecutive429 += 1;
    if (this.consecutive429 >= this.tripThreshold) {
      this.tripBreaker();
    }
  }

  private tripBreaker(): void {
    this.breakerState = "open";
    if (this.escalated) return; // one escalation per trip (AC2)
    this.escalated = true;
    log.error(
      `linear-rate-limit: 429 breaker tripped — re-dispatch/reconciliation halted (remaining=${this.remaining})`,
    );
    this.alertBus.notify({
      severity: "critical",
      source: "linear-api-rate-limit",
      title: "Linear API 429 breaker tripped — re-dispatch/reconciliation halted until budget recovers",
      detail: {
        remaining: this.remaining,
        floor: this.floorValue,
        resetAtMs: this.resetAtMs,
      },
    });
  }

  liveness(): RateLimitLiveness {
    return {
      registered: this.registered,
      remaining: this.remaining,
      floor: this.floorValue,
      source: this.source,
      breaker: {
        state: this.breakerState,
        tripped: this.breakerState !== "closed",
      },
      gatedConsumers: [...RATE_LIMIT_GATED_CONSUMERS],
      cronConsumers: [...RATE_LIMIT_CRON_CONSUMERS],
    };
  }
}

// ── Per-AlertBus registry ───────────────────────────────────────────────────
// Every gated consumer resolves the client from the AlertBus it already holds,
// so the production bootstrap (one bus) shares a single breaker across the
// re-dispatch/reconciliation path and its crons, while each test's isolated bus
// gets its own client — no cross-test breaker leakage.

const registry = new WeakMap<AlertBus, LinearRateLimitClient>();

export function getRateLimitClient(
  alertBus: AlertBus,
  opts?: Omit<LinearRateLimitClientOptions, "alertBus">,
): LinearRateLimitClient {
  let client = registry.get(alertBus);
  if (!client) {
    client = new LinearRateLimitClient({ alertBus, ...opts });
    registry.set(alertBus, client);
  }
  return client;
}
