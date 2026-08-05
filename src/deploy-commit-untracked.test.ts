/**
 * INF-1264 AC2 — dist/DEPLOY_COMMIT must not be git-tracked.
 *
 * dist/ is gitignored (.gitignore line 2), but dist/DEPLOY_COMMIT was force-added
 * at some point, so it IS tracked (`git ls-files` includes it today). Because it
 * is tracked, any `git checkout`/`git reset --hard` on a working tree can silently
 * revert the stamp to whatever value was last committed — falsifying "what's
 * deployed" independent of the real running build. The deploy script writes a
 * fresh stamp on every deploy (host-owned/bin/deploy-linear-connector.sh), but a
 * tracked file means git itself is also an authority over the stamp's contents,
 * which is exactly the authority resolveStartupCommit() (src/startup-commit.ts)
 * must not have to share.
 *
 * FAILING today: dist/DEPLOY_COMMIT is currently tracked.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname })
    .toString()
    .trim();
}

describe("dist/DEPLOY_COMMIT git tracking (AC2)", () => {
  it("is NOT present in `git ls-files` — the stamp must not be an object git can revert", () => {
    const root = repoRoot();
    const tracked = execFileSync("git", ["ls-files"], { cwd: root }).toString().split("\n");
    expect(tracked).not.toContain("dist/DEPLOY_COMMIT");
  });

  it("git check-ignore reports dist/DEPLOY_COMMIT as ignored (consistent with the general dist/ rule)", () => {
    const root = repoRoot();
    // check-ignore exits 0 (match) or 1 (no match) or >1 on error; execFileSync
    // throws on non-zero, so capture via try/catch instead of asserting exit code.
    let matched = false;
    try {
      execFileSync("git", ["check-ignore", "-q", "dist/DEPLOY_COMMIT"], { cwd: root });
      matched = true;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      matched = status === 0;
    }
    expect(matched).toBe(true);
  });

  it("a force-tracked file is not resolved as ignored by git status --ignored (regression guard for the specific bug)", () => {
    // This is the concrete failure mode: `git ls-files` and `git status --ignored`
    // disagree about dist/DEPLOY_COMMIT today because it was `git add -f`'d once.
    // Once untracked, both must agree it's ignored and absent from the index.
    const root = repoRoot();
    const lsFiles = execFileSync("git", ["ls-files", "dist/DEPLOY_COMMIT"], { cwd: root }).toString().trim();
    expect(lsFiles).toBe("");
  });
});
