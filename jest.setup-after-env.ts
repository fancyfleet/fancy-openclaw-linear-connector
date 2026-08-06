/**
 * INF-1263: many test files call createApp() repeatedly across multiple
 * it()/beforeEach blocks without resetting the cron registry between calls.
 * Before this ticket, that was harmless — markCronRun was liveness-only, so
 * repeated failures never accumulated into anything observable. Now that
 * registered crons report real outcome via markCronRunSuccess/Failure, a
 * cron whose startup kick genuinely fails in a given test file's env/mocks
 * (e.g. no Linear token, a broken fetch mock) accumulates failureStreak
 * across that file's app instances and can trip the /health critical-failure
 * 503 gate for later, unrelated test cases in the same file.
 *
 * Only the failure-tracking fields are cleared (not the full entry) so
 * tests that register once in beforeAll and assert registeredAt/schedule
 * across multiple it() blocks (e.g. ai-1857-rescue-sweep-bootstrap.test.ts)
 * are unaffected.
 */
import { resetCronFailureStreaksForTest } from "./src/cron/registry.js";

afterEach(() => {
  resetCronFailureStreaksForTest();
});
