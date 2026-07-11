/**
 * Periodic OAuth token refresh for all configured agents.
 * Access tokens expire after ~24h; this refreshes every 20h.
 * Modeled after the ILL webhook's token-refresh.ts.
 *
 * A single transient upstream failure (e.g. a Linear HTTP 503) must not be
 * allowed to skip a refresh cycle — the next scheduled attempt is ~20h out,
 * which can land after the current token expires and start 401ing every
 * proxied Linear call for that agent (AI-1907 / AI-1911). So each cycle
 * retries with jittered backoff before giving up, and only escalates to a
 * visible alert once every attempt has failed.
 */
import type { AgentConfig } from "./agents.js";
/** Result of one refresh attempt. */
type AttemptResult = {
    ok: true;
} | {
    ok: false;
    retriable: boolean;
    reason: string;
};
export interface RefreshOptions {
    /** Injectable fetch (tests). Defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** Injectable sleep (tests pass a no-op to avoid real backoff waits). */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable RNG for jitter (tests). Defaults to Math.random. */
    rng?: () => number;
    maxAttempts?: number;
    baseBackoffMs?: number;
}
/** Backoff for the Nth retry (1-based), exponential with ±BACKOFF_JITTER jitter. */
declare function backoffMs(retry: number, base: number, rng: () => number): number;
/** Perform a single refresh attempt. Never throws — failures are returned. */
declare function refreshAgentOnce(agent: AgentConfig, fetchImpl: typeof fetch): Promise<AttemptResult>;
declare function refreshAgent(agent: AgentConfig, opts?: RefreshOptions): Promise<void>;
declare function refreshAll(opts?: RefreshOptions): Promise<void>;
export declare function startTokenRefresh(): void;
export { refreshAgent, refreshAll, refreshAgentOnce, backoffMs };
//# sourceMappingURL=token-refresh.d.ts.map