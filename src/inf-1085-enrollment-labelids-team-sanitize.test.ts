/**
 * INF-1085: the INF-1045 cross-team labelId sanitizer must ALSO reach the
 * enrollment/heal write sites.
 *
 * INF-1045 fixed the transition/demote/park/setState write sites (which fully
 * replace the label set) by routing them through `retainedLabelIdsForIssue`.
 * But three enrollment sites — `autoEnrollByTeam`, `autoEnrollPlainDelegation`,
 * and `enrollIfMissing` — build the governed `issueUpdate(labelIds:)` set from
 * the RAW `issue.labels.map((l) => l.id)`, ADDING the wf and state labels on
 * top. A demoted LifeOS (LIF) ticket carries an inherited parent-team
 * `xfn:workflow` label; that cross-team label id survived into the enrollment
 * write and Linear rejected the whole atomic mutation — so the fix "did not
 * hold" for the exact scenario blocking LIF-45 Cycle 12: a demoted LIF ticket
 * being (re-)enrolled.
 *
 * These tests drive the two production enrollment entry points against a mocked
 * Linear API and assert the inherited cross-team label id is dropped from the
 * enrollment write, while the issue-team labels and the newly-stamped
 * wf and state labels are retained.
 *
 * Repo: fancy-openclaw-linear-connector
 * Branch: fix/INF-1085-enrollment-labelids-team-sanitize
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
  autoEnrollByTeam,
  autoEnrollPlainDelegation,
  resetWorkflowCache,
} from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

// ── Fixtures / identifiers ──────────────────────────────────────────────────

const CANONICAL_DEV_IMPL = path.resolve(process.cwd(), "src/__fixtures__/canonical-dev-impl.yaml");
const CANONICAL_CHORE = path.resolve(process.cwd(), "src/__fixtures__/canonical-chore.yaml");

const LIF_TEAM = "lif-team-uuid";
const PARENT_TEAM = "parent-team-uuid";
const ISSUE_UUID = "inf-1085-issue-uuid";
const ISSUE_IDENTIFIER = "LIF-1085";

// Same-team + inherited cross-team labels on a demoted LIF ticket (no wf:* yet).
const INHERITED_XFN_LABEL_ID = "parent-xfn-workflow-lbl";
const ISSUE_LABELS = [
  { id: "lif-cr-lbl", name: "cross-functional-request", team: { id: LIF_TEAM } },
  { id: INHERITED_XFN_LABEL_ID, name: "xfn:workflow", team: { id: PARENT_TEAM } },
];

// Team-owned labels findOrCreateLabel resolves without a create.
const TEAM_LABELS = [
  { id: "wf-devimpl-lbl", name: "wf:dev-impl", team: { id: LIF_TEAM } },
  { id: "state-intake-lbl", name: "state:intake", team: { id: LIF_TEAM } },
  { id: "wf-chore-lbl", name: "wf:chore", team: { id: LIF_TEAM } },
];

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock Linear for the enrollment flow; records every atomic labelIds write. */
function makeEnrollFetch(): { fetch: typeof globalThis.fetch; writes: Captured[] } {
  const writes: Captured[] = [];
  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error(`unexpected fetch url: ${String(url)}`);
    }
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
            team: { id: LIF_TEAM, key: "LIF", name: "LifeOS" },
            labels: { nodes: ISSUE_LABELS },
            delegate: null,
            assignee: null,
            state: { id: "s-backlog" },
          },
        },
      });
    }

    if (query.includes("TeamLabels")) {
      return jsonResponse({ data: { team: { labels: { nodes: TEAM_LABELS } } } });
    }

    if (query.includes("ApplyAtomicTransition")) {
      writes.push({ query, variables });
      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }

    return jsonResponse({ errors: [{ message: `unexpected query: ${query.slice(0, 120)}` }] }, 400);
  };
  return { fetch: mockFetch, writes };
}

// ── Setup / teardown ────────────────────────────────────────────────────────

let registryDir: string;
let originalFetch: typeof globalThis.fetch;
let savedDefsDir: string | undefined;

beforeAll(() => {
  registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1085-defs-"));
  fs.writeFileSync(
    path.join(registryDir, "dev-impl.yaml"),
    fs.readFileSync(CANONICAL_DEV_IMPL, "utf8"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(registryDir, "chore.yaml"),
    fs.readFileSync(CANONICAL_CHORE, "utf8"),
    "utf8",
  );
  savedDefsDir = process.env.WORKFLOW_DEFS_DIR;
  process.env.WORKFLOW_DEFS_DIR = registryDir;
});

afterAll(() => {
  if (savedDefsDir === undefined) delete process.env.WORKFLOW_DEFS_DIR;
  else process.env.WORKFLOW_DEFS_DIR = savedDefsDir;
  fs.rmSync(registryDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  resetConfigHealth();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("INF-1085: enrollment writes drop inherited cross-team label IDs", () => {
  it("autoEnrollByTeam omits the inherited parent-team xfn label from the enrollment write", async () => {
    const { fetch: mock, writes } = makeEnrollFetch();
    globalThis.fetch = mock;

    const result = await autoEnrollByTeam(ISSUE_UUID, "LIF", "Bearer tok", { LIF: "dev-impl" });

    expect(result.enrolled).toBe(true);
    expect(writes).toHaveLength(1);
    const labelIds = writes[0].variables.labelIds as string[];
    // Regression: the inherited cross-team label must NOT be carried into the write.
    expect(labelIds).not.toContain(INHERITED_XFN_LABEL_ID);
    // Same-team label preserved, and the new wf/state labels stamped.
    expect(labelIds).toContain("lif-cr-lbl");
    expect(labelIds).toContain("wf-devimpl-lbl");
    expect(labelIds).toContain("state-intake-lbl");
  });

  it("autoEnrollPlainDelegation omits the inherited parent-team xfn label from the enrollment write", async () => {
    const { fetch: mock, writes } = makeEnrollFetch();
    globalThis.fetch = mock;

    // delegateAgentName=null skips the owner-role gate; workflow resolves via
    // enrollment-policy.ts (INF-1237), which falls back to chore:intake.
    const result = await autoEnrollPlainDelegation(ISSUE_UUID, "Bearer tok", undefined, undefined, null);

    expect(result.enrolled).toBe(true);
    expect(writes).toHaveLength(1);
    const labelIds = writes[0].variables.labelIds as string[];
    expect(labelIds).not.toContain(INHERITED_XFN_LABEL_ID);
    expect(labelIds).toContain("lif-cr-lbl");
    expect(labelIds).toContain("wf-chore-lbl");
    expect(labelIds).toContain("state-intake-lbl");
  });
});
