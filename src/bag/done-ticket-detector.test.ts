/**
 * DoneTicketDetector — tests for the live-signal deploy verdict (INF-1099).
 *
 * The detector's "is this shipped?" verdict is now derived from LIVE signals —
 * the running commit read from `/health` and a code-level `git grep` of the
 * fix's hallmark symbol — never from the ticket identifier/title/`Done` label.
 *
 * Retained ACs (from AI-2576): sweep, skip-labeled, skip-unbranched, re-land,
 * advisory-only, one-comment-per-ticket, liveness, lifecycle.
 * Superseded: ticket-ID string match in git log (AC2/AC7) → live deploy verdict.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  DoneTicketDetector,
  type DoneTicketDetectorConfig,
  type LinearIssue,
  type LinearApi,
  type LinearCreateIssueInput,
} from "./done-ticket-detector.js";
import {
  makeDeployVerdictApi,
  type DeployVerdictApi,
  type DeployVerdict,
  type CodePresence,
} from "./deploy-verdict.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DoneTicketDetectorConfig = {
  lookbackDays: 14,
  graceHours: 4,
  pollIntervalMs: 60 * 60 * 1000, // 1 hour
  repoPath: "/tmp/test-repo",
};

/** Create a minimal Linear issue fixture (with a hallmark label by default). */
function makeIssue(overrides: Partial<LinearIssue> & { identifier: string }): LinearIssue {
  return {
    id: `linear-${overrides.identifier.toLowerCase()}`,
    createdAt: new Date().toISOString(),
    labels: ["hallmark:someExportedSymbol"],
    hasBranch: true,
    doneAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Verdict fixtures. */
function deployedVerdict(): DeployVerdict {
  return {
    status: "deployed",
    deployed: true,
    stall: false,
    hallmarkSymbol: "someExportedSymbol",
    runningCommit: "abc1234",
    presentOnMain: true,
    presentInDeployed: true,
    evidence: "Hallmark `someExportedSymbol` is present in the live deployed artifact at commit `abc1234`.",
  };
}

function stallVerdict(): DeployVerdict {
  return {
    status: "stale-not-deployed",
    deployed: false,
    stall: true,
    hallmarkSymbol: "someExportedSymbol",
    runningCommit: "abc1234",
    presentOnMain: true,
    presentInDeployed: false,
    evidence:
      "/health reports running commit `abc1234`; hallmark `someExportedSymbol` is ABSENT from that deployed artifact (present on `origin/main`). Done ≠ deployed — the running service does not contain this fix.",
  };
}

function unverifiableVerdict(): DeployVerdict {
  return {
    status: "unverifiable",
    deployed: false,
    stall: false,
    hallmarkSymbol: null,
    runningCommit: null,
    presentOnMain: null,
    presentInDeployed: null,
    evidence: "No `hallmark:<symbol>` label — not flagged from ticket text (AC4).",
  };
}

/** Create a mock LinearApi with spies. */
function makeMockLinearApi(overrides?: Partial<LinearApi>): jest.Mocked<LinearApi> {
  return {
    fetchDoneTickets: jest.fn<LinearApi["fetchDoneTickets"]>().mockResolvedValue([]),
    applyLabel: jest.fn<LinearApi["applyLabel"]>().mockResolvedValue(true),
    postComment: jest.fn<LinearApi["postComment"]>().mockResolvedValue(true),
    createIssue: jest
      .fn<LinearApi["createIssue"]>()
      .mockResolvedValue({ id: "new-issue-id", identifier: "AI-9999" }),
    hasExistingComment: jest.fn<LinearApi["hasExistingComment"]>().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<LinearApi>;
}

/** Create a mock DeployVerdictApi (defaults to an all-clear "deployed" verdict). */
function makeMockDeployApi(verdict: DeployVerdict = deployedVerdict()): jest.Mocked<DeployVerdictApi> {
  return {
    verify: jest.fn<DeployVerdictApi["verify"]>().mockResolvedValue(verdict),
  } as jest.Mocked<DeployVerdictApi>;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DoneTicketDetector", () => {
  let detector: DoneTicketDetector;
  let mockLinear: jest.Mocked<LinearApi>;
  let mockDeploy: jest.Mocked<DeployVerdictApi>;
  let config: DoneTicketDetectorConfig;

  beforeEach(() => {
    config = { ...DEFAULT_CONFIG };
    mockLinear = makeMockLinearApi();
    mockDeploy = makeMockDeployApi();
  });

  afterEach(() => {
    detector?.stop();
  });

  // ── AC1: Done ticket sweep ────────────────────────────────────────────────

  describe("AC1 — Done ticket sweep", () => {
    it("queries Done tickets from the last N days on each cycle", async () => {
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([
        makeIssue({ identifier: "AI-1000" }),
        makeIssue({ identifier: "AI-1001" }),
      ]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(mockLinear.fetchDoneTickets).toHaveBeenCalledWith(14); // N=14 start
      expect(result.scanned).toBe(2);
    });

    it("returns scanned=0 when no Done tickets exist", async () => {
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.scanned).toBe(0);
      expect(result.flagged).toBe(0);
    });
  });

  // ── Live deploy verdict (supersedes AC2/AC7 ticket-ID string match) ────────

  describe("Live deploy verdict — code + /health, not ticket text", () => {
    it("does NOT flag when the fix is confirmed live in the deployed artifact", async () => {
      const ticket = makeIssue({ identifier: "AI-2576" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(deployedVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(mockDeploy.verify).toHaveBeenCalledWith({
        identifier: "AI-2576",
        labels: ticket.labels,
      });
      expect(result.flagged).toBe(0);
    });

    it("flags tickets whose fix is absent from the deployed artifact (STALL)", async () => {
      const ticket = makeIssue({ identifier: "AI-2576" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(mockDeploy.verify).toHaveBeenCalledWith({
        identifier: "AI-2576",
        labels: ticket.labels,
      });
      expect(result.flagged).toBe(1);
    });

    it("does NOT flag from ticket text when there is no live signal (unverifiable)", async () => {
      // AC4: a ticket with no hallmark label cannot be verified from live
      // signals — it must be skipped, never flagged from its Done label/title.
      const ticket = makeIssue({ identifier: "AI-2600", labels: [] });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(unverifiableVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.flagged).toBe(0);
      expect(result.skippedUnverifiable).toBe(1);
      expect(mockLinear.applyLabel).not.toHaveBeenCalled();
      expect(mockLinear.postComment).not.toHaveBeenCalled();
    });
  });

  // ── AC3: Flagging with label + comment quoting live evidence ──────────────

  describe("AC3 — Flagging with label + evidence-quoting comment", () => {
    it("applies needs-merge-verify label on a STALL verdict", async () => {
      const ticket = makeIssue({ identifier: "AI-2000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      await detector.runCycle();

      expect(mockLinear.applyLabel).toHaveBeenCalledWith(ticket.id, "needs-merge-verify");
    });

    it("posts a comment quoting the live evidence, not the ticket title", async () => {
      const ticket = makeIssue({
        identifier: "AI-2000",
        title: "Some human-written ticket title",
        doneAt: "2026-07-17T12:00:00Z",
      } as Partial<LinearIssue> & { identifier: string; title: string });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      await detector.runCycle();

      const actualBody = mockLinear.postComment.mock.calls[0][1];
      expect(actualBody).toContain("AI-2000");
      // Quotes the live evidence (running commit + hallmark), AC3.
      expect(actualBody).toContain("abc1234");
      expect(actualBody).toContain("someExportedSymbol");
      // Never quotes the ticket title as ground truth (AC4).
      expect(actualBody).not.toContain("Some human-written ticket title");
    });

    it("includes the Done timestamp in the flagging comment", async () => {
      const ticket = makeIssue({ identifier: "AI-2000", doneAt: "2026-07-17T14:30:00Z" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      await detector.runCycle();

      const actualBody = mockLinear.postComment.mock.calls[0][1];
      expect(actualBody).toContain("2026-07-17T14:30:00");
    });
  });

  // ── AC4: Skip labeled ─────────────────────────────────────────────────────

  describe("AC4 — Skip already-labeled tickets", () => {
    it("skips tickets that already have needs-merge-verify label", async () => {
      const ticket = makeIssue({
        identifier: "AI-3000",
        labels: ["needs-merge-verify"],
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.skippedLabeled).toBe(1);
      expect(result.flagged).toBe(0);
      expect(mockDeploy.verify).not.toHaveBeenCalled();
      expect(mockLinear.applyLabel).not.toHaveBeenCalled();
      expect(mockLinear.postComment).not.toHaveBeenCalled();
    });
  });

  // ── AC5: Skip unbranched ──────────────────────────────────────────────────

  describe("AC5 — Skip unbranched tickets", () => {
    it("skips tickets with no branch in the repo", async () => {
      const ticket = makeIssue({
        identifier: "AI-4000",
        hasBranch: false,
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.skippedUnbranched).toBe(1);
      expect(result.flagged).toBe(0);
      expect(mockDeploy.verify).not.toHaveBeenCalled();
      expect(mockLinear.applyLabel).not.toHaveBeenCalled();
    });
  });

  // ── AC6: Re-land creation ─────────────────────────────────────────────────

  describe("AC6 — Re-land ticket creation", () => {
    it("creates a new re-land ticket for missing fixes", async () => {
      const ticket = makeIssue({ identifier: "AI-5000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(mockLinear.createIssue).toHaveBeenCalledTimes(1);
      expect(mockLinear.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("re-land"),
          description: expect.stringContaining("AI-5000"),
          parentId: ticket.id,
        }),
      );
      expect(result.reLandCreated).toBe(1);
    });

    it("does NOT reopen the original ticket", async () => {
      const ticket = makeIssue({ identifier: "AI-5000" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      await detector.runCycle();

      const createCall = mockLinear.createIssue.mock.calls[0][0] as LinearCreateIssueInput;
      expect(createCall.title).toContain("re-land");
      expect(createCall.parentId).toBe(ticket.id); // linked as child, NOT reopened
      expect(mockLinear.applyLabel).toHaveBeenCalledWith(ticket.id, "needs-merge-verify");
    });

    it("skips re-land creation if createIssue returns null", async () => {
      const ticket = makeIssue({ identifier: "AI-5001" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);
      mockDeploy = makeMockDeployApi(stallVerdict());
      mockLinear.createIssue.mockResolvedValueOnce(null);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.reLandCreated).toBe(0);
      expect(result.flagged).toBe(1); // still flagged even if re-land fails
    });
  });

  // ── AC8: Advisory only ────────────────────────────────────────────────────

  describe("AC8 — Advisory only, never fail closed", () => {
    it("continues processing after a per-ticket error", async () => {
      const ticket1 = makeIssue({ identifier: "AI-7000" });
      const ticket2 = makeIssue({ identifier: "AI-7001" });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket1, ticket2]);

      // First ticket's verdict throws — error should be caught and logged.
      mockDeploy.verify
        .mockRejectedValueOnce(new Error("Deploy verify error on AI-7000"))
        .mockResolvedValueOnce(stallVerdict()); // AI-7001: stall → flagged

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.scanned).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("AI-7000");
      expect(result.flagged).toBe(1);
    });

    it("catches and logs top-level cycle errors", async () => {
      mockLinear.fetchDoneTickets.mockRejectedValueOnce(new Error("Linear API down"));

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Linear API down");
      expect(result.scanned).toBe(0);
    });

    it("never throws an unhandled exception from runCycle", async () => {
      mockLinear.fetchDoneTickets.mockRejectedValueOnce(new Error("Anything"));

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      await expect(detector.runCycle()).resolves.toBeDefined();
    });
  });

  // ── AC9: One comment per ticket ───────────────────────────────────────────

  describe("AC9 — One comment per ticket", () => {
    it("posts at most one note comment per flagged ticket across cycles", async () => {
      const ticket = makeIssue({ identifier: "AI-8000" });
      mockLinear.fetchDoneTickets.mockResolvedValue([ticket]); // always returns same ticket
      mockDeploy = makeMockDeployApi(stallVerdict()); // always a stall

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });

      const result1 = await detector.runCycle();
      expect(result1.flagged).toBe(1);
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1);

      const result2 = await detector.runCycle();
      expect(result2.flagged).toBe(0); // not re-flagged (already commented)
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // ── AC10: Bootstrap registration ──────────────────────────────────────────

  describe("AC10 — Bootstrap registration in periodic scheduler", () => {
    it("start() registers a periodic timer", () => {
      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });

      jest.useFakeTimers();
      detector.start();
      expect(detector).toBeDefined();
      jest.useRealTimers();
    });

    it("exposes start/stop lifecycle for scheduler co-location", () => {
      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      expect(typeof detector.start).toBe("function");
      expect(typeof detector.stop).toBe("function");
    });
  });

  // ── AC11: Liveness observability ──────────────────────────────────────────

  describe("AC11 — Liveness observability", () => {
    it("logs a startup confirmation when start() is called", () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      detector.start();

      const logCalls = consoleSpy.mock.calls.map((c) => c.join(" "));
      const hasStartupLog = logCalls.some(
        (msg) =>
          msg.includes("done-ticket-detector") &&
          msg.includes("started") &&
          msg.includes("lookbackDays=14") &&
          msg.includes("graceHours=4"),
      );
      expect(hasStartupLog).toBe(true);

      consoleSpy.mockRestore();
      detector.stop();
    });
  });

  // ── Integration: mixed scenario ───────────────────────────────────────────

  describe("Integration — mixed scenario", () => {
    it("processes a mix of deployed, stalled, labeled, and unbranched tickets", async () => {
      const deployed = makeIssue({ identifier: "AI-100" }); // live → no flag
      const stalled = makeIssue({ identifier: "AI-101" }); // absent from deploy → flag
      const labeled = makeIssue({
        identifier: "AI-102",
        labels: ["needs-merge-verify"],
      }); // already labeled → skip
      const noBranch = makeIssue({
        identifier: "AI-103",
        hasBranch: false,
      }); // no branch → skip

      mockLinear.fetchDoneTickets.mockResolvedValueOnce([deployed, stalled, labeled, noBranch]);
      mockDeploy.verify.mockImplementation(async ({ identifier }) =>
        identifier === "AI-100" ? deployedVerdict() : stallVerdict(),
      );

      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      const result = await detector.runCycle();

      expect(result.scanned).toBe(4);
      expect(result.skippedLabeled).toBe(1);
      expect(result.skippedUnbranched).toBe(1);
      expect(result.flagged).toBe(1); // only AI-101 flagged
      expect(mockLinear.applyLabel).toHaveBeenCalledTimes(1);
      expect(mockLinear.postComment).toHaveBeenCalledTimes(1);
      expect(mockLinear.createIssue).toHaveBeenCalledTimes(1);
    });
  });

  // ── INF-1099 regression: Done-but-not-deployed → STALL, end to end ────────

  describe("INF-1099 regression — Done ≠ deployed via real verdict logic", () => {
    it("a Done-labelled ticket whose fix is present on main but ABSENT from the deployed /health commit yields a STALL, not an all-clear", async () => {
      // Real DeployVerdictApi wired to fake live signals: the hallmark is on
      // origin/main but NOT in the deployed commit the running service reports.
      const HALLMARK = "inf1099LiveHealthVerdict";
      const DEPLOYED_COMMIT = "deadbee"; // an older commit missing the fix
      const symbolPresentAt = (symbol: string, ref: string): CodePresence => {
        if (symbol !== HALLMARK) return null;
        if (ref === "origin/main") return true; // merged
        if (ref === DEPLOYED_COMMIT) return false; // but not in the running artifact
        return null;
      };
      const deploy = makeDeployVerdictApi({
        symbolPresentAt,
        fetchHealthCommit: async () => DEPLOYED_COMMIT,
      });

      const ticket = makeIssue({
        identifier: "INF-1099",
        labels: [`hallmark:${HALLMARK}`],
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy, config });
      const result = await detector.runCycle();

      expect(result.flagged).toBe(1); // STALL, NOT an all-clear
      const body = mockLinear.postComment.mock.calls[0][1];
      expect(body).toContain(DEPLOYED_COMMIT); // quotes the live running commit
      expect(body).toContain(HALLMARK); // quotes the hallmark symbol
      expect(body).toContain("Done ≠ deployed");
    });

    it("all-clear when the hallmark IS present in the deployed /health commit", async () => {
      const HALLMARK = "inf1099LiveHealthVerdict";
      const DEPLOYED_COMMIT = "cafef00";
      const deploy = makeDeployVerdictApi({
        symbolPresentAt: (symbol, ref) =>
          symbol === HALLMARK && (ref === "origin/main" || ref === DEPLOYED_COMMIT) ? true : null,
        fetchHealthCommit: async () => DEPLOYED_COMMIT,
      });

      const ticket = makeIssue({
        identifier: "INF-1099b",
        labels: [`hallmark:${HALLMARK}`],
      });
      mockLinear.fetchDoneTickets.mockResolvedValueOnce([ticket]);

      detector = new DoneTicketDetector({ linear: mockLinear, deploy, config });
      const result = await detector.runCycle();

      expect(result.flagged).toBe(0); // deployed → no flag
      expect(mockLinear.postComment).not.toHaveBeenCalled();
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  describe("Lifecycle", () => {
    it("is idempotent — calling start() twice does not double-register", () => {
      jest.useFakeTimers();
      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      detector.start();
      detector.start(); // second call should be no-op

      expect(jest.getTimerCount()).toBe(1);
      jest.useRealTimers();
    });

    it("stop() clears the timer", () => {
      jest.useFakeTimers();
      detector = new DoneTicketDetector({ linear: mockLinear, deploy: mockDeploy, config });
      detector.start();
      detector.stop();

      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
    });
  });
});
