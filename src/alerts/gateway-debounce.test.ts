/**
 * AI-2413 — Gateway restart debounce tests.
 */
import { jest } from "@jest/globals";
import { GatewayDebounce, _resetGatewayDebounceForTests, initGatewayDebounce, getGatewayDebounce } from "./gateway-debounce.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTimestamp(secondsAgo: number): Date {
  return new Date(Date.now() - secondsAgo * 1000);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("GatewayDebounce", () => {
  let debounce: GatewayDebounce;

  beforeEach(() => {
    _resetGatewayDebounceForTests();
    debounce = new GatewayDebounce({
      windowMs: 90_000,   // 90s default
      sourceList: "pit-crew,pitcrew,gateway-probe",
    });
  });

  afterEach(() => {
    _resetGatewayDebounceForTests();
  });

  // ── Basic behavior ─────────────────────────────────────────────────────────

  it("allows alerts when no restart recorded", () => {
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(false);
    expect(verdict.reason).toContain("no gateway restart recorded");
  });

  it("allows alerts from non-debounced sources", () => {
    debounce.recordRestart();
    const verdict = debounce.checkAlert("dispatch");
    expect(verdict.suppressed).toBe(false);
    expect(verdict.reason).toContain("not in debounce list");
  });

  it("suppresses pit-crew alerts within the debounce window", () => {
    debounce.recordRestart(makeTimestamp(10)); // 10s ago
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(true);
    expect(verdict.reason).toContain("debounce window");
  });

  it("allows pit-crew alerts outside the debounce window", () => {
    debounce.recordRestart(makeTimestamp(120)); // 120s ago, window is 90s
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(false);
    expect(verdict.reason).toContain("debounce window elapsed");
  });

  it("suppresses multiple configured sources (pitcrew, gateway-probe)", () => {
    debounce.recordRestart(makeTimestamp(5));

    const v1 = debounce.checkAlert("pitcrew");
    expect(v1.suppressed).toBe(true);

    const v2 = debounce.checkAlert("gateway-probe");
    expect(v2.suppressed).toBe(true);
  });

  it("case-insensitively matches source names", () => {
    debounce.recordRestart(makeTimestamp(5));

    const v1 = debounce.checkAlert("Pit-Crew");
    expect(v1.suppressed).toBe(true);

    const v2 = debounce.checkAlert("GATEWAY-PROBE");
    expect(v2.suppressed).toBe(true);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it("handles alert at the edge of the debounce window (89s)", () => {
    debounce.recordRestart(makeTimestamp(89)); // 89s ago, window is 90s
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(true);
    expect(verdict.reason).toContain("debounce window");
  });

  it("handles alert just past the debounce window (91s)", () => {
    debounce.recordRestart(makeTimestamp(91));
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(false);
  });

  it("suppresses alert at exactly the window boundary (90s)", () => {
    debounce.recordRestart(makeTimestamp(90));
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(true);
  });

  it("survives checkAlert before any restart recorded", () => {
    expect(() => debounce.checkAlert("pit-crew")).not.toThrow();
    const verdict = debounce.checkAlert("pit-crew");
    expect(verdict.suppressed).toBe(false);
  });

  it("survives consecutive restarts without throws", () => {
    expect(() => {
      debounce.recordRestart();
      debounce.recordRestart();
      debounce.recordRestart();
    }).not.toThrow();
  });

  it("reset clears all state", () => {
    debounce.recordRestart(makeTimestamp(5));
    expect(debounce.checkAlert("pit-crew").suppressed).toBe(true);

    debounce.reset();

    expect(debounce.checkAlert("pit-crew").suppressed).toBe(false);
    expect(debounce.checkAlert("pit-crew").reason).toContain("no gateway restart recorded");
  });

  // ── Multiple restarts extend the window ────────────────────────────────────

  it("a fresh restart extends the debounce window", () => {
    // Restart 80s ago → close to debounce end
    debounce.recordRestart(makeTimestamp(80));
    expect(debounce.checkAlert("pit-crew").suppressed).toBe(true);

    // Fresh restart resets the timer
    debounce.recordRestart(makeTimestamp(2));
    expect(debounce.checkAlert("pit-crew").suppressed).toBe(true);

    // After 95s since the fresh restart → outside window
    // (Can't test with fake timers here, use a different approach)
    const futureTime = new Date(Date.now() + 100 * 1000);
    const verdict = debounce.checkAlert("pit-crew", futureTime);
    expect(verdict.suppressed).toBe(false);
  });

  // ── Module-level default ───────────────────────────────────────────────────

  it("init/reset default instance via module-level API", () => {
    _resetGatewayDebounceForTests();

    const d = getGatewayDebounce();
    expect(d.checkAlert("pit-crew").suppressed).toBe(false);

    d.recordRestart(makeTimestamp(5));
    expect(d.checkAlert("pit-crew").suppressed).toBe(true);

    _resetGatewayDebounceForTests();
    initGatewayDebounce({ windowMs: 2000 });

    const d2 = getGatewayDebounce();
    expect(d2.checkAlert("pit-crew").suppressed).toBe(false);
  });
});
