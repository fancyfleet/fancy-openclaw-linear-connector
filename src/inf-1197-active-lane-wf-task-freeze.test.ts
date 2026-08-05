/**
 * INF-1197 — active-lane wf:task freeze.
 *
 * SUPERSEDED by INF-1243 (2026-08-05, Matt-confirmed): AC2 below originally
 * asserted that To Do active-lane classification *chose* wf:dev-impl for
 * code work or wf:chore for operational work instead of the deprecated
 * wf:task default. INF-1243 tightened the requirement further — plain
 * delegation must enroll into NO workflow at all, not even a correctly
 * classified one. `classifyPlainDelegationActiveLane` (the classifier this
 * suite exercised) is deleted; `autoEnrollPlainDelegation` is now an inert
 * no-op. These tests are inverted accordingly — same input fixtures, but
 * now asserting zero enrollment across every description shape.
 *
 * AC map (as inverted for INF-1243):
 *   AC1/AC4: active-lane tickets without an explicit workflow never
 *            auto-enroll into any wf: or state: label (INF-1191 leak
 *            regression stays fixed by construction — nothing enrolls).
 *   AC2: To Do active-lane classification (code-signal, chore-signal,
 *        empty, and ambiguous description text) all decline enrollment.
 *   AC3: Backlog tickets remain clean inventory and are not auto-enrolled.
 *   AC5: the runtime build stamp must include the INF-1197 fix commit, so
 *        deployment verification cannot stop at the source branch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  _setLogForTests,
  autoEnrollPlainDelegation,
  resetNativeStateCache,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import type { Logger } from "./logger.js";

const CANONICAL_CHORE = path.resolve(process.cwd(), "src/__fixtures__/canonical-chore.yaml");
const CANONICAL_DEV_IMPL = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");

const TEAM_ID = "team-inf";
const ISSUE_UUID = "issue-inf-1197";
const ISSUE_IDENTIFIER = "INF-1191";

const LABEL_IDS = {
  sameTeam: "label-same-team",
  wfTask: "label-wf-task",
  wfChore: "label-wf-chore",
  wfDevImpl: "label-wf-dev-impl",
  stateDoing: "label-state-doing",
  stateIntake: "label-state-intake",
};

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate
  - id: deploy:execute

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition]
  - id: deployment
    grants: [linear:transition, deploy:execute]

roles:
  - id: requester
    requires: [linear:transition]
  - id: steward
    requires: [human:escalate]
  - id: worker
    requires: [linear:transition]
  - id: test-author
    requires: [linear:transition]
  - id: dev
    requires: [linear:transition]
  - id: code-review
    requires: [linear:transition]
  - id: deployment
    requires: [deploy:execute]

bodies:
  - id: ai
    container: steward
    fills_roles: [requester, steward]
  - id: igor
    container: dev
    fills_roles: [worker, dev]
  - id: tdd
    container: dev
    fills_roles: [test-author]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

type NativeState = { id: string; name: string; type: string };

interface CapturedWrite {
  query: string;
  variables: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function spyLogger(): Logger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    warn: (msg: string, ...args: unknown[]) => warns.push([msg, ...args.map(String)].join(" ")),
    info: (msg: string, ...args: unknown[]) => infos.push([msg, ...args.map(String)].join(" ")),
    error: () => undefined,
    debug: () => undefined,
  };
}

function installEnrollFetch(opts: {
  title: string;
  description?: string | null;
  nativeState: NativeState;
}): { writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  const teamLabels = [
    { id: LABEL_IDS.wfTask, name: "wf:task", team: { id: TEAM_ID } },
    { id: LABEL_IDS.wfChore, name: "wf:chore", team: { id: TEAM_ID } },
    { id: LABEL_IDS.wfDevImpl, name: "wf:dev-impl", team: { id: TEAM_ID } },
    { id: LABEL_IDS.stateDoing, name: "state:doing", team: { id: TEAM_ID } },
    { id: LABEL_IDS.stateIntake, name: "state:intake", team: { id: TEAM_ID } },
  ];

  globalThis.fetch = (async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};

    if (query.includes("IssueWithLabels")) {
      return jsonResponse({
        data: {
          issue: {
            id: ISSUE_UUID,
            identifier: ISSUE_IDENTIFIER,
            title: opts.title,
            description: opts.description ?? "",
            team: { id: TEAM_ID, key: "INF", name: "Infrastructure" },
            labels: { nodes: [{ id: LABEL_IDS.sameTeam, name: "triage:new", team: { id: TEAM_ID } }] },
            delegate: { id: "lin-igor" },
            assignee: null,
            state: opts.nativeState,
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: teamLabels } } } });
    }

    if (query.includes("ApplyAtomicTransition")) {
      writes.push({ query, variables });
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    return jsonResponse({ errors: [{ message: `unexpected query: ${query.slice(0, 120)}` }] }, 400);
  }) as typeof globalThis.fetch;

  return { writes };
}

function writtenLabelIds(writes: CapturedWrite[]): string[] {
  return (writes[0]?.variables.labelIds ?? []) as string[];
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1197-active-lane-"));
  savedEnv = {
    WORKFLOW_DEFS_DIR: process.env.WORKFLOW_DEFS_DIR,
    CAPABILITY_POLICY_PATH: process.env.CAPABILITY_POLICY_PATH,
  };
  const defsDir = path.join(tmpDir, "defs");
  fs.mkdirSync(defsDir, { recursive: true });
  fs.copyFileSync(CANONICAL_CHORE, path.join(defsDir, "chore.yaml"));
  fs.copyFileSync(CANONICAL_DEV_IMPL, path.join(defsDir, "dev-impl.yaml"));
  fs.writeFileSync(path.join(tmpDir, "policy.yaml"), POLICY_YAML, "utf8");
  process.env.WORKFLOW_DEFS_DIR = defsDir;
  process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetWorkflowCache();
  resetNativeStateCache();
  resetPolicyCache();
  resetConfigHealth();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setLogForTests();
});

describe("INF-1243 AC2/AC5: plain delegation never auto-enrolls, for any description shape", () => {
  it("code-signal description does not auto-enroll", async () => {
    const { writes } = installEnrollFetch({
      title: "Fix connector active lane freeze",
      description: "engineering-domain: backend\nUpdate src/workflow-gate.ts and ship the connector fix.",
      nativeState: { id: "state-todo", name: "To Do", type: "unstarted" },
    });

    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer test", undefined, undefined, "igor");

    expect(result).toEqual({ enrolled: false });
    expect(writes).toHaveLength(0);
  });

  it("chore-signal description does not auto-enroll", async () => {
    const { writes } = installEnrollFetch({
      title: "Archive stale operational notes",
      description: "Clean up obsolete runbook notes after the sprint handoff. No code changes.",
      nativeState: { id: "state-todo", name: "To Do", type: "unstarted" },
    });

    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer test", undefined, undefined, "igor");

    expect(result).toEqual({ enrolled: false });
    expect(writes).toHaveLength(0);
  });

  it("empty title and description does not auto-enroll", async () => {
    const { writes } = installEnrollFetch({
      title: "",
      description: "",
      nativeState: { id: "state-todo", name: "To Do", type: "unstarted" },
    });

    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer test", undefined, undefined, "igor");

    expect(result).toEqual({ enrolled: false });
    expect(writes).toHaveLength(0);
  });

  it("ambiguous description (no code or chore signal) does not auto-enroll", async () => {
    const spy = spyLogger();
    _setLogForTests(spy);
    const { writes } = installEnrollFetch({
      title: "Take care of this",
      description: "",
      nativeState: { id: "state-todo", name: "To Do", type: "unstarted" },
    });

    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer test", undefined, undefined, "igor");

    expect(result).toEqual({ enrolled: false });
    expect(writes).toHaveLength(0);
  });
});

describe("INF-1197 AC3: Backlog remains clean inventory", () => {
  it("does not auto-enroll a delegated Backlog ticket and does not stamp wf:task", async () => {
    const { writes } = installEnrollFetch({
      title: "Fix connector active lane freeze",
      description: "engineering-domain: backend\nThis is inventory until promoted into an active lane.",
      nativeState: { id: "state-backlog", name: "Backlog", type: "backlog" },
    });

    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer test", undefined, undefined, "igor");

    expect(result).toEqual({ enrolled: false });
    expect(writes).toHaveLength(0);
  });
});

describe("INF-1197 AC5: deployed connector build contains the fix", () => {
  it("requires the INF-1197 runtime hallmark in dist, not just TypeScript source", () => {
    const builtWorkflowGate = path.resolve(process.cwd(), "dist/workflow-gate.js");
    expect(fs.existsSync(builtWorkflowGate)).toBe(true);

    const builtSource = fs.readFileSync(builtWorkflowGate, "utf8");
    expect(builtSource).toContain("INF_1197_ACTIVE_LANE_WF_TASK_FREEZE");
  });
});
