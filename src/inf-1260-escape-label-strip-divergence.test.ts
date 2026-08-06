/**
 * INF-1260: escape must not strand a ticket label-less, and the divergence
 * detector must catch it when something else does.
 *
 * (a) Guard: `applyStateTransition`'s escape path always calls
 *     `retainedLabelIdsForIssue(issue.labels, issue.teamId)` (src/workflow-gate.ts:7075)
 *     WITHOUT `stripWorkflowLabels: true`, so it strips every `state:*` label
 *     and appends exactly one new `state:*` label while retaining `wf:*`. This
 *     assertion should already be GREEN today — it is kept as a regression
 *     guard so a future change to the escape label path cannot silently
 *     reintroduce label-loss without failing a test.
 *
 * (b) Bug (AC4): `processIssue` in src/cron/anti-entropy.ts:340-350 returns
 *     immediately when `stateLabel` is falsy:
 *       `if (!stateLabel || !workflowId) return;`
 *     A ticket that still carries `wf:dev-impl` but has LOST its `state:*`
 *     label entirely (by any other path than escape) is silently skipped —
 *     anti-entropy only checks native-state-vs-label MISMATCH when the label
 *     already exists, never label ABSENCE. This test asserts the desired
 *     behavior (the pass flags/reports the label-loss) and is RED against
 *     today's silent skip.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { applyStateTransition, resetNativeStateCache, resetWorkflowCache } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { runAntiEntropyPass } from "./cron/anti-entropy.js";

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: intake
break_glass:
  command: escape
  to: intake
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review
  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions: []
`;

function writeAgents(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
      ],
    }),
    "utf8",
  );
  return agentsFile;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── (a) Guard: escape never strands a ticket without a state:* label ───────

describe("INF-1260 AC4 (escape label-strip): escape does not strand a ticket without a state:* label", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowDefPath: string | undefined;
  let originalAgentsFile: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;

  beforeEach(() => {
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalAgentsFile = process.env.AGENTS_FILE;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;
    delete process.env.CAPABILITY_POLICY_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-escape-label-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    resetWorkflowCache();
    resetNativeStateCache();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalAgentsFile !== undefined) process.env.AGENTS_FILE = originalAgentsFile;
    else delete process.env.AGENTS_FILE;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("AC7(escape label-strip): escape from 'implementation' leaves exactly one state:* label (guard — may already be green)", async () => {
    let labels = [
      { id: "wf-lbl", name: "wf:dev-impl" },
      { id: "state-implementation", name: "state:implementation" },
    ];
    const teamLabels = [
      { id: "wf-lbl", name: "wf:dev-impl" },
      { id: "state-intake", name: "state:intake" },
      { id: "state-implementation", name: "state:implementation" },
    ];
    let delegateId: string | null = "u-astrid";
    let nativeStateId: string | null = "native-todo";

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const query = body.query ?? "";

      if (query.includes("IssueWithLabels")) {
        return jsonResponse({
          data: {
            issue: {
              id: "issue-uuid",
              identifier: "INF-1260-LABELSTRIP",
              team: { id: "team-inf" },
              labels: { nodes: labels },
            },
          },
        });
      }
      if (query.includes("TeamLabels")) {
        return jsonResponse({ data: { team: { labels: { nodes: teamLabels } } } });
      }
      if (query.includes("TeamStates")) {
        return jsonResponse({ data: { team: { states: { nodes: [{ id: "native-todo", name: "Todo", type: "unstarted" }] } } } });
      }
      if (query.includes("ApplyAtomicTransition")) {
        const vars = body.variables ?? {};
        const nextLabelIds = new Set((vars.labelIds as string[]) ?? []);
        labels = teamLabels.filter((l) => nextLabelIds.has(l.id));
        if ("delegateId" in vars) delegateId = vars.delegateId as string | null;
        if ("stateId" in vars) nativeStateId = vars.stateId as string | null;
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      if (query.includes("VerifyTransitionWrite")) {
        return jsonResponse({
          data: {
            issue: {
              labels: { nodes: labels.map(({ name }) => ({ name })) },
              delegate: delegateId ? { id: delegateId } : null,
              assignee: delegateId ? { id: delegateId } : null,
              state: nativeStateId ? { id: nativeStateId } : null,
            },
          },
        });
      }
      if (query.includes("commentCreate")) {
        return jsonResponse({ data: { commentCreate: { success: true, comment: { id: "c-1" } } } });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    };

    await applyStateTransition("escape", "INF-1260-LABELSTRIP", "Bearer tok", { bodyId: "astrid" });

    const stateLabels = labels.filter((l) => l.name.startsWith("state:"));
    expect(stateLabels.length).toBe(1);
    expect(labels.some((l) => l.name === "wf:dev-impl")).toBe(true);
  });
});

// ── (b) Bug: divergence detector must flag wf:* present + state:* missing ──

describe("INF-1260 AC4 (escape label-strip divergence): anti-entropy must flag wf:* present with no state:* label", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowDefPath: string | undefined;
  let originalTestReset: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalTestReset = process.env.ANTI_ENTROPY_TEST_RESET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-antientropy-"));
    const workflowFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(workflowFile, TEST_WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = workflowFile;
    process.env.ANTI_ENTROPY_TEST_RESET = "1";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalTestReset !== undefined) process.env.ANTI_ENTROPY_TEST_RESET = originalTestReset;
    else delete process.env.ANTI_ENTROPY_TEST_RESET;
  });

  it("AC7(escape label-strip divergence): a wf:dev-impl ticket with no state:* label is reported, not silently skipped", async () => {
    const LABEL_LOST_IDENTIFIER = "INF-1260-NOSTATE";

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      const query = body.query ?? "";

      if (query.includes("AntiEntropyIssues")) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-nostate-uuid",
                  identifier: LABEL_LOST_IDENTIFIER,
                  team: { id: "team-inf" },
                  state: { id: "native-todo", name: "Todo" },
                  // wf:dev-impl present, but NO state:* label — the corruption.
                  labels: { nodes: [{ id: "wf-lbl", name: "wf:dev-impl" }] },
                  children: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }

      throw new Error(`unexpected query in anti-entropy pass: ${query.slice(0, 80)}`);
    };

    const result = await runAntiEntropyPass({ authToken: "Bearer tok" });

    expect(result.scanned).toBe(1);
    // Desired: the pass must surface the label-loss (via the existing
    // `errors` diagnostic channel, or an equivalent reported finding) instead
    // of silently returning on `!stateLabel`. Today `processIssue` returns
    // before recording anything, so `errors` stays empty — RED.
    expect(result.errors.some((e) => e.includes(LABEL_LOST_IDENTIFIER))).toBe(true);
  });
});
