/**
 * Tests for DelegatePingPongDetector (INF-218).
 *
 * Covers the delegate ping-pong cycle detection + escalation ladder pattern.
 * The detector should:
 *   - Track the delegate chain for a ticket
 *   - Detect when the same delegate appears ≥ N times within a window (cycle)
 *   - Fire escalation to steward (Ai) on cycle detection instead of bouncing
 *   - Emit structured log + operational event on cycle detection
 *   - NOT trip on a normal single handoff
 *
 * Integration test:
 *   - Simulated ping-pong reaches threshold → detection + escalation fire
 *   - Normal single handoff does not trip detection
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  DelegateChainTracker,
  DelegatePingPongDetector,
  defaultLegalWorkflowTargetResolver,
  fireEscalation,
  shouldCheckDelegatePingPong,
  type DelegatePingPongConfig,
  type DelegateAssignment,
  type CycleDetectionResult,
  type EscalationResult,
  type PingPongHandlingResult,
} from "./delegate-ping-pong-detector.js";
import { OperationalEventStore } from "./store/operational-event-store.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ping-pong-test-"));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAssignment(
  ticketId: string,
  delegateId: string,
  agentName: string,
  timestampMs: number,
): DelegateAssignment {
  return {
    ticketId,
    delegateId,
    agentName,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
  };
}

describe("shouldCheckDelegatePingPong", () => {
  test("checks delegate-only updates", () => {
    expect(shouldCheckDelegatePingPong({ delegateId: "old-user" })).toBe(true);
    expect(shouldCheckDelegatePingPong({ delegate: { id: "old-user" } })).toBe(true);
  });

  test("skips workflow transitions that change delegate and state together", () => {
    expect(shouldCheckDelegatePingPong({ delegateId: "old-user", stateId: "old-state" })).toBe(false);
    expect(shouldCheckDelegatePingPong({ delegate: { id: "old-user" }, state: { name: "Review" } })).toBe(false);
  });

  test("ignores updates without delegate changes", () => {
    expect(shouldCheckDelegatePingPong({ stateId: "old-state" })).toBe(false);
    expect(shouldCheckDelegatePingPong(undefined)).toBe(false);
  });
});

describe("Linear escalation mutation", () => {
  test("uses Linear's String issueId type for commentCreate", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/delegate-ping-pong-detector.ts"), "utf8");
    expect(source).toContain("mutation($issueId: String!, $body: String!)");
    expect(source).not.toContain("mutation($issueId: ID!, $body: String!)");
  });
});

// ── Tests: DelegateChainTracker ──────────────────────────────────────────────

describe("DelegateChainTracker", () => {
  let tracker: DelegateChainTracker;

  beforeEach(() => {
    tracker = new DelegateChainTracker();
  });

  describe("recordAssignment and getChain", () => {
    test("records assignments and returns chain in order", () => {
      const now = Date.now();
      tracker.recordAssignment("INF-218", "user-a", "agent-a", now);
      tracker.recordAssignment("INF-218", "user-b", "agent-b", now + 1000);
      tracker.recordAssignment("INF-218", "user-c", "agent-c", now + 2000);

      const chain = tracker.getChain("INF-218");
      expect(chain).toHaveLength(3);
      expect(chain[0].delegateId).toBe("user-a");
      expect(chain[1].delegateId).toBe("user-b");
      expect(chain[2].delegateId).toBe("user-c");
    });

    test("maintains separate chains per ticket", () => {
      const now = Date.now();
      tracker.recordAssignment("INF-218", "user-a", "agent-a", now);
      tracker.recordAssignment("INF-210", "user-x", "agent-x", now);

      expect(tracker.getChain("INF-218")).toHaveLength(1);
      expect(tracker.getChain("INF-210")).toHaveLength(1);
      expect(tracker.getChain("INF-218")[0].delegateId).toBe("user-a");
      expect(tracker.getChain("INF-210")[0].delegateId).toBe("user-x");
    });

    test("empty chain returns empty array", () => {
      expect(tracker.getChain("NONEXISTENT")).toEqual([]);
    });
  });

  describe("detectCycle", () => {
    test("detects cycle when same delegate appears >= N times (default N=3)", () => {
      const now = Date.now();
      const ticketId = "GEN-263";
      // Chain: A → B → C → A → B → A  (A appears 3 times)
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now);
      tracker.recordAssignment(ticketId, "user-ai", "Ai", now + 1000);
      tracker.recordAssignment(ticketId, "user-charles", "Charles", now + 2000);
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now + 3000);
      tracker.recordAssignment(ticketId, "user-ai", "Ai", now + 4000);
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now + 5000);

      const result = tracker.detectCycle(ticketId, now + 6000);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclingDelegates).toContain("user-hanzo");
      expect(result.bounceCounts["user-hanzo"]).toBe(3);
      expect(result.maxAllowed).toBe(3);
    });

    test("does NOT detect cycle when below threshold (N=3 default, 2 appearances)", () => {
      const now = Date.now();
      const ticketId = "GEN-263";
      // Chain: A → B → C → A → B  (A appears 2 times, B appears 2 times)
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now);
      tracker.recordAssignment(ticketId, "user-ai", "Ai", now + 1000);
      tracker.recordAssignment(ticketId, "user-charles", "Charles", now + 2000);
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now + 3000);
      tracker.recordAssignment(ticketId, "user-ai", "Ai", now + 4000);

      const result = tracker.detectCycle(ticketId, now + 5000);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclingDelegates).toHaveLength(0);
    });

    test("normal single handoff does not trip detection", () => {
      const now = Date.now();
      const ticketId = "GEN-263";
      // Single handoff: A → B
      tracker.recordAssignment(ticketId, "user-hanzo", "Hanzo", now);
      tracker.recordAssignment(ticketId, "user-ai", "Ai", now + 1000);

      const result = tracker.detectCycle(ticketId, now + 2000);
      expect(result.hasCycle).toBe(false);
      expect(result.cyclingDelegates).toHaveLength(0);
    });

    test("custom maxBounces threshold is respected", () => {
      const tracker2 = new DelegateChainTracker({ maxBounces: 2, windowMs: 60000 });
      const now = Date.now();
      const ticketId = "GEN-263";
      // Chain: A → B → A  (A appears 2 times, threshold=2 → cycle)
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now);
      tracker2.recordAssignment(ticketId, "user-ai", "Ai", now + 1000);
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now + 2000);

      const result = tracker2.detectCycle(ticketId, now + 3000);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclingDelegates).toContain("user-hanzo");
      expect(result.maxAllowed).toBe(2);
    });

    test("prunes entries outside the window", () => {
      const tracker2 = new DelegateChainTracker({ maxBounces: 2, windowMs: 5000 }); // 5s window
      const now = 1000000;
      const ticketId = "GEN-263";
      // Older than window
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now - 10000);
      tracker2.recordAssignment(ticketId, "user-ai", "Ai", now - 9000);
      // Within window
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now - 1000);

      const result = tracker2.detectCycle(ticketId, now);
      // Only 1 entry within window (the third), so even with maxBounces=2, no cycle
      expect(result.hasCycle).toBe(false);
      expect(result.chain).toHaveLength(1);
    });

    test("detects multiple cycling delegates", () => {
      const tracker2 = new DelegateChainTracker({ maxBounces: 2, windowMs: 60000 });
      const now = Date.now();
      const ticketId = "GEN-263";
      // Chain: A → B → A → B (both A and B appear 2 times)
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now);
      tracker2.recordAssignment(ticketId, "user-ai", "Ai", now + 1000);
      tracker2.recordAssignment(ticketId, "user-hanzo", "Hanzo", now + 2000);
      tracker2.recordAssignment(ticketId, "user-ai", "Ai", now + 3000);

      const result = tracker2.detectCycle(ticketId, now + 4000);
      expect(result.hasCycle).toBe(true);
      expect(result.cyclingDelegates).toHaveLength(2);
      expect(result.cyclingDelegates).toContain("user-hanzo");
      expect(result.cyclingDelegates).toContain("user-ai");
    });
  });

  describe("clearTicket and clearAll", () => {
    test("clearTicket removes chain for specific ticket", () => {
      const now = Date.now();
      tracker.recordAssignment("INF-218", "user-a", "agent-a", now);
      tracker.recordAssignment("INF-210", "user-b", "agent-b", now);

      tracker.clearTicket("INF-218");
      expect(tracker.getChain("INF-218")).toHaveLength(0);
      expect(tracker.getChain("INF-210")).toHaveLength(1);
    });

    test("clearAll removes all chains", () => {
      const now = Date.now();
      tracker.recordAssignment("INF-218", "user-a", "agent-a", now);
      tracker.recordAssignment("INF-210", "user-b", "agent-b", now);

      tracker.clearAll();
      expect(tracker.getChain("INF-218")).toHaveLength(0);
      expect(tracker.getChain("INF-210")).toHaveLength(0);
    });
  });
});

// ── Tests: fireEscalation ────────────────────────────────────────────────────

describe("fireEscalation", () => {
  // fireEscalation calls Linear's GraphQL API which is not available in tests.
  // We test that it returns the expected fallback when no auth token is available.

  test("returns not-fired when no auth token is available", async () => {
    // Save and clear env tokens
    const savedToken = process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_OAUTH_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    try {
      const result = await fireEscalation("GEN-263", ["user-hanzo"], 3);
      expect(result.fired).toBe(false);
      expect(result.ticketId).toBe("GEN-263");
      expect(result.bounceCount).toBe(3);
      expect(result.escalatedTo).toBe("ai");
    } finally {
      // Restore
      if (savedToken) process.env.LINEAR_OAUTH_TOKEN = savedToken;
      if (savedKey) process.env.LINEAR_API_KEY = savedKey;
    }
  });
});

// ── Tests: DelegatePingPongDetector (high-level) ─────────────────────────────

describe("DelegatePingPongDetector", () => {
  describe("checkAndHandle", () => {
    test("returns suppressDispatch=false for a normal first assignment (no cycle)", async () => {
      const detector = new DelegatePingPongDetector();
      const now = Date.now();

      const result = await detector.checkAndHandle("GEN-263", "user-ai", "Ai", now);

      expect(result.checked).toBe(true);
      expect(result.detection).not.toBeNull();
      expect(result.detection!.hasCycle).toBe(false);
      expect(result.escalation).toBeNull();
      expect(result.suppressDispatch).toBe(false);
    });

    test("starts suppressing dispatch when cycle threshold is reached", async () => {
      const config: Partial<DelegatePingPongConfig> = { maxBounces: 2, windowMs: 60000 };
      const tracker = new DelegateChainTracker(config);
      const detector = new DelegatePingPongDetector(tracker, config);

      const now = Date.now();
      const ticketId = "GEN-263";

      // First assignment — normal
      const r1 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now);
      expect(r1.suppressDispatch).toBe(false);

      // Second — different delegate, normal
      const r2 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", now + 1000);
      expect(r2.suppressDispatch).toBe(false);

      // Third — back to hanzo, threshold reached (maxBounces=2, hanzo appears twice)
      const r3 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now + 2000);
      expect(r3.suppressDispatch).toBe(true);
      expect(r3.detection!.hasCycle).toBe(true);
      expect(r3.detection!.cyclingDelegates).toContain("user-hanzo");
    });

    test("single handoff between two delegates never trips cycle", async () => {
      const tracker = new DelegateChainTracker();
      const detector = new DelegatePingPongDetector(tracker);

      const now = Date.now();
      const ticketId = "GEN-263";

      // A → B — normal single handoff
      const r1 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now);
      const r2 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", now + 1000);

      expect(r1.suppressDispatch).toBe(false);
      expect(r2.suppressDispatch).toBe(false);

      // Confirm no cycle detection
      const detectionAfter = tracker.detectCycle(ticketId, now + 2000);
      expect(detectionAfter.hasCycle).toBe(false);
    });

    test("records operational event on cycle detection", async () => {
      const dir = tempDir();
      const config: Partial<DelegatePingPongConfig> = { maxBounces: 2, windowMs: 60000 };
      const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
      const tracker = new DelegateChainTracker(config);
      const detector = new DelegatePingPongDetector(tracker, config, eventStore);

      const now = Date.now();
      const ticketId = "GEN-263";

      await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now);
      await detector.checkAndHandle(ticketId, "user-ai", "Ai", now + 1000);
      await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now + 2000);

      // Read events back
      const events = eventStore.query({ key: ticketId });
      const cycleEvents = events.filter((e: { outcome: string }) => e.outcome === "ping-pong-cycle-detected");
      expect(cycleEvents.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test("multiple tickets maintain independent chains", async () => {
      const config: Partial<DelegatePingPongConfig> = { maxBounces: 2, windowMs: 60000 };
      const tracker = new DelegateChainTracker(config);
      const detector = new DelegatePingPongDetector(tracker, config);

      const now = Date.now();

      // Ticket A: single handoff — no cycle
      await detector.checkAndHandle("INF-217", "user-a", "agent-a", now);
      await detector.checkAndHandle("INF-217", "user-b", "agent-b", now + 1000);

      // Ticket B: ping-pong — cycle detected
      await detector.checkAndHandle("INF-218", "user-hanzo", "Hanzo", now);
      await detector.checkAndHandle("INF-218", "user-ai", "Ai", now + 1000);
      await detector.checkAndHandle("INF-218", "user-hanzo", "Hanzo", now + 2000);

      // Ticket A should not have a cycle
      expect(tracker.detectCycle("INF-217", now + 3000).hasCycle).toBe(false);

      // Ticket B should have a cycle
      expect(tracker.detectCycle("INF-218", now + 3000).hasCycle).toBe(true);
    });
  });
});

describe("INF-661 - legal workflow targets are not ping-pong suppressed", () => {
  const TASK_POLICY_YAML = `
capabilities:
  - id: linear:transition
containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition]
roles:
  - id: requester
    requires: [linear:transition]
  - id: department-head
    requires: [linear:transition]
  - id: worker
    requires: [linear:transition]
bodies:
  - id: ai
    openclaw_agent: ai
    container: steward
    fills_roles: [requester]
  - id: astrid
    openclaw_agent: astrid
    container: steward
    fills_roles: [department-head]
  - id: igor
    openclaw_agent: igor
    container: dev
    fills_roles: [worker]
`;

  let dir: string;
  let oldWorkflowDefPath: string | undefined;
  let oldWorkflowDefsDir: string | undefined;
  let oldCapabilityPolicyPath: string | undefined;

  beforeEach(() => {
    dir = tempDir();
    const defsDir = path.join(dir, "defs");
    fs.mkdirSync(defsDir);
    oldWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    oldWorkflowDefsDir = process.env.WORKFLOW_DEFS_DIR;
    oldCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    fs.copyFileSync(
      path.join(process.cwd(), "src/__fixtures__/canonical-task.yaml"),
      path.join(defsDir, "task.yaml"),
    );
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), TASK_POLICY_YAML);
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    process.env.WORKFLOW_DEF_PATH = path.join(defsDir, "task.yaml");
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    resetWorkflowCache();
    resetPolicyCache();
  });

  afterEach(() => {
    if (oldWorkflowDefPath === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = oldWorkflowDefPath;
    if (oldWorkflowDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = oldWorkflowDefsDir;
    if (oldCapabilityPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = oldCapabilityPolicyPath;
    resetWorkflowCache();
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("INF-604 recovery sequence allows requester, department head, worker, and reviewer legal owners", async () => {
    const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60_000 };
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const detector = new DelegatePingPongDetector(
      new DelegateChainTracker(config),
      config,
      eventStore,
      () => false,
      defaultLegalWorkflowTargetResolver,
    );
    const t = 5_000_000;
    const ticketId = "INF-604";

    const intake1 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", t, ["wf:task", "state:intake"]);
    const routing1 = await detector.checkAndHandle(ticketId, "user-astrid", "Astrid", t + 1_000, ["wf:task", "state:routing"]);
    const doing1 = await detector.checkAndHandle(ticketId, "user-igor", "Igor", t + 2_000, ["wf:task", "state:doing"]);
    const intake2 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", t + 3_000, ["wf:task", "state:intake"]);
    const routing2 = await detector.checkAndHandle(ticketId, "user-astrid", "Astrid", t + 4_000, ["wf:task", "state:routing"]);
    const doing2 = await detector.checkAndHandle(ticketId, "user-igor", "Igor", t + 5_000, ["wf:task", "state:doing"]);
    const intake3 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", t + 6_000, ["wf:task", "state:intake"]);
    const review = await detector.checkAndHandle(ticketId, "user-astrid", "Astrid", t + 7_000, ["wf:task", "state:review"]);

    for (const result of [intake1, routing1, doing1, intake2, routing2, doing2, intake3, review]) {
      expect(result.suppressDispatch).toBe(false);
      expect(result.escalation).toBeNull();
    }

    expect(intake3.detection!.hasCycle).toBe(true);
    expect(review.detection!.hasCycle).toBe(true);
    const events = eventStore.query({ key: ticketId });
    expect(events.some((e: { outcome: string; agent?: string | null }) =>
      e.outcome === "ping-pong-exempt-legal-workflow-target" && e.agent === "Astrid",
    )).toBe(true);
    expect(events.some((e: { outcome: string }) => e.outcome === "ping-pong-cycle-detected")).toBe(false);
  });
});

// ── Integration test ─────────────────────────────────────────────────────────

describe("Integration: simulated ping-pong", () => {
  test("simulated ping-pong reaches threshold → detection + escalation fires", async () => {
    const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60000 };
    const dir = tempDir();
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, eventStore);

    const now = Date.now();
    const ticketId = "GEN-263";

    // Simulate the exact pattern from INF-195:
    // 1. Hanzo diagnoses blocked → ticket delegated to Hanzo
    const r1 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now);
    expect(r1.suppressDispatch).toBe(false);

    // 2. Hanzo escalates to Ai (normal handoff)
    const r2 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", now + 1000);
    expect(r2.suppressDispatch).toBe(false);

    // 3. Ai re-delegates back to Hanzo (first bounce)
    const r3 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now + 2000);
    expect(r3.suppressDispatch).toBe(false); // Hanzo: 2 appearances, threshold=3

    // 4. Hanzo escalates to Ai again (second handoff from Hanzo's perspective)
    const r4 = await detector.checkAndHandle(ticketId, "user-ai", "Ai", now + 3000);
    expect(r4.suppressDispatch).toBe(false);

    // 5. Ai re-delegates to Hanzo again (second bounce — cycle threshold reached)
    // Hanzo now appears 3 times → cycle detected → escalation → suppress dispatch
    const r5 = await detector.checkAndHandle(ticketId, "user-hanzo", "Hanzo", now + 4000);
    expect(r5.suppressDispatch).toBe(true);
    expect(r5.detection!.hasCycle).toBe(true);
    expect(r5.detection!.cyclingDelegates).toContain("user-hanzo");
    expect(r5.detection!.bounceCounts["user-hanzo"]).toBe(3);

    // Verify operational events reflect the cycle detection
    const events = eventStore.query({ key: ticketId });
    const cycleEvents = events.filter((e: { outcome: string }) => e.outcome === "ping-pong-cycle-detected");
    expect(cycleEvents.length).toBeGreaterThanOrEqual(1);
    const firstCycleEvent = cycleEvents[0] as { detail?: { ticketId?: string; cyclingDelegates?: string[]; escalationFired?: boolean } };
    expect(firstCycleEvent.detail?.ticketId).toBe(ticketId);
    expect(firstCycleEvent.detail?.cyclingDelegates).toContain("user-hanzo");

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("normal single handoff between two delegates never trips detection", async () => {
    const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60000 };
    const dir = tempDir();
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, eventStore);

    const now = Date.now();
    const ticketId = "AI-101";

    // Normal handoff: Steward → Igor (intake → implementation)
    await detector.checkAndHandle(ticketId, "user-steward", "Steward", now);
    await detector.checkAndHandle(ticketId, "user-igor", "Igor", now + 1000);

    // Verify no cycle
    const detection = tracker.detectCycle(ticketId, now + 2000);
    expect(detection.hasCycle).toBe(false);

    // Verify no cycle events in operational store
    const events = eventStore.query({ key: ticketId });
    const cycleEvents = events.filter((e: { outcome: string }) => e.outcome === "ping-pong-cycle-detected");
    expect(cycleEvents).toHaveLength(0);

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
