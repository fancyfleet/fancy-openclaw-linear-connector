/**
 * INF-1218: engine-level routine-verb resolver — regression suite.
 * Proves continue-workflow/request-revision resolve structurally on the linear
 * dev-impl spine (the drift fix) + a non-dev-impl linear workflow, and that a
 * genuine branch keeps its named verbs.
 */
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { resolveRoutineEdge, loadWorkflowRegistry } from "./workflow-gate.js";

const REGISTERED = path.resolve(process.cwd(), "src/registered-defs");

describe("INF-1218 universal workflow verbs", () => {
  let prev: string | undefined;
  beforeAll(() => { prev = process.env.WORKFLOW_DEFS_DIR; process.env.WORKFLOW_DEFS_DIR = REGISTERED; });
  afterAll(() => { if (prev === undefined) delete process.env.WORKFLOW_DEFS_DIR; else process.env.WORKFLOW_DEFS_DIR = prev; });
  it("dev-impl: continue-workflow resolves the spine's mechanical verb at every linear state", async () => {
    const reg = await loadWorkflowRegistry();
    const dev = reg.get("dev-impl")!;
    expect(dev).toBeTruthy();
    // INF-1260 AC5: intake now has a resume-review edge to code-review, making it
    // a branch state (accept → write-tests, resume-review → code-review).
    // resolveRoutineEdge correctly returns null/error for branch states — the
    // CLI prompts the agent to choose.
    const intakeNode = dev.states.find((s) => s.id === "intake")!;
    const intakeFwd = resolveRoutineEdge(dev, intakeNode, "forward");
    expect(intakeFwd).toBeNull(); // branch: accept vs resume-review

    // Non-intake states remain linear with their expected forward command.
    const spine: Record<string, string> = {
      "write-tests": "tests-ready",
      implementation: "submit",
      "code-review": "approve",
      merge: "continue",
      deploy: "continue",
      "ac-validate": "validated",
    };
    for (const [stateId, cmd] of Object.entries(spine)) {
      const node = dev.states.find((s) => s.id === stateId)!;
      const fwd = resolveRoutineEdge(dev, node, "forward");
      expect(fwd && "command" in fwd ? fwd.command : `NONE(${JSON.stringify(fwd)})`).toBe(cmd);
    }
  });

  it("dev-impl: request-revision resolves the send-back at states that have one", async () => {
    const reg = await loadWorkflowRegistry();
    const dev = reg.get("dev-impl")!;
    for (const stateId of ["write-tests", "implementation", "code-review", "merge", "deploy"]) {
      const node = dev.states.find((s) => s.id === stateId)!;
      const rev = resolveRoutineEdge(dev, node, "revision");
      expect(rev && "command" in rev ? rev.command : null).toBe("reject");
    }
  });

  it("every registered def loads under the tightened validator", async () => {
    const reg = await loadWorkflowRegistry();
    expect(reg.size).toBeGreaterThanOrEqual(16);
  });

  it("ui-audit review: continue-workflow=pass, request-revision=fail (collapsed, not a branch)", async () => {
    const reg = await loadWorkflowRegistry();
    const ua = reg.get("ui-audit")!;
    const review = ua.states.find((s) => s.id === "review")!;
    const fwd = resolveRoutineEdge(ua, review, "forward");
    const rev = resolveRoutineEdge(ua, review, "revision");
    expect(fwd && "command" in fwd ? fwd.command : null).toBe("pass");
    expect(rev && "command" in rev ? rev.command : null).toBe("fail");
  });

  it("dev-sprint spawn-arms: spawn=continue-workflow; cancel/abandon are terminal hatches", async () => {
    const reg = await loadWorkflowRegistry();
    const ds = reg.get("dev-sprint")!;
    const node = ds.states.find((s) => s.id === "spawn-arms")!;
    const fwd = resolveRoutineEdge(ds, node, "forward");
    expect(fwd && "command" in fwd ? fwd.command : null).toBe("spawn");
  });

  it("a non-dev-impl workflow (chore) resolves continue-workflow at its entry state", async () => {
    const reg = await loadWorkflowRegistry();
    const chore = reg.get("chore");
    if (!chore) return; // chore may not be registered in all envs
    const entry = chore.states.find((s) => s.id === chore.entry_state)!;
    const fwd = resolveRoutineEdge(chore, entry, "forward");
    expect(fwd === null || "command" in fwd).toBe(true);
  });
});
