/**
 * INF-1157: off-spine `state:doing` wedge → infinite stall-sweep re-poke loop.
 *
 * Root cause: the webhook dispatch path records against and checks the dispatch
 * circuit breaker (webhook/index.ts §9), but the cron re-dispatch paths — the
 * C4 stale-session re-poke in particular (index.ts processStaleSession) — did
 * NOT. So a governed ticket wedged on the same workflow state (an off-spine
 * `state:doing` whose only forward verb resolves to a transition a bare
 * `continue-workflow` can never satisfy, so it is declined every cycle) was
 * re-poked forever: the delegate woke, ran the verb, got the decline, posted a
 * comment, and the stall sweep re-poked again on the next cycle. The breaker
 * would have tripped on the repeated same-state wakes, but nothing on the cron
 * path consulted it.
 *
 * `recordRepokeAndCheckBreaker` closes that gap: it records a cron re-poke
 * against the SAME per-ticket breaker counter the webhook path uses, and reports
 * when the breaker has tripped so the caller drops the re-poke (the trip emits
 * the loud `transition-stuck` alert, escalating to a steward). These tests pin
 * the contract the C4 re-poke wiring relies on.
 */

import {
  recordRepokeAndCheckBreaker,
  resetCircuitBreakerForTest,
} from "./dispatch-circuit-breaker.js";

const TICKET = "linear-INF-1157-EXAMPLE";

beforeEach(() => {
  resetCircuitBreakerForTest();
});

describe("INF-1157: cron re-poke breaker gate", () => {
  test("a ticket wedged on the same state eventually suppresses the re-poke", () => {
    // Default max consecutive wakes is 3. The first dispatch seeds the counter
    // (wakeCount 0); each same-state re-poke increments it. The re-poke keeps
    // being delivered until the counter reaches the cap.
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(false); // seed (count 0)
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(false); // count 1
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(false); // count 2
    // The next same-state re-poke trips the breaker → the loop is broken.
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(true); // count 3 → trip
    // Once tripped, every subsequent same-state re-poke stays suppressed.
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(true);
    expect(recordRepokeAndCheckBreaker(TICKET, "doing").suppress).toBe(true);
  });

  test("genuine forward progress (a new state) resets the counter — no suppression", () => {
    // Accumulate on `doing` up to just below the trip threshold.
    recordRepokeAndCheckBreaker(TICKET, "doing");
    recordRepokeAndCheckBreaker(TICKET, "doing");
    recordRepokeAndCheckBreaker(TICKET, "doing");
    // The ticket advances to a state it has never occupied → real progress.
    const advanced = recordRepokeAndCheckBreaker(TICKET, "code-review");
    expect(advanced.suppress).toBe(false);
    expect(advanced.state.wakeCount).toBe(0);
    // A healthy ticket that keeps advancing to new states never trips.
    expect(recordRepokeAndCheckBreaker(TICKET, "merge").suppress).toBe(false);
    expect(recordRepokeAndCheckBreaker(TICKET, "sign-off").suppress).toBe(false);
  });

  test("a re-poke with no state:* label (ad-hoc) never suppresses", () => {
    // A ticket with no workflow state has no transitions to stall on — it must
    // never be suppressed by the breaker, no matter how many times it re-pokes.
    for (let i = 0; i < 12; i++) {
      expect(recordRepokeAndCheckBreaker(TICKET, null).suppress).toBe(false);
    }
  });

  test("the re-poke breaker shares the webhook breaker's per-ticket counter", () => {
    // The returned state exposes the same wakeCount the webhook path accumulates,
    // so cron re-pokes and webhook wakes climb toward ONE no-progress ceiling.
    recordRepokeAndCheckBreaker(TICKET, "doing");
    const second = recordRepokeAndCheckBreaker(TICKET, "doing");
    expect(second.state.wakeCount).toBe(1);
    expect(second.state.lastStateLabel).toBe("doing");
  });
});
