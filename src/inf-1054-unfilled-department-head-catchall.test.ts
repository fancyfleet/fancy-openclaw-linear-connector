/**
 * INF-1054 — `wf:task submit` must not wedge when a department's head seat is
 * unfilled.
 *
 * INF-784 scoped `department-head` resolution so ENG→charles and DSN→laren. But
 * that scoped branch (escalation-gate.ts) filters candidates down to bodies that
 * *carry* a department scope, silently dropping the UNSCOPED catch-all head that
 * the live policy configures (astrid fills `department-head` with no
 * `departments`, mirrored in inf-128-task-lifecycle-multibody-requester.test.ts).
 *
 * Consequence: a `wf:task` whose department has no scoped head (e.g. an INF/OPS
 * ticket, with only ENG/DSN heads staffed) resolves `department-head` to `[]`.
 * The `submit` transition (doing→review, `assign: { mode: auto }`) then
 * fail-closes with delegate-unresolved and the ticket bounces in a stale-session
 * recovery loop — exactly the failure INF-1054 was filed against.
 *
 * task.yaml's design is explicit: "Astrid is the catch-all head/reviewer when no
 * department matches." These tests pin that: a scoped head still wins for its own
 * department, but an unfilled/mismatched department falls back to the unscoped
 * catch-all head instead of resolving to nobody.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { resolveBodiesForRole, resetPolicyCache } from "./escalation-gate.js";

// Live-shape policy: astrid is the UNSCOPED catch-all head (fills department-head
// with no departments), alongside the two scoped departmental heads.
const POLICY_WITH_CATCHALL_HEAD = `
capabilities:
  - id: linear:transition
containers:
  - id: lead
    grants: [linear:transition]
  - id: steward
    grants: [linear:transition]
roles:
  - id: department-head
    requires: [linear:transition]
  - id: steward
    requires: [linear:transition]
bodies:
  - id: astrid
    container: steward
    fills_roles: [department-head, steward]
  - id: charles
    container: lead
    fills_roles: [department-head]
    departments: [ENG]
    teams: [Engineering]
  - id: laren
    container: lead
    fills_roles: [department-head]
    departments: [DSN]
    teams: [Design]
`;

describe("INF-1054: unfilled department-head falls back to the unscoped catch-all", () => {
  let tmpDir: string;
  const oldPolicyPath = process.env.CAPABILITY_POLICY_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1054-policy-"));
    fs.writeFileSync(path.join(tmpDir, "policy.yaml"), POLICY_WITH_CATCHALL_HEAD, "utf8");
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    resetPolicyCache();
  });

  afterEach(() => {
    if (oldPolicyPath === undefined) delete process.env.CAPABILITY_POLICY_PATH;
    else process.env.CAPABILITY_POLICY_PATH = oldPolicyPath;
    resetPolicyCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const resolve = resolveBodiesForRole as unknown as (
    roleId: string,
    scope: { department?: string; team?: string },
  ) => Promise<string[]>;

  it("a staffed department still resolves to its own scoped head (catch-all does not leak in)", async () => {
    await expect(resolve("department-head", { department: "ENG", team: "Engineering" })).resolves.toEqual(["charles"]);
    await expect(resolve("department-head", { department: "DSN", team: "Design" })).resolves.toEqual(["laren"]);
  });

  it("an unfilled department falls back to the unscoped catch-all head", async () => {
    await expect(resolve("department-head", { department: "OPS", team: "Operations" })).resolves.toEqual(["astrid"]);
  });

  it("a department/team mismatch falls back to the catch-all rather than resolving to nobody", async () => {
    await expect(resolve("department-head", { department: "ENG", team: "Design" })).resolves.toEqual(["astrid"]);
    await expect(resolve("department-head", { department: "DSN", team: "Engineering" })).resolves.toEqual(["astrid"]);
  });

  it("still refuses to resolve department-head with no scope at all", async () => {
    await expect(resolve("department-head", {})).rejects.toThrow(/department|team|scope/i);
  });

  it("does not disturb non-department-head role resolution", async () => {
    await expect(resolve("steward", { department: "OPS", team: "Operations" })).resolves.toEqual(["astrid"]);
  });
});
