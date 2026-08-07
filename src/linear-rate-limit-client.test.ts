/**
 * INF-1300 — linear-rate-limit-client.ts
 *
 * AC: core logic; backoff/retry with mocked clock. Each test mocks Linear API / clock boundary.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  LinearRateLimitClient,
  RateLimitBreakerOpenError,
  RATE_LIMIT_GATED_CONSUMERS,
  RATE_LIMIT_CRON_CONSUMERS,
} from "./linear-rate-limit-client.js";
import { AlertBus } from "./alerts/alert-bus.js";
import { AlertStore } from "./alerts/alert-store.js";

function memoryBus(nowFn?: () => number): AlertBus {
  const store = new AlertStore(":memory:");
  const bus = new AlertBus({ store, pushEnabled: false, now: nowFn ? () => new Date(nowFn()) : undefined });
  return bus;
}

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { status, headers: h, ok: status >= 200 && status < 300 } as unknown as Response;
}

describe("linear-rate-limit-client", () => {
  describe("core logic", () => {
    it("exposes gated consumers + cron consumers in liveness", () => {
      const client = new LinearRateLimitClient({ alertBus: memoryBus(), budgetTotal: 1000, floor: 500 });
      const live = client.liveness();
      expect(live.gatedConsumers).toEqual(expect.arrayContaining([...RATE_LIMIT_GATED_CONSUMERS]));
      expect(live.cronConsumers).toEqual(expect.arrayContaining([...RATE_LIMIT_CRON_CONSUMERS]));
      expect(live.remaining).toBe(1000);
      expect(live.floor).toBe(500);
      expect(live.breaker.state).toBe("closed");
    });

    it("observeResponse updates remaining + source from ratelimit-remaining header (mocked fetch via wrap)", async () => {
      const client = new LinearRateLimitClient({ alertBus: memoryBus(), budgetTotal: 1000, floor: 100, tripThreshold: 1 });
      const wrapped = client.wrap(async () => mockResponse(200, { "ratelimit-remaining": "42" }));
      await wrapped("https://api.linear.app/graphql");
      expect(client.liveness().remaining).toBe(42);
      expect(client.liveness().source).toBe("header");
    });

    it("redispatchBudget collapses to 0 at/below floor, equals headroom above floor", () => {
      const client = new LinearRateLimitClient({ alertBus: memoryBus(), budgetTotal: 600, floor: 500 });
      expect(client.redispatchBudget()).toBe(100);
      // drive remaining down via header
      const wrapped = client.wrap(async () => mockResponse(200, { "ratelimit-remaining": "400" }));
      return wrapped("https://api.linear.app/graphql").then(() => {
        expect(client.redispatchBudget()).toBe(0);
      });
    });
  });

  describe("backoff/retry with mocked clock", () => {
    it("429 increments consecutive count and trips breaker at threshold=1 (single escalation)", async () => {
      const bus = memoryBus();
      const notifySpy = jest.spyOn(bus, "notify");
      const client = new LinearRateLimitClient({ alertBus: bus, budgetTotal: 1000, floor: 500, tripThreshold: 1 });

      const wrapped = client.wrap(async () => mockResponse(429, { "ratelimit-remaining": "0", "ratelimit-reset": "3600" }));

      await expect(wrapped("https://api.linear.app/graphql")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      expect(client.isBreakerOpen()).toBe(true);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // second 429 while open is suppressed (breaker already open, fetch not issued)
      await expect(wrapped("https://api.linear.app/graphql")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });

    it("breaker open suppresses fetch before issuing it (mocked fetch never called)", async () => {
      const bus = memoryBus();
      const client = new LinearRateLimitClient({ alertBus: bus, budgetTotal: 1000, floor: 500, tripThreshold: 1 });
      // trip it
      const tripWrap = client.wrap(async () => mockResponse(429, { "ratelimit-remaining": "0", "ratelimit-reset": "3600" }));
      await expect(tripWrap("https://example.com")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);

      let fetched = false;
      const suppressedWrap = client.wrap(async () => {
        fetched = true;
        return mockResponse(200);
      });
      await expect(suppressedWrap("https://example.com")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      expect(fetched).toBe(false);
    });

    it("after reset window (mocked clock), breaker moves to half-open and allows a probe", async () => {
      let now = 1_000_000;
      const bus = memoryBus(() => now);
      const client = new LinearRateLimitClient({ alertBus: bus, budgetTotal: 1000, floor: 500, tripThreshold: 1, now: () => now });

      // trip with reset=2s
      const tripWrap = client.wrap(async () => mockResponse(429, { "ratelimit-remaining": "0", "ratelimit-reset": "2" }));
      await expect(tripWrap("https://example.com")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      expect(client.isBreakerOpen()).toBe(true);

      // advance clock beyond reset window
      now += 3_000;
      expect(client.isBreakerOpen()).toBe(false);
      expect(client.liveness().breaker.state).toBe("half-open");

      // successful probe closes breaker
      let probeOk = false;
      const probeWrap = client.wrap(async () => {
        probeOk = true;
        return mockResponse(200, { "ratelimit-remaining": "9000" });
      });
      await probeWrap("https://example.com");
      expect(probeOk).toBe(true);
      expect(client.liveness().breaker.state).toBe("closed");
    });

    it("successful response resets consecutive429 and closes breaker when budget recovered", async () => {
      const bus = memoryBus();
      const client = new LinearRateLimitClient({ alertBus: bus, budgetTotal: 1000, floor: 500, tripThreshold: 1 });
      // trip
      await expect(client.wrap(async () => mockResponse(429, { "ratelimit-remaining": "0", "ratelimit-reset": "3600" }))("https://x")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      // advance past window and send a good response with recovered budget
      const anyClient = client as unknown as { now: () => number; resetAtMs: number | null };
      // Force half-open by setting reset time in the past
      (client as unknown as Record<string, unknown>).resetAtMs = Date.now() - 1;
      expect(client.isBreakerOpen()).toBe(false);
      await client.wrap(async () => mockResponse(200, { "ratelimit-remaining": "8000" }))("https://x");
      expect(client.liveness().breaker.state).toBe("closed");
    });

    it("redispatchBudget is 0 while breaker is open even if remaining > floor", async () => {
      const bus = memoryBus();
      const client = new LinearRateLimitClient({ alertBus: bus, budgetTotal: 8000, floor: 500, tripThreshold: 1 });
      await expect(client.wrap(async () => mockResponse(429, { "ratelimit-remaining": "7500", "ratelimit-reset": "3600" }))("https://x")).rejects.toBeInstanceOf(RateLimitBreakerOpenError);
      // remaining 7500 > floor but breaker open → budget 0
      expect(client.redispatchBudget()).toBe(0);
    });
  });

  describe("negative case", () => {
    it("malformed ratelimit-remaining header is ignored (remaining unchanged)", async () => {
      const client = new LinearRateLimitClient({ alertBus: memoryBus(), budgetTotal: 1000, floor: 500 });
      await client.wrap(async () => mockResponse(200, { "ratelimit-remaining": "not-a-number" }))("https://x");
      expect(client.liveness().remaining).toBe(1000);
    });
  });
});
