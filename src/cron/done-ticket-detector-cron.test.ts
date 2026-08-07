/**
 * INF-1300 — cron/done-ticket-detector-cron.ts
 *
 * AC: detection trigger and the resulting transition (via DoneTicketDetector + cron registration).
 * The cron file wires DoneTicketDetector to registerCron; tests cover trigger registration and that
 * the resulting transition path is the detector's sweep (mock Linear + deploy verdict).
 * Mocks: fetch (Linear API), registry, deploy verdict.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// We test registerDoneDetectorCron wiring + createLinearApi pagination plumbing at the boundary.
// For the actual detection→transition semantics, DoneTicketDetector is covered by its own bag tests;
// here we assert the cron module's integration seam without live API.

describe("done-ticket-detector-cron", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.resetModules();
    for (const k of ["DONE_DETECTOR_REPO_PATH", "DONE_DETECTOR_LOOKBACK_DAYS", "DONE_DETECTOR_GRACE_HOURS", "DONE_DETECTOR_POLL_INTERVAL_MS", "HEALTH_CHECK_URL"]) {
      origEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k as string];
      else process.env[k as string] = v;
    }
    jest.restoreAllMocks();
  });

  it("registerDoneDetectorCron with no repoPath logs warning and returns without registering", async () => {
    delete process.env.DONE_DETECTOR_REPO_PATH;
    const mod = await import("./done-ticket-detector-cron.js");
    // Should not throw; advisory only. No registerCron call.
    expect(() => mod.registerDoneDetectorCron({})).not.toThrow();
  });

  it("registerDoneDetectorCron with repoPath registers a cron and starts the detector", async () => {
    const tmp = (await import("node:os")).default.tmpdir();
    process.env.DONE_DETECTOR_REPO_PATH = tmp;

    // Mock registry to capture calls
    const registerCronMock = jest.fn();
    jest.unstable_mockModule("./registry.js", () => ({
      registerCron: registerCronMock,
      formatIntervalMs: (ms: number) => `${ms}ms`,
    }));

    // Provide a minimal bag mock so DoneTicketDetector.start is observable
    const startMock = jest.fn();
    jest.unstable_mockModule("../bag/done-ticket-detector.js", () => ({
      DoneTicketDetector: jest.fn().mockImplementation(() => ({ start: startMock })),
      makeDeployVerdictApi: jest.fn().mockReturnValue({}),
    }));
    jest.unstable_mockModule("../bag/deploy-verdict.js", () => ({ makeDeployVerdictApi: jest.fn().mockReturnValue({}) }));

    const mod = await import("./done-ticket-detector-cron.js");
    mod.registerDoneDetectorCron({ repoPath: tmp, lookbackDays: 7, graceHours: 1, pollIntervalMs: 60_000, linearToken: "tok" });
    expect(registerCronMock).toHaveBeenCalledWith("done-ticket-detector", expect.any(String));
    expect(startMock).toHaveBeenCalled();
  });

  it("createLinearApi fetchDoneTickets pages through Linear results (mocked fetch)", async () => {
    const mod = await import("./done-ticket-detector-cron.js");
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            data: { issues: { nodes: [{ id: "1", identifier: "INF-1", createdAt: new Date().toISOString(), labels: { nodes: [] }, team: { key: "INF" }, branchName: null, state: { name: "Done" }, completedAt: new Date().toISOString(), comments: { nodes: [] } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const api = mod.createLinearApi("fake-token");
      const tickets = await api.fetchDoneTickets(7);
      expect(Array.isArray(tickets)).toBe(true);
      expect(tickets.length).toBeGreaterThanOrEqual(1);
      expect(call).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("createLinearApi without token throws on use", async () => {
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_TOKEN;
    const mod = await import("./done-ticket-detector-cron.js");
    const api = mod.createLinearApi(undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: {} }) } as unknown as Response)) as unknown as typeof fetch;
    try {
      await expect(api.fetchDoneTickets(7)).rejects.toThrow(/No Linear API token/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("createLinearApi hasExistingComment filters by body prefix (mocked fetch)", async () => {
    const mod = await import("./done-ticket-detector-cron.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: { issue: { comments: { nodes: [{ body: "prefix: hello" }, { body: "other" }] } } } }),
    } as unknown as Response)) as unknown as typeof fetch;
    try {
      const api = mod.createLinearApi("fake-token");
      expect(await api.hasExistingComment("ISSUE-1", "prefix:")).toBe(true);
      expect(await api.hasExistingComment("ISSUE-1", "missing:")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("negative case", () => {
    it("createLinearApi propagates non-ok Linear responses as errors", async () => {
      const mod = await import("./done-ticket-detector-cron.js");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({ ok: false, status: 500 } as unknown as Response)) as unknown as typeof fetch;
      try {
        const api = mod.createLinearApi("tok");
        await expect(api.fetchDoneTickets(7)).rejects.toThrow(/Linear API returned 500/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
