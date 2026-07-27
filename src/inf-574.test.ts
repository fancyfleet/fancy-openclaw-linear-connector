/**
 * INF-574 — Merge-PR tickets unroutable to merge-gate role + correct route trips
 * the ping-pong guard (INF-573 repro).
 *
 * Product disposition (Astrid): implement option 2 (whitelist the merge-gate
 * role as a non-oscillation terminal target) plus the option-3 consistency check
 * (workflow membership is one source of truth: the wf:* label projection).
 *
 * Acceptance criteria:
 *  AC1 — Repro from INF-573: a window that has already cycled some delegate (the
 *        steward, from repeated intake bounces) must NOT suppress the first clean
 *        dispatch to the merge-gate owner (Hanzo). It dispatches.
 *  AC2 — Regression: ordinary real ping-pong (target is NOT the merge-gate owner)
 *        still suppresses repeated oscillation.
 *  AC3 — Workflow-membership detection uses one source of truth (getWorkflowId of
 *        the labels) for both the demote label-check and the state-role gate;
 *        neither derives membership from the applied-state store or native state.
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  DelegateChainTracker,
  DelegatePingPongDetector,
  defaultExemptTerminalTargetResolver,
  type DelegatePingPongConfig,
  type ExemptTerminalTargetResolver,
} from "./delegate-ping-pong-detector.js";
import { resetPolicyCache, resolveAgentIdentifiersForRole } from "./escalation-gate.js";
import { getWorkflowId } from "./workflow-gate.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-574-test-"));
}

/** Test resolver: the merge-gate owner is Hanzo; everyone else is non-terminal. */
const hanzoIsExempt: ExemptTerminalTargetResolver = (agentName) =>
  agentName.toLowerCase() === "hanzo";

// ── AC1: the correct route to the merge-gate owner is not ping-pong suppressed ─

