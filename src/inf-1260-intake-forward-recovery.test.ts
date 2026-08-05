/**
 * INF-1260: governed forward-recovery edge from `intake` with prior progress.
 *
 * Bug (AC5): a ticket bounced (or escaped) back to `intake` with work already
 * done — PR open, tests green — has no governed forward verb back to
 * `code-review`/implementation. Per src/registered-defs/dev-impl.yaml:112-136,
 * `intake`'s only transitions are:
 *   - `accept`      -> write-tests   (re-runs the TDD gate from scratch)
 *   - `demote`      -> __ad_hoc__    (leaves the workflow)
 *   - `force-deploy` -> deploy       (INF-867: skips straight to deploy, not review)
 *   - `handoff`     -> intake        (self-loop)
 * There is no `intake -> code-review` (or equivalent "resume review") edge, so
 * an operator recovering a ticket with completed work is forced to either
 * demote it out of governance or re-run write-tests/implementation from
 * scratch (or force-deploy straight past review) — exactly the AC5 gap.
 *
 * This test drives the REAL production workflow definition
 * (src/registered-defs/dev-impl.yaml, read-only — not modified) and asserts
 * the desired governed recovery verb ("resume-review": intake -> code-review)
 * is legal. It is RED today because no such transition is declared.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { checkWorkflowRules, resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION_DEV_IMPL_YAML_PATH = path.resolve(
  __dirname,
  "registered-defs/dev-impl.yaml",
);

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: workflow:break-glass
  - id: linear:transition
containers:
  - id: steward
    grants: [linear:transition, human:escalate, workflow:break-glass]
roles:
  - id: steward
    requires: [human:escalate]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeIntakeContextFetch(delegateLinearId: string): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
    const query = body.query ?? "";
    if (query.includes("IssueContext")) {
      return jsonResponse({
        data: {
          issue: {
            identifier: "INF-1260-RECOVER",
            labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:intake" }] },
            delegate: { id: delegateLinearId },
            state: { type: "unstarted", name: "Todo" },
          },
        },
      });
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  };
}

describe("INF-1260 AC5 (intake forward-recovery): a governed edge must exist from intake to code-review for tickets with prior progress", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalWorkflowDefPath: string | undefined;
  let originalCapabilityPolicyPath: string | undefined;

  beforeEach(() => {
    originalWorkflowDefPath = process.env.WORKFLOW_DEF_PATH;
    originalCapabilityPolicyPath = process.env.CAPABILITY_POLICY_PATH;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf1260-intake-recovery-"));
    // Drive the REAL production workflow definition — this test is about a
    // gap in that exact file, not a synthetic fixture. The file is only read.
    process.env.WORKFLOW_DEF_PATH = PRODUCTION_DEV_IMPL_YAML_PATH;
    const policyFile = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
    process.env.CAPABILITY_POLICY_PATH = policyFile;
    resetWorkflowCache();
    resetPolicyCache();
    resetConfigHealth();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });

    if (originalWorkflowDefPath !== undefined) process.env.WORKFLOW_DEF_PATH = originalWorkflowDefPath;
    else delete process.env.WORKFLOW_DEF_PATH;
    if (originalCapabilityPolicyPath !== undefined) process.env.CAPABILITY_POLICY_PATH = originalCapabilityPolicyPath;
    else delete process.env.CAPABILITY_POLICY_PATH;
  });

  it("AC7(intake forward-recovery): 'resume-review' from intake (PR already open, tests green) is a legal governed transition to code-review", async () => {
    globalThis.fetch = makeIntakeContextFetch("astrid-linear-uid");

    const result = await checkWorkflowRules(
      "resume-review",
      "INF-1260-RECOVER",
      "Bearer tok",
      "astrid",
      null,
      "astrid-linear-uid",
    );

    // Desired: a governed recovery verb exists to skip straight back to
    // code-review without re-running write-tests/implementation. Today no
    // 'resume-review' command is declared anywhere in dev-impl.yaml's
    // `intake` state, so checkWorkflowRules rejects it with a
    // not-a-legal-command error — RED.
    expect(result).toBeNull();
  });

  it("AC7(intake forward-recovery): the plain 'accept' path (full TDD re-run) remains the ONLY legal forward edge today (documents the gap)", async () => {
    globalThis.fetch = makeIntakeContextFetch("astrid-linear-uid");

    const acceptResult = await checkWorkflowRules(
      "accept",
      "INF-1260-RECOVER",
      "Bearer tok",
      "astrid",
      null,
      "astrid-linear-uid",
    );
    expect(acceptResult).toBeNull();

    const resumeResult = await checkWorkflowRules(
      "resume-review",
      "INF-1260-RECOVER",
      "Bearer tok",
      "astrid",
      null,
      "astrid-linear-uid",
    );
    // Today 'resume-review' is illegal while 'accept' is the only legal
    // forward path — the exact AC5 gap (no shortcut back to code-review).
    expect(resumeResult).not.toBeNull();
  });
});
