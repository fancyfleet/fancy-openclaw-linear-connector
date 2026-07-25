/**
 * INF-576 Fix 2 — when the delegate ping-pong was manufactured by role-guard
 * rejections against a role no legal body fills in the workflow, the escalation
 * must NAME that structural condition instead of the silent lock-to-steward.
 *
 * The role-guard block already emits a `role-guard-blocked` operational event
 * (webhook/index.ts) carrying { ownerRole, workflowId, legalBodies }. This fix
 * threads that descriptor through the ping-pong detector's escalation so the
 * comment tells the truth: "no legal target for required role '<role>' in
 * wf:<id> — objective unroutable; disposition manually". Lock-to-steward stays
 * as the fallback.
 *
 * Failing-first: against unfixed code, fireEscalation has no structural param
 * and always posts the generic ping-pong text, so AC1's structural-comment
 * assertion fails (and the AC2 detector wiring won't compile/return the flag).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  DelegateChainTracker,
  DelegatePingPongDetector,
  fireEscalation,
  type DelegatePingPongConfig,
} from "./delegate-ping-pong-detector.js";
import { OperationalEventStore } from "./store/operational-event-store.js";

interface Captured {
  comments: string[];
}

function makeMockFetch(): { fetch: typeof globalThis.fetch; captured: Captured } {
  const captured: Captured = { comments: [] };
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};

    if (query.includes("commentCreate")) {
      captured.comments.push(String(variables.body ?? ""));
      return json({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } });
    }
    if (query.includes("issueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    // resolveIssueId: `issue(id: $id) { id }`
    if (query.includes("issue(id:")) {
      return json({ data: { issue: { id: `internal-${variables.id}` } } });
    }
    return json({ data: {} });
  };
  return { fetch: mockFetch, captured };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf576-fix2-"));
  originalFetch = globalThis.fetch;
  for (const k of ["LINEAR_OAUTH_TOKEN", "LINEAR_API_KEY"]) savedEnv[k] = process.env[k];
  process.env.LINEAR_OAUTH_TOKEN = "tok-test";
  delete process.env.LINEAR_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("INF-576 Fix 2 — structural-unroutable escalation legibility", () => {
  it("AC1: fireEscalation with a structural descriptor names the unroutable role and disposition", async () => {
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const result = await fireEscalation("INF-573", ["user-hanzo"], 3, undefined, {
      ownerRole: "deployment",
      workflowId: "task",
      legalBodies: ["hanzo"],
    });

    expect(result.structuralUnroutable).toBe(true);
    expect(mf.captured.comments).toHaveLength(1);
    const comment = mf.captured.comments[0];
    expect(comment).toContain("No legal target for required role 'deployment'");
    expect(comment).toContain("wf:task");
    // It must offer a concrete disposition, not a silent steward lock.
    expect(comment).toMatch(/demote/i);
    expect(comment).not.toContain("Delegate ping-pong cycle detected");
  });

  it("AC2: a role-guard-blocked event within the window drives a structural escalation comment", async () => {
    const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60_000 };
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, eventStore);
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    // The webhook keys the role-guard block with the normalized session key.
    eventStore.append({
      outcome: "delivery-failed",
      agent: "hanzo",
      key: "linear-INF-573",
      sessionKey: "linear-INF-573",
      deliveryMode: "role-guard-blocked",
      attemptCount: 1,
      errorSummary: "routing-guard blocked: 'hanzo' does not fill role 'worker'",
      detail: { ownerRole: "worker", workflowId: "task", legalBodies: ["igor", "sage"] },
    });

    const now = Date.now();
    // Drive Hanzo to the ping-pong threshold (raw identifier, as the detector sees it).
    await detector.checkAndHandle("INF-573", "user-hanzo", "Hanzo", now);
    await detector.checkAndHandle("INF-573", "user-ai", "Ai", now + 1000);
    await detector.checkAndHandle("INF-573", "user-hanzo", "Hanzo", now + 2000);
    await detector.checkAndHandle("INF-573", "user-ai", "Ai", now + 3000);
    const r5 = await detector.checkAndHandle("INF-573", "user-hanzo", "Hanzo", now + 4000);

    expect(r5.suppressDispatch).toBe(true);
    expect(r5.escalation?.structuralUnroutable).toBe(true);

    const structuralComment = mf.captured.comments.find((c) =>
      c.includes("No legal target for required role 'worker'"),
    );
    expect(structuralComment).toBeDefined();
    expect(structuralComment).toContain("wf:task");

    // The op event records the structural descriptor for observability.
    const cycleEvents = eventStore
      .query({ key: "INF-573", outcome: "ping-pong-cycle-detected" })
      .map((e) => e.detail as { structuralUnroutable?: { ownerRole?: string } });
    expect(cycleEvents.some((d) => d.structuralUnroutable?.ownerRole === "worker")).toBe(true);
  });

  it("AC3: a genuine bounce with no role-guard block still posts the generic ping-pong escalation", async () => {
    const config: Partial<DelegatePingPongConfig> = { maxBounces: 3, windowMs: 60_000 };
    const eventStore = new OperationalEventStore(path.join(dir, "events.db"));
    const tracker = new DelegateChainTracker(config);
    const detector = new DelegatePingPongDetector(tracker, config, eventStore);
    const mf = makeMockFetch();
    globalThis.fetch = mf.fetch;

    const now = Date.now();
    await detector.checkAndHandle("INF-900", "user-hanzo", "Hanzo", now);
    await detector.checkAndHandle("INF-900", "user-ai", "Ai", now + 1000);
    await detector.checkAndHandle("INF-900", "user-hanzo", "Hanzo", now + 2000);
    await detector.checkAndHandle("INF-900", "user-ai", "Ai", now + 3000);
    const r5 = await detector.checkAndHandle("INF-900", "user-hanzo", "Hanzo", now + 4000);

    expect(r5.suppressDispatch).toBe(true);
    expect(r5.escalation?.structuralUnroutable).toBe(false);
    expect(mf.captured.comments.some((c) => c.includes("Delegate ping-pong cycle detected"))).toBe(true);
    expect(mf.captured.comments.some((c) => c.includes("No legal target for required role"))).toBe(false);
  });
});
