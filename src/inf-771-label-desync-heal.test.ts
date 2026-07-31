/**
 * INF-771 — post-transition label desync detection + self-heal.
 *
 * Live incident (INF-768, dev-sprint, 2026-07-26): `continue-workflow` from
 * `product-definition` advanced the ticket's NATIVE Linear state (To Do → Doing)
 * via the CLI's forwarded mutation, but the proxy's B2 `state:*` label swap did
 * not land — the ticket kept `state:product-definition` while native state read
 * `Doing`. The post-transition verifier (`verifyPostTransition`) is the seam that
 * should have caught this, but it (a) mis-compared a PREFIXED read-back label
 * against a BARE expected state, so `match` was effectively always false, and
 * (b) only logged a WARN — it never reconciled the label.
 *
 * This suite pins two properties:
 *   AC1: verifyPostTransition compares canonically (prefix-insensitive) so a
 *        correctly-advanced label reports match=true and a genuinely stale label
 *        reports match=false.
 *   AC2: on a detected desync, healPostTransitionDesync invokes the injected
 *        label-reconcile (setStateAtomic in production) and reports healed=true
 *        when it succeeds; it does NOT invoke the heal when the label already
 *        matches; and it reports healed=false (fail-loud) when the reconcile
 *        cannot apply.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { verifyPostTransition, healPostTransitionDesync } from "./transition-audit.js";

const realFetch = global.fetch;

/** Mock the single Linear read fetchStateLabel performs, returning `labelNames`. */
function mockStateLabelRead(labelNames: string[]): void {
  global.fetch = jest.fn(async () => {
    return {
      status: 200,
      json: async () => ({
        data: { issue: { labels: { nodes: labelNames.map((name) => ({ name })) } } },
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe("INF-771 AC1: verifyPostTransition canonical comparison", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  it("reports match=true when the read-back state:* label equals the expected bare state", async () => {
    mockStateLabelRead(["wf:dev-sprint", "state:spawn-arms"]);
    const v = await verifyPostTransition("INF-768", "spawn-arms", "auth");
    expect(v).not.toBeNull();
    expect(v!.match).toBe(true);
  });

  it("reports match=false when the label is genuinely stale (the INF-768 desync)", async () => {
    mockStateLabelRead(["wf:dev-sprint", "state:product-definition"]);
    const v = await verifyPostTransition("INF-768", "spawn-arms", "auth");
    expect(v).not.toBeNull();
    expect(v!.match).toBe(false);
    expect(v!.actualState).toBe("product-definition");
  });

  it("returns null when no state:* label can be read", async () => {
    mockStateLabelRead(["wf:dev-sprint"]);
    const v = await verifyPostTransition("INF-768", "spawn-arms", "auth");
    expect(v).toBeNull();
  });
});

describe("INF-771 AC2: healPostTransitionDesync reconciles or fails loud", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("invokes the reconcile and reports healed=true on a detected desync", async () => {
    mockStateLabelRead(["wf:dev-sprint", "state:product-definition"]);
    const heal = jest.fn(async () => ({ ok: true }));
    const r = await healPostTransitionDesync("INF-768", "spawn-arms", "auth", heal);
    expect(heal).toHaveBeenCalledTimes(1);
    expect(heal).toHaveBeenCalledWith("INF-768", "spawn-arms", "auth");
    expect(r.matched).toBe(false);
    expect(r.healed).toBe(true);
  });

  it("does NOT invoke the reconcile when the label already matches", async () => {
    mockStateLabelRead(["wf:dev-sprint", "state:spawn-arms"]);
    const heal = jest.fn(async () => ({ ok: true }));
    const r = await healPostTransitionDesync("INF-768", "spawn-arms", "auth", heal);
    expect(heal).not.toHaveBeenCalled();
    expect(r.matched).toBe(true);
    expect(r.healed).toBe(false);
  });

  it("reports healed=false when the reconcile cannot apply (fail-loud)", async () => {
    mockStateLabelRead(["wf:dev-sprint", "state:product-definition"]);
    const heal = jest.fn(async () => ({ ok: false, error: "verification failed" }));
    const r = await healPostTransitionDesync("INF-768", "spawn-arms", "auth", heal);
    expect(heal).toHaveBeenCalledTimes(1);
    expect(r.healed).toBe(false);
    expect(r.detail).toContain("verification failed");
  });

  it("reports not-verified (no heal) when the read-back itself fails", async () => {
    mockStateLabelRead(["wf:dev-sprint"]); // no state:* label → verify returns null
    const heal = jest.fn(async () => ({ ok: true }));
    const r = await healPostTransitionDesync("INF-768", "spawn-arms", "auth", heal);
    expect(heal).not.toHaveBeenCalled();
    expect(r.verified).toBe(false);
  });
});
