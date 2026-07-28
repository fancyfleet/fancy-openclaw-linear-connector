/**
 * INF-956: hard re-dispatch cap for dead-dispatch loops.
 *
 * A `task` ticket scoped to the wrong department head is re-stranded and
 * re-dispatched, churning a small ring of already-seen workflow states
 * (doing → intake → routing → doing …). The AI-2178 consecutive-same-state
 * counter resets on every state change, so it never accumulates and the ticket
 * loops 18+ times against a nominal cap of 3.
 *
 * These tests pin the second, churn-aware ceiling: a wake that revisits an
 * already-seen state increments `revisitCount`, which is reset ONLY by reaching
 * a genuinely-new state (real forward progress) or a steward reset. Reaching the
 * revisit cap trips the breaker even though no state was ever repeated
 * consecutively.
 */

import {
  recordDispatch,
  checkBreaker,
  resetBreaker,
  getCircuitBreakerHealth,
  getAllBreakerStates,
  resetCircuitBreakerForTest,
} from "./dispatch-circuit-breaker.js";

const TICKET = "linear-INF-956-EXAMPLE";

/** The dead-loop ring: a Design-scoped task re-stranded on the wrong head. */
const LOOP = ["state:doing", "state:intake", "state:routing"];

beforeEach(() => {
  resetCircuitBreakerForTest();
});

describe("INF-956: churn-aware re-dispatch cap", () => {
  test("consecutive-wake counter never trips on a state-churning loop", () => {
    // Cycle the ring 3 full times (9 dispatches). No two ADJACENT dispatches
    // share a label, so the AI-2178 consecutive counter stays at 0 throughout.
    for (let i = 0; i < 9; i++) {
      const state = recordDispatch(TICKET, LOOP[i % LOOP.length]);
      expect(state.wakeCount).toBe(0); // consecutive counter never accumulates
    }
    // ...but the churn counter has been climbing the whole time.
    const states = getAllBreakerStates();
    expect(states[TICKET].revisitCount).toBeGreaterThan(0);
  });

  test("trips at the revisit cap despite the churning states", () => {
    // First pass over the 3 states is genuine forward progress (all new) →
    // revisitCount stays 0. Every subsequent landing is a revisit.
    // Default cap is 10 → trips on the 10th revisit.
    let tripped = false;
    for (let i = 0; i < 40 && !tripped; i++) {
      recordDispatch(TICKET, LOOP[i % LOOP.length]);
      tripped = checkBreaker(TICKET).blocked;
      if (tripped) {
        // 3 new-state dispatches + 10 revisits = 13 dispatches before the trip.
        expect(i + 1).toBe(13);
      }
    }
    expect(tripped).toBe(true);
    // Well before the observed 18x pathology.
    expect(checkBreaker(TICKET).blocked).toBe(true);
  });

  test("a genuinely-progressing ticket never trips", () => {
    // The healthy task path: every state is reached exactly once, in order, to a
    // terminal. No state is ever revisited → churn counter stays 0.
    const path = [
      "state:intake",
      "state:routing",
      "state:doing",
      "state:review",
      "state:merge",
      "state:sign-off",
      "state:done",
    ];
    for (const s of path) {
      recordDispatch(TICKET, s);
      expect(checkBreaker(TICKET).blocked).toBe(false);
    }
    const states = getAllBreakerStates();
    expect(states[TICKET].revisitCount).toBe(0);
  });

  test("bounded revision bounces do not trip; reaching a new state resets churn", () => {
    // Reach review via the normal path, then bounce review ⇄ doing a few times.
    recordDispatch(TICKET, "state:intake");
    recordDispatch(TICKET, "state:routing");
    recordDispatch(TICKET, "state:doing");
    recordDispatch(TICKET, "state:review");

    // Two revision cycles = 4 revisits (doing, review, doing, review) — under cap.
    for (let i = 0; i < 2; i++) {
      recordDispatch(TICKET, "state:doing");
      recordDispatch(TICKET, "state:review");
    }
    expect(checkBreaker(TICKET).blocked).toBe(false);
    expect(getAllBreakerStates()[TICKET].revisitCount).toBe(4);

    // Approving forward to a NEW state (merge) is real progress → churn resets.
    recordDispatch(TICKET, "state:merge");
    expect(getAllBreakerStates()[TICKET].revisitCount).toBe(0);
    expect(checkBreaker(TICKET).blocked).toBe(false);
  });

  test("a tripped breaker stays tripped on further churn, un-trips only on new state", () => {
    // Drive it into the tripped state via the loop.
    for (let i = 0; i < 40 && !checkBreaker(TICKET).blocked; i++) {
      recordDispatch(TICKET, LOOP[i % LOOP.length]);
    }
    expect(checkBreaker(TICKET).blocked).toBe(true);

    // More churn-returns to seen states keep it tripped.
    recordDispatch(TICKET, "state:doing");
    recordDispatch(TICKET, "state:routing");
    expect(checkBreaker(TICKET).blocked).toBe(true);

    // A genuinely-new state (real forward progress) un-trips and clears churn.
    recordDispatch(TICKET, "state:review");
    expect(checkBreaker(TICKET).blocked).toBe(false);
    expect(getAllBreakerStates()[TICKET].revisitCount).toBe(0);
  });

  test("steward reset clears churn history", () => {
    for (let i = 0; i < 40 && !checkBreaker(TICKET).blocked; i++) {
      recordDispatch(TICKET, LOOP[i % LOOP.length]);
    }
    expect(checkBreaker(TICKET).blocked).toBe(true);
    expect(resetBreaker(TICKET)).toBe(true);
    expect(checkBreaker(TICKET).blocked).toBe(false);
    // After reset, the first dispatch seeds a fresh history with revisitCount 0.
    const state = recordDispatch(TICKET, "state:doing");
    expect(state.revisitCount).toBe(0);
    expect(state.seenStates).toEqual(["state:doing"]);
  });

  test("health snapshot exposes the revisit cap", () => {
    const health = getCircuitBreakerHealth();
    expect(health.config.maxStateRevisits).toBe(10);
    expect(health.config.maxWakes).toBe(3);
  });

  test("ad-hoc tickets (null state) never accumulate churn", () => {
    for (let i = 0; i < 15; i++) {
      const state = recordDispatch(TICKET, null);
      expect(state.revisitCount).toBe(0);
      expect(state.tripped).toBe(false);
    }
    expect(checkBreaker(TICKET).blocked).toBe(false);
  });
});
