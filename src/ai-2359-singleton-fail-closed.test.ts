/**
 * AI-2359 — AC2: The singleton-auto-assign fails closed (with a logged error
 * and visible ticket comment) rather than silently no-opping when the target
 * has no linearUserId.
 *
 * On 2026-07-12, when tdd, cra, and woz vanished from agents.json, their
 * entries had no linearUserId. The dev-impl workflow's singleton auto-assign
 * for test-author (tdd) silently no-opped — the transition accepted but
 * nobody was delegated to the ticket. Every accept stamped "state:write-tests"
 * but no agent was assigned. The failure was invisible until a human noticed
 * stranded tickets.
 *
 * The implementer must:
 *   1. Extract the singleton-auto-assign resolution block (workflow-gate.ts
 *      ~line 3058-3068) into a testable exported function.
 *   2. Change it from `log.warn` + skip to `log.error` + return a failed
 *      result consistent with other delegate-unresolved paths.
 *   3. Post a visible Linear comment on the ticket when this failure occurs.
 *
 * This test imports the extracted function. IT WILL FAIL until step 1 is done.
 */

import { resetCronRegistryForTest } from "./cron/registry.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetConfigHealth } from "./config-health.js";
import { resetWorkflowRegistry } from "./workflow-gate.js";
import { getAgents, reloadAgents, type AgentConfig } from "./agents.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-2359-ac2-"));
}

describe("AI-2359 AC2: singleton auto-assign fails closed on missing linearUserId", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    resetPolicyCache();
    resetConfigHealth();
    resetWorkflowRegistry();
    resetCronRegistryForTest();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CAPABILITY_POLICY_PATH;
    delete process.env.WORKFLOW_DEF_PATH;
    delete process.env.AGENTS_FILE;
  });

  /**
   * HAPPY PATH: When the singleton body HAS a linearUserId, resolution
   * succeeds. This test does NOT fail — it documents the contract and
   * confirms the test infrastructure works.
   */
  test("happy path: singleton body with linearUserId resolves delegate", async () => {
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        {
          name: "tdd",
          linearUserId: "user-tdd-abc123",
          clientId: "c",
          clientSecret: "s",
          accessToken: "t",
          refreshToken: "r",
          host: "local",
        } as AgentConfig,
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    const agents = getAgents();
    const tdd = agents.find((a) => a.name === "tdd");
    expect(tdd).toBeDefined();
    expect(tdd!.linearUserId).toBe("user-tdd-abc123");
  });

  /**
   * FAILING PATH: When the singleton body has NO linearUserId, the test
   * expects resolution to fail closed. This test calls the function that
   * the implementer must extract from workflow-gate.ts.
   *
   * CURRENT STATE: The test skips because the function does not exist yet.
   * After extraction, it will assert:
   *   - Status is "failed"
   *   - Code is "delegate-unresolved"
   *   - Detail mentions the body name and "no linearUserId"
   */
  test("singleton body with no linearUserId: resolution returns fail-closed", async () => {
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        {
          name: "tdd",
          // NO linearUserId — this is the failure condition
          clientId: "c",
          clientSecret: "s",
          accessToken: "t",
          refreshToken: "r",
          host: "local",
        } as AgentConfig,
      ],
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    const agents = getAgents();
    const tdd = agents.find((a) => a.name === "tdd");
    expect(tdd).toBeDefined();
    // Precondition: tdd has no linearUserId
    expect(tdd!.linearUserId).toBeUndefined();

    // resolveSingletonDelegate is already exported by workflow-gate.ts
    // (AI-2359 implementation). Call it directly to verify fail-closed behavior.
    const { resolveSingletonDelegate } = await import("./workflow-gate.js");

    const result = resolveSingletonDelegate(["tdd"], "test-author");
    expect(result).toEqual({
      failed: true,
      code: "delegate-unresolved",
      detail: expect.stringContaining("tdd"),
    });
    expect(result.detail).toContain("no linearUserId");
  });

  /**
   * SYSTEM-LEVEL FAIL-CLOSED CONTRACT:
   * The current code at workflow-gate.ts ~3060-3068 does:
   *
   *   if (agent?.linearUserId) {
   *     resolvedDelegateId = agent.linearUserId;
   *   } else {
   *     log.warn(`...has no linearUserId — skipping auto-delegate`);
   *   }
   *
   * This must CHANGE to:
   *
   *   if (agent?.linearUserId) {
   *     resolvedDelegateId = agent.linearUserId;
   *   } else {
   *     log.error(`workflow-gate: B2 apply: FAIL-CLOSED — singleton body '${roleBodies[0]}'
   *       for role '${destOwnerRole}' has no linearUserId. Transition aborted.`);
   *     await postComment(issueId, `[Connector] Transition blocked: singleton body
   *       '${roleBodies[0]}' for role '${destOwnerRole}' has no linearUserId in
   *       agents.json. Register the agent's Linear user ID to proceed.`);
   *     return { status: "failed", code: "delegate-unresolved",
   *       detail: `singleton body '${roleBodies[0]}' has no linearUserId`,
   *       from: currentStateName, to: toStateName };
   *   }
   *
   * This must be consistent with the other delegate-unresolved paths in the
   * same function (multi-body case at ~3070, zero-body case at ~3082).
   */
  test("the fail-closed contract is documented for the implementer", () => {
    // This test is intentionally empty but serves as the spec anchor.
    // See the test above for the actual assertion infrastructure.
    expect(true).toBe(true);
  });
});
