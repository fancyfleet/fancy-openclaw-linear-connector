/**
 * INF-996 PR-B: bound-role delegate resolution.
 *
 * A state declared `owner_binding: bound` resolves its delegate from the pinned
 * binding (implementer-store), never from the capability-policy role pool. These
 * tests exercise the pre-compute resolver `resolveTransitionDelegate` directly:
 *  - bound role + a binding  → returns the pinned body (the pin wins over the pool)
 *  - bound role, no binding   → falls through (nothing to pin yet)
 *  - static role + a binding  → the binding is IGNORED (gated on owner_binding)
 *  - explicit CLI target      → still wins over the pin (steward re-bind path)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTransitionDelegate } from "./workflow-gate.js";
import type { WorkflowDef } from "./workflow-gate.js";
import { reloadAgents } from "./agents.js";
import { recordBinding, clearImplementerStore } from "./implementer-store.js";

const ISSUE = "issue-bound-1";

function writeAgents(dir: string): void {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "t", host: "local", app: true },
        { name: "sage", linearUserId: "u-sage", openclawAgent: "sage", accessToken: "t", host: "local", app: true },
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "t", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = file;
  reloadAgents();
}

/** Minimal def: one bound state and one static state, same owner_role. */
function makeDef(): WorkflowDef {
  return {
    id: "chore",
    version: 1,
    entry_state: "intake",
    states: [
      { id: "implementation", owner_role: "dev", owner_binding: "bound", kind: "normal", transitions: [] },
      { id: "static-impl", owner_role: "dev", kind: "normal", transitions: [] },
    ],
  } as unknown as WorkflowDef;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf996-bound-"));
  process.env.IMPLEMENTER_STORE_PATH = path.join(dir, "store.json");
  clearImplementerStore();
  writeAgents(dir);
});

afterEach(() => {
  clearImplementerStore();
  delete process.env.IMPLEMENTER_STORE_PATH;
  delete process.env.AGENTS_FILE;
});

describe("INF-996 PR-B — bound-role resolution", () => {
  it("resolves a bound role to the pinned body (not the pool)", async () => {
    await recordBinding(ISSUE, "dev", "igor", "chore");
    const delegate = await resolveTransitionDelegate("implementation", undefined, makeDef(), ISSUE);
    expect(delegate).toBe("u-igor");
  });

  it("returns undefined for a bound role with no binding yet (first entry / capture pending)", async () => {
    const delegate = await resolveTransitionDelegate("implementation", undefined, makeDef(), ISSUE);
    // No CLI target, no prior-implementer, no policy in the test → nothing to resolve.
    expect(delegate).toBeUndefined();
  });

  it("IGNORES a binding for a static role (gated strictly on owner_binding: bound)", async () => {
    await recordBinding(ISSUE, "dev", "igor", "chore");
    // Same role + a binding, but the state is static → the bound step must not fire.
    const delegate = await resolveTransitionDelegate("static-impl", undefined, makeDef(), ISSUE);
    expect(delegate).toBeUndefined();
  });

  it("an explicit CLI target still wins over the pin (steward re-bind path)", async () => {
    await recordBinding(ISSUE, "dev", "igor", "chore");
    const delegate = await resolveTransitionDelegate("implementation", undefined, makeDef(), ISSUE, "sage");
    expect(delegate).toBe("u-sage");
  });
});
