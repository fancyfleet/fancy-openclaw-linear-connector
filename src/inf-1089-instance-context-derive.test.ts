import { deriveWorkflowInstanceContextFromRoute } from "./webhook/index.js";
import { normalizeLinearEvent } from "./webhook/normalize.js";
import {
  deriveWorkflowInstanceScope,
  type WorkflowDef,
} from "./workflow-gate.js";
import type { LinearEvent } from "./webhook/schema.js";
import type { RouteResult } from "./types.js";

/**
 * INF-1089 — routing-guard blocked ALL webhook-path dispatch for wf:dept-engine
 * and wf:task because instance-scope derivation missed the flat teamKey in
 * normalized webhook payloads.
 *
 * `deriveWorkflowInstanceContextFromRoute` read team context only as a nested
 * object (`issueData.team.key` / `team.name`), but `normalizeLinearEvent`
 * (extractIssueData) emits it FLAT — `teamKey`/`teamId`, with no nested `team`.
 * So teamKey/teamName came up undefined, `deriveWorkflowInstanceScope` returned
 * undefined for dept-engine/task, and the guard failed closed (INF-942).
 *
 * These tests drive the REAL normalizer so the fixture cannot drift from the
 * production payload shape.
 */

function routeFor(event: LinearEvent): RouteResult {
  return {
    agentId: "igor",
    sessionKey: "s",
    priority: 0,
    event,
  };
}

// Minimal `task` def: department_scope intentionally absent — scope MUST come
// from instance context (matches the real registered def per INF-942).
function taskDef(): WorkflowDef {
  return {
    id: "task",
    version: 3,
    states: [
      { id: "doing", owner_role: "worker", kind: "normal", native_state: "todo", transitions: [] },
      { id: "review", owner_role: "department-head", kind: "normal", native_state: "todo", transitions: [] },
    ],
  } as unknown as WorkflowDef;
}

// Shape a Linear "Issue.update" webhook payload with team context nested under
// `data.team` (as Linear sends it on the wire, before normalization).
function rawIssuePayload(): unknown {
  return {
    type: "Issue",
    action: "update",
    createdAt: "2026-08-02T08:00:00.000Z",
    actor: { id: "u1", name: "astrid" },
    data: {
      id: "iss-1",
      identifier: "INF-1089",
      title: "t",
      state: { id: "st1", name: "doing", type: "started" },
      team: { id: "team-eng", key: "ENG", name: "Engineering" },
      url: "https://linear.app/x",
    },
  };
}

describe("INF-1089: instance-context derivation reads flat teamKey from normalized events", () => {
  it("recovers teamKey from a normalized (flat) webhook event", () => {
    // normalizeLinearEvent flattens team → teamKey/teamId, dropping nested `team`.
    const event = normalizeLinearEvent(rawIssuePayload());
    // Guard: the normalized data really is flat (no nested team) — this is the
    // exact condition the old code failed on.
    const data = event.data as Record<string, unknown>;
    expect(data.team).toBeUndefined();
    expect(data.teamKey).toBe("ENG");

    const context = deriveWorkflowInstanceContextFromRoute(routeFor(event), "INF-1089");
    expect(context.teamKey).toBe("ENG");
  });

  it("makes deriveWorkflowInstanceScope non-undefined for wf:task on a normalized event (fail-closed → resolves)", () => {
    const event = normalizeLinearEvent(rawIssuePayload());
    const context = deriveWorkflowInstanceContextFromRoute(routeFor(event), "INF-1089");
    const scope = deriveWorkflowInstanceScope(taskDef(), context);
    // Pre-fix this was undefined → routing-guard failed closed for every
    // webhook-path dispatch.
    expect(scope).toBeDefined();
    expect(scope!.department).toBe("ENG");
  });

  it("still reads nested team.key/team.name from proxy-layer payloads (backward compat)", () => {
    // A proxy-layer payload nests team under `data.team` and is not normalized.
    const event = {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "astrid" },
      createdAt: "2026-08-02T08:00:00.000Z",
      data: { identifier: "INF-1089", team: { key: "OPS", name: "Operations" } },
    } as unknown as LinearEvent;
    const context = deriveWorkflowInstanceContextFromRoute(routeFor(event), "INF-1089");
    expect(context.teamKey).toBe("OPS");
    expect(context.teamName).toBe("Operations");
  });

  it("treats an empty flat teamKey as missing (no bogus empty-string scope)", () => {
    // extractIssueData emits teamKey:"" when the team key is absent.
    const event = {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "astrid" },
      createdAt: "2026-08-02T08:00:00.000Z",
      data: { identifier: "INF-1089", teamId: "", teamKey: "" },
    } as unknown as LinearEvent;
    const context = deriveWorkflowInstanceContextFromRoute(routeFor(event), "INF-1089");
    expect(context.teamKey).toBeUndefined();
    // Genuinely-missing scope must still fail closed.
    expect(deriveWorkflowInstanceScope(taskDef(), context)).toBeUndefined();
  });
});
