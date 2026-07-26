/**
 * INF-748 — fanout `createChildIssue` must mint children into their entry
 * state's native Linear state, not the team-default Backlog.
 *
 * Class: INF-441 / INF-746 root. INF-441 fixed the child *label* default
 * (state:intake → state:todo). But `createChildIssue` never set a `stateId` on
 * the `issueCreate` input, so every spawned child landed in the team-default
 * column (Backlog) regardless of what its state:* label said its native state
 * should be. `consider-work` / `begin-work` are refused from native Backlog, so
 * arm delegates could not pick freshly-minted children up via the normal first
 * verb (observed live on LIF-291 Cycle-9, 2026-07-26).
 *
 * Fix: resolve the entry state's `native_state` → the team's matching Linear
 * stateId (reusing `resolveNativeStateId`, the same resolver the governed B2
 * transition path uses) and pass it in the issueCreate input, atomically with
 * the label.
 *
 * ── AC → test map ─────────────────────────────────────────────────────────
 *   AC1 native state == label's native_state at mint
 *        · "mints child with the resolved native stateId in issueCreate input"
 *        · (integration) "spawn-arms mints child directly into its entry
 *           native_state via the real def → native_state → stateId wiring"
 *   AC2 consider-work succeeds (no Backlog default)
 *        · covered by AC1: the child is born with an explicit non-Backlog
 *          stateId rather than omitting it and inheriting the team default.
 *   Fail-open / backward compat
 *        · "omits stateId when no lookupEntryStateId is provided (legacy)"
 *        · "fails open (mints without stateId) when resolution returns null"
 *        · "resolves the native stateId once per workflow (cached across siblings)"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyStateTransition, resetWorkflowCache, resetNativeStateCache } from "./workflow-gate.js";
import { executeFanout } from "./fanout.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { reloadAgents } from "./agents.js";

function jsonResp(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit level — executeFanout pins the child's native stateId at mint
// ═══════════════════════════════════════════════════════════════════════════

describe("INF-748: executeFanout mints children into their entry native state", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ query: string; variables: Record<string, unknown> }>;

  const SPEC = "## Findings\n- **Alpha**: alpha work\n- **Beta**: beta work\n";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeFetch(): typeof globalThis.fetch {
    let childCount = 0;
    return async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      fetchCalls.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueTeamParent")) {
        return jsonResp({
          issue: {
            id: "parent-internal-id",
            title: "Parent",
            description: SPEC,
            team: { id: "team-uuid" },
            parent: null,
          },
        });
      }
      if (query.includes("FanoutChildren") || (query.includes("children") && !query.includes("issueCreate"))) {
        return jsonResp({ issue: { children: { nodes: [] } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({
          team: {
            labels: {
              nodes: [
                { id: "lbl-wf-dev-impl", name: "wf:dev-impl" },
                { id: "lbl-state-doing", name: "state:doing" },
              ],
            },
          },
        });
      }
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        childCount++;
        return jsonResp({
          issueCreate: { success: true, issue: { id: `child-${childCount}`, identifier: `AI-${7000 + childCount}` } },
        });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };
  }

  function childCreateInputs(): Array<Record<string, unknown>> {
    return fetchCalls
      .filter((c) => c.query.includes("issueCreate"))
      .map((c) => (c.variables.input as Record<string, unknown>) ?? {});
  }

  it("mints each child with the resolved native stateId in the issueCreate input", async () => {
    globalThis.fetch = makeFetch();
    const config = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      initial_delegate: "igor",
    } as any;

    const result = await executeFanout("AI-748", "Bearer tok", config, {
      skipPreview: true,
      // Resolve the child workflow's entry-state native Linear stateId. In
      // production this is wired by workflow-gate to
      // def.entry_state → native_state → resolveNativeStateId(teamId, ...).
      lookupEntryStateId: async (wfLabel: string, teamId: string) => {
        expect(teamId).toBe("team-uuid");
        expect(wfLabel).toBe("wf:dev-impl");
        return "state-uuid-doing";
      },
    });

    expect(result.created).toBe(2);
    const inputs = childCreateInputs();
    expect(inputs.length).toBe(2);
    for (const input of inputs) {
      // The core AC: the child is born with an explicit native stateId, not the
      // team-default (which would leave the child in Backlog).
      expect(input.stateId).toBe("state-uuid-doing");
    }
  });

  it("omits stateId when no lookupEntryStateId is provided (legacy / backward compat)", async () => {
    globalThis.fetch = makeFetch();
    const config = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      initial_delegate: "igor",
    } as any;

    const result = await executeFanout("AI-748", "Bearer tok", config, {
      skipPreview: true,
      // No lookupEntryStateId — pre-INF-748 callers are unchanged.
    });

    expect(result.created).toBe(2);
    for (const input of childCreateInputs()) {
      expect("stateId" in input).toBe(false);
    }
  });

  it("fails open (mints without stateId, still creates the child) when resolution returns null", async () => {
    globalThis.fetch = makeFetch();
    const config = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      initial_delegate: "igor",
    } as any;

    const result = await executeFanout("AI-748", "Bearer tok", config, {
      skipPreview: true,
      lookupEntryStateId: async () => null,
    });

    // A resolution miss must NOT abort the spawn — the child is still created,
    // it just falls back to the team default (as before INF-748).
    expect(result.created).toBe(2);
    expect(result.errors).toHaveLength(0);
    for (const input of childCreateInputs()) {
      expect("stateId" in input).toBe(false);
    }
  });

  it("resolves the native stateId once per workflow (cached across sibling children)", async () => {
    globalThis.fetch = makeFetch();
    const config = {
      spec_source: "findings",
      child_workflow: "wf:dev-impl",
      initial_delegate: "igor",
    } as any;

    let calls = 0;
    const result = await executeFanout("AI-748", "Bearer tok", config, {
      skipPreview: true,
      lookupEntryStateId: async () => {
        calls++;
        return "state-uuid-doing";
      },
    });

    expect(result.created).toBe(2);
    // Two children, one shared workflow → exactly one resolution.
    expect(calls).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration — the real workflow-gate wiring resolves entry native_state and
// pins it on the mint, driven end-to-end through applyStateTransition.
// ═══════════════════════════════════════════════════════════════════════════

const PARENT_YAML = `
id: inf748-parent
version: 1
archetype: orchestrator
entry_state: intake
break_glass: { command: escape, to: escape, owner_role: steward }
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - { command: accept, to: spawning, assign: { mode: required } }
  - id: spawning
    owner_role: engine
    native_state: doing
    fanout:
      spec_source: findings
      child_workflow: wf:inf748-arm
      initial_delegate: igor
    transitions:
      - { command: spawn, to: managing }
  - id: managing
    owner_role: engine
    native_state: managing
    barrier: true
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
    satisfies_parent_barrier: true
  - id: escape
    kind: terminal
    native_state: invalid
`;

// Child whose ENTRY state's native_state is 'doing' — mirrors the sprint-arm
// case from the INF-748 evidence (LIF-292/293/294 born into Backlog despite
// state:doing). A correct mint pins native Doing at creation.
const CHILD_YAML = `
id: inf748-arm
version: 1
entry_state: doing
states:
  - id: doing
    owner_role: engine
    native_state: doing
    transitions:
      - { command: complete, to: done }
  - id: done
    kind: terminal
    native_state: done
`;

const CAPABILITY_POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: dev
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: engine
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: engine
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: engine-1
    container: engine
    fills_roles: [engine]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

describe("INF-748 integration: spawn-arms mints child directly into its entry native_state", () => {
  let dir: string;
  let policyFile: string;
  let origDefsDir: string | undefined;
  let origPolicy: string | undefined;
  let origAgents: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    origDefsDir = process.env.WORKFLOW_DEFS_DIR;
    origPolicy = process.env.CAPABILITY_POLICY_PATH;
    origAgents = process.env.AGENTS_FILE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf748-"));
    fs.writeFileSync(path.join(dir, "inf748-parent.yaml"), PARENT_YAML, "utf8");
    fs.writeFileSync(path.join(dir, "inf748-arm.yaml"), CHILD_YAML, "utf8");
    policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, CAPABILITY_POLICY_YAML, "utf8");
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "astrid-linear-uuid", clientId: "a-c", clientSecret: "a-s", accessToken: "a-t", refreshToken: "a-r" },
        { name: "engine-1", linearUserId: "engine1-linear-uuid", clientId: "e-c", clientSecret: "e-s", accessToken: "e-t", refreshToken: "e-r" },
        { name: "igor", linearUserId: "igor-linear-uuid", clientId: "i-c", clientSecret: "i-s", accessToken: "i-t", refreshToken: "i-r" },
      ],
    }, null, 2), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    process.env.WORKFLOW_DEFS_DIR = dir;
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    reloadAgents();
  });

  afterAll(() => {
    if (origDefsDir !== undefined) process.env.WORKFLOW_DEFS_DIR = origDefsDir; else delete process.env.WORKFLOW_DEFS_DIR;
    if (origPolicy !== undefined) process.env.CAPABILITY_POLICY_PATH = origPolicy; else delete process.env.CAPABILITY_POLICY_PATH;
    if (origAgents !== undefined) process.env.AGENTS_FILE = origAgents; else delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetPolicyCache();
  });

  beforeEach(() => {
    resetWorkflowCache();
    resetPolicyCache();
    resetNativeStateCache();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes the team's Doing stateId in the child issueCreate (not the team-default Backlog)", async () => {
    const record: Array<{ query: string; variables: Record<string, unknown> }> = [];
    // Neutral finding title — must not match fanout.ts auto-derive rules
    // (e.g. "scope arm" → wf:sprint-arm-scope), so the config child_workflow
    // wf:inf748-arm is used as-is.
    const parentDescription = "## Findings\n- **Alpha widget**: build the alpha widget\n";
    const parentLabels = [
      { id: "wf-lbl", name: "wf:inf748-parent" },
      { id: "state-lbl", name: "state:spawning" },
    ];
    let childCount = 0;

    globalThis.fetch = async (url, init) => {
      if (typeof url !== "string" || !url.includes("api.linear.app")) {
        throw new Error("unexpected fetch call");
      }
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = parsed.query ?? "";
      record.push({ query, variables: parsed.variables ?? {} });

      if (query.includes("IssueWithLabels")) {
        return jsonResp({ issue: { id: "parent-internal-id", identifier: "AI-748", team: { id: "team-uuid" }, labels: { nodes: parentLabels } } });
      }
      if (query.includes("TeamStates")) {
        return jsonResp({
          team: {
            states: {
              nodes: [
                { id: "s-backlog", name: "Backlog", type: "backlog" },
                { id: "s-todo", name: "Todo", type: "unstarted" },
                { id: "s-doing", name: "Doing", type: "started" },
                { id: "s-managing", name: "Managing", type: "started" },
                { id: "s-done", name: "Done", type: "completed" },
                { id: "s-invalid", name: "Invalid", type: "canceled" },
              ],
            },
          },
        });
      }
      if (query.includes("ApplyAtomicTransition")) {
        return jsonResp({ issueUpdate: { success: true } });
      }
      if (query.includes("IssueWithComments")) {
        return jsonResp({ issue: { id: "parent-internal-id", description: parentDescription, comments: { nodes: [] } } });
      }
      if (query.includes("IssueParent") && !query.includes("IssueTeamParent")) {
        return jsonResp({ issue: { parent: null } });
      }
      if (query.includes("IssueTeamParent")) {
        return jsonResp({ issue: { id: "parent-internal-id", title: "Parent", description: parentDescription, team: { id: "team-uuid" }, parent: null } });
      }
      if (query.includes("FanoutChildren")) {
        return jsonResp({ issue: { children: { nodes: [] } } });
      }
      if (query.includes("TeamLabels")) {
        return jsonResp({ team: { labels: { nodes: [
          { id: "lbl-wf-arm", name: "wf:inf748-arm" },
          { id: "lbl-state-doing", name: "state:doing" },
        ] } } });
      }
      if (query.includes("issueLabelCreate") && !query.includes("issueCreate")) {
        const name = (parsed.variables as Record<string, unknown>).name as string;
        return jsonResp({ issueLabelCreate: { success: true, issueLabel: { id: `label-${name}` } } });
      }
      if (query.includes("issueCreate")) {
        childCount++;
        return jsonResp({ issueCreate: { success: true, issue: { id: `child-${childCount}`, identifier: `AI-${7100 + childCount}` } } });
      }
      if (query.includes("commentCreate")) {
        return jsonResp({ commentCreate: { success: true, comment: { id: "cm" } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    const result = await applyStateTransition("spawn", "AI-748", "Bearer tok");
    expect(result.status).toBe("applied");

    const childCreate = record.find((c) => c.query.includes("issueCreate"));
    expect(childCreate).toBeDefined();
    const input = childCreate!.variables.input as Record<string, unknown>;
    // The child's entry state is `doing` (native_state doing) → must be minted
    // with the team's Doing state UUID, NOT omitted (which lands it in Backlog).
    expect(input.stateId).toBe("s-doing");
    expect(input.stateId).not.toBe("s-backlog");
  });
});