describe("INF-574 AC1 — merge-gate dispatch survives a cycled window (INF-573 repro)", () => {
  const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60 * 60 * 1000 };

  /**
   * Build the INF-573 shape: the steward (Ai) cycles 3× as the ticket bounces at
   * intake, then the repaired ticket is handed to the merge-gate owner (Hanzo).
   * Returns the detector, event store, and the result of the final Hanzo dispatch.
   */
  async function runReproWithResolver(resolver: ExemptTerminalTargetResolver | undefined, dir: string) {
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, eventStore, resolver);
    const t = 1_000_000;
    const id = "INF-573";

    // Repeated intake ping-pong cycles the steward Ai (3 appearances).
    await detector.checkAndHandle(id, "user-ai", "Ai", t);
    await detector.checkAndHandle(id, "user-astrid", "Astrid", t + 1_000);
    await detector.checkAndHandle(id, "user-ai", "Ai", t + 2_000);
    await detector.checkAndHandle(id, "user-astrid", "Astrid", t + 3_000);
    const aiCycle = await detector.checkAndHandle(id, "user-ai", "Ai", t + 4_000);
    // The window is now cycling on Ai.
    expect(aiCycle.detection!.hasCycle).toBe(true);

    // The repair: a clean handoff to the merge-gate owner Hanzo.
    const hanzo = await detector.checkAndHandle(id, "user-hanzo", "Hanzo", t + 5_000);
    return { detector, eventStore, hanzo };
  }

  test("with the merge-gate exemption, the Hanzo dispatch is allowed through", async () => {
    const dir = tempDir();
    try {
      const { hanzo, eventStore } = await runReproWithResolver(hanzoIsExempt, dir);

      // The window is still cycling (Ai), but the target is the terminal merge-gate owner.
      expect(hanzo.detection!.hasCycle).toBe(true);
      expect(hanzo.suppressDispatch).toBe(false);
      expect(hanzo.escalation).toBeNull();

      // Observability: the exemption is recorded, and NO suppression/escalation event fired for it.
      const events = eventStore.query({ key: "INF-573" });
      const exemptEvents = events.filter((e: { outcome: string }) => e.outcome === "ping-pong-exempt-terminal-target");
      expect(exemptEvents.length).toBeGreaterThanOrEqual(1);
      const detail = (exemptEvents[exemptEvents.length - 1] as { detail?: { target?: string } }).detail;
      expect(detail?.target).toBe("Hanzo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RED BASELINE: without the exemption the same Hanzo dispatch is wrongly suppressed", async () => {
    // A resolver that exempts nobody reproduces the pre-fix behavior. This proves
    // the fix — not the harness — is what lets the correct route through.
    const exemptNobody: ExemptTerminalTargetResolver = () => false;
    const dir = tempDir();
    try {
      const { hanzo } = await runReproWithResolver(exemptNobody, dir);
      expect(hanzo.detection!.hasCycle).toBe(true);
      expect(hanzo.suppressDispatch).toBe(true); // the INF-573 bug
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC2: ordinary ping-pong still suppresses ──────────────────────────────────

describe("INF-574 AC2 — real oscillation to a non-terminal target still suppresses", () => {
  const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60 * 60 * 1000 };

  test("a cycled window whose final target is NOT the merge-gate owner suppresses", async () => {
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, undefined, hanzoIsExempt);
    const t = 2_000_000;
    const id = "AI-999";

    // Genuine Ai↔Igor oscillation: Igor returns after Ai three times.
    await detector.checkAndHandle(id, "user-ai", "Ai", t);
    await detector.checkAndHandle(id, "user-igor", "Igor", t + 1_000);
    await detector.checkAndHandle(id, "user-ai", "Ai", t + 2_000);
    await detector.checkAndHandle(id, "user-igor", "Igor", t + 3_000);
    await detector.checkAndHandle(id, "user-ai", "Ai", t + 4_000);
    // Sixth assignment: Igor now bounces 3× → cycle, and Igor is NOT exempt.
    const r = await detector.checkAndHandle(id, "user-igor", "Igor", t + 5_000);

    expect(r.detection!.hasCycle).toBe(true);
    expect(r.suppressDispatch).toBe(true);
    expect(r.detection!.cyclingDelegates).toContain("user-igor");
  });

  test("the exemption does not weaken protection for a genuine Ai⇄Igor loop", async () => {
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, undefined, hanzoIsExempt);
    const t = 3_000_000;
    const id = "AI-1000";

    // A⇄B oscillation, neither is the merge-gate owner. Ai returns after Igor
    // three times (A→B→A→B→A) → genuine cycle.
    await detector.checkAndHandle(id, "user-ai", "Ai", t);
    await detector.checkAndHandle(id, "user-igor", "Igor", t + 1_000);
    await detector.checkAndHandle(id, "user-ai", "Ai", t + 2_000);
    await detector.checkAndHandle(id, "user-igor", "Igor", t + 3_000);
    const r = await detector.checkAndHandle(id, "user-ai", "Ai", t + 4_000); // Ai bounces 3× → suppress

    expect(r.suppressDispatch).toBe(true);
  });
});

// ── AC2 (root cause): detectCycle counts bounces, not raw occurrences ─────────

describe("INF-574 — detectCycle requires oscillation, not bare occurrence count", () => {
  test("consecutive re-assignments of ONE delegate are not a cycle (A→A→A)", () => {
    // Duplicate delegate-change webhooks / repeated re-pokes of the same agent
    // are forward-not-oscillation and must not be suppressed as ping-pong.
    const tracker = new DelegateChainTracker({ maxBounces: 3, windowMs: 60_000 });
    const t = 4_000_000;
    tracker.recordAssignment("AI-1", "user-igor", "Igor", t);
    tracker.recordAssignment("AI-1", "user-igor", "Igor", t + 1_000);
    tracker.recordAssignment("AI-1", "user-igor", "Igor", t + 2_000);

    const r = tracker.detectCycle("AI-1", t + 3_000);
    expect(r.hasCycle).toBe(false);
    expect(r.bounceCounts["user-igor"]).toBe(1); // three occurrences collapse to one bounce
  });

  test("a monotonic forward chain of distinct delegates is not a cycle", () => {
    // The FM2 shape Astrid flagged: astrid→igor→…→hanzo lands on the terminal
    // owner on hop 3 without any delegate returning.
    const tracker = new DelegateChainTracker({ maxBounces: 3, windowMs: 60_000 });
    const t = 4_100_000;
    tracker.recordAssignment("AI-2", "user-astrid", "Astrid", t);
    tracker.recordAssignment("AI-2", "user-igor", "Igor", t + 1_000);
    tracker.recordAssignment("AI-2", "user-hanzo", "Hanzo", t + 2_000);

    expect(tracker.detectCycle("AI-2", t + 3_000).hasCycle).toBe(false);
  });

  test("genuine A↔B oscillation is still detected (protection intact)", () => {
    const tracker = new DelegateChainTracker({ maxBounces: 3, windowMs: 60_000 });
    const t = 4_200_000;
    // A→B→A→B→A: A returns twice after B → 3 bounces.
    tracker.recordAssignment("AI-3", "user-ai", "Ai", t);
    tracker.recordAssignment("AI-3", "user-igor", "Igor", t + 1_000);
    tracker.recordAssignment("AI-3", "user-ai", "Ai", t + 2_000);
    tracker.recordAssignment("AI-3", "user-igor", "Igor", t + 3_000);
    tracker.recordAssignment("AI-3", "user-ai", "Ai", t + 4_000);

    const r = tracker.detectCycle("AI-3", t + 5_000);
    expect(r.hasCycle).toBe(true);
    expect(r.cyclingDelegates).toContain("user-ai");
    expect(r.bounceCounts["user-ai"]).toBe(3);
  });
});

// ── AC1/AC2 support: the default resolver identifies the merge-gate owner ──────

describe("INF-574 — default exempt-target resolver (capability policy)", () => {
  // The policy is written to a temp file rather than committed under
  // src/__fixtures__/ — that directory is enumerated wholesale by
  // fixture-drift-reconciliation.test.ts and validated as canonical workflow
  // defs, so a capability-policy YAML dropped there would fail that suite.
  const POLICY_YAML = [
    "roles:",
    "  - id: deployment",
    "    requires: [deploy:execute]",
    "    exclusive: true",
    "  - id: dev-backend",
    "    requires: []",
    "containers:",
    "  - id: deployment-container",
    "    grants: [deploy:execute]",
    "  - id: dev-backend-container",
    "    grants: []",
    "capabilities:",
    "  - id: deploy:execute",
    "    exclusive: true",
    "bodies:",
    "  - id: hanzo",
    "    openclaw_agent: hanzo",
    "    container: deployment-container",
    "    fills_roles: [deployment]",
    "  - id: igor",
    "    openclaw_agent: igor",
    "    container: dev-backend-container",
    "    fills_roles: [dev-backend]",
    "",
  ].join("\n");

  let dir: string;
  let fixture: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = tempDir();
    fixture = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(fixture, POLICY_YAML, "utf8");
    savedPath = process.env.CAPABILITY_POLICY_PATH;
    process.env.CAPABILITY_POLICY_PATH = fixture;
    delete process.env.PING_PONG_EXEMPT_ROLES;
    resetPolicyCache();
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = savedPath;
    resetPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolveAgentIdentifiersForRole('deployment') yields Hanzo (id + alias) only", async () => {
    const ids = await resolveAgentIdentifiersForRole("deployment");
    expect(ids.has("hanzo")).toBe(true);
    expect(ids.has("igor")).toBe(false);
  });

  test("the merge-gate owner is exempt; a backend dev is not", async () => {
    await expect(defaultExemptTerminalTargetResolver("hanzo", "user-hanzo")).resolves.toBe(true);
    await expect(defaultExemptTerminalTargetResolver("Hanzo", "user-hanzo")).resolves.toBe(true); // case-insensitive
    await expect(defaultExemptTerminalTargetResolver("igor", "user-igor")).resolves.toBe(false);
  });

  test("PING_PONG_EXEMPT_ROLES overrides which role is treated as terminal", async () => {
    process.env.PING_PONG_EXEMPT_ROLES = "dev-backend";
    resetPolicyCache();
    await expect(defaultExemptTerminalTargetResolver("igor", "user-igor")).resolves.toBe(true);
    await expect(defaultExemptTerminalTargetResolver("hanzo", "user-hanzo")).resolves.toBe(false);
    delete process.env.PING_PONG_EXEMPT_ROLES;
  });

  test("fails CLOSED to non-exempt when the policy cannot be resolved", async () => {
    process.env.CAPABILITY_POLICY_PATH = path.join(os.tmpdir(), "inf-574-does-not-exist.yaml");
    resetPolicyCache();
    await expect(defaultExemptTerminalTargetResolver("hanzo", "user-hanzo")).resolves.toBe(false);
  });
});

// ── AC3: workflow membership is one source of truth (the wf:* label projection) ─

describe("INF-574 AC3 — workflow membership has one source of truth", () => {
  test("getWorkflowId is a pure function of labels: membership flips to null iff no wf:* label", () => {
    // With the wf:task label present, the ticket is workflow-governed.
    expect(getWorkflowId(["wf:task", "state:intake"])).toBe("task");
    // After a demote strips the wf:* label, membership is ad-hoc regardless of any
    // lingering state:* label (the "presents as ad-hoc to the label check" case).
    expect(getWorkflowId(["state:intake"])).toBeNull();
    expect(getWorkflowId([])).toBeNull();
    // Deterministic: same labels → same verdict, so the demote check and the
    // role gate (both call getWorkflowId on the fetched label set) cannot disagree.
    expect(getWorkflowId(["wf:task", "state:intake"])).toBe(getWorkflowId(["wf:task", "state:intake"]));
  });

  test("no code path derives workflow membership from the applied-state store or native state", () => {
    // Structural lock: the demote label-check and the state-role gate both key
    // workflow membership off getWorkflowId(labels|labelNames). Nothing may pass
    // the applied-state store or native Linear state into getWorkflowId, which
    // would reintroduce the split-brain (one path "no wf label", another still
    // enforcing wf role legality) that INF-573 surfaced.
    const source = fs.readFileSync(path.join(process.cwd(), "src/workflow-gate.ts"), "utf8");
    const calls = source.match(/getWorkflowId\(([^)]*)\)/g) ?? [];
    const callSites = calls
      .map((call) => call.slice("getWorkflowId(".length, -1).trim())
      // Drop the function declaration itself (its param carries a type annotation).
      .filter((arg) => !arg.includes(":"));
    expect(callSites.length).toBeGreaterThan(0);
    for (const arg of callSites) {
      // Every membership check is derived from the ticket's LABEL projection
      // (a bare `labels`/`labelNames`, or a `.labels`-derived expression) —
      // never the applied-state store or native Linear state.
      expect(arg).toMatch(/label/i);
    }
    expect(source).not.toContain("getWorkflowId(getAppliedState");
    expect(source).not.toContain("getWorkflowId(nativeState");
    expect(source).not.toContain("getWorkflowId(appliedState");
  });
});
