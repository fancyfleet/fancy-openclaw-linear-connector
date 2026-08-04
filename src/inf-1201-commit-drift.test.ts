import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCommitDrift } from "./startup-commit.js";

/**
 * INF-1201: deploy-marker vs actually-running-commit drift.
 *
 * The running process caches its commit at boot. A deploy can re-stamp
 * dist/DEPLOY_COMMIT and check out a new commit without restarting the process,
 * leaving it running old code while every observer reads the marker and
 * believes the fix is live. resolveCommitDrift() makes that gap observable.
 */
describe("resolveCommitDrift (INF-1201)", () => {
  let dir: string;
  let head: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "commit-drift-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "head"],
      { cwd: dir },
    );
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim();
    await mkdir(path.join(dir, "dist"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports no drift when running matches the marker and git HEAD", async () => {
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), `${head}\n`);
    const result = await resolveCommitDrift(head, { cwd: dir });
    expect(result).toEqual({ running: head, deployMarker: head, gitHead: head, drift: false });
  });

  it("raises drift when the marker was re-stamped past the running commit (stamped-but-not-restarted)", async () => {
    // The process booted on an older commit; a later deploy stamped a newer one
    // but never restarted this process — the exact INF-1147/INF-1176 defect.
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "cd5fcd67\n");
    const result = await resolveCommitDrift("b7b607b9", { cwd: dir });
    expect(result.drift).toBe(true);
    expect(result.deployMarker).toBe("cd5fcd67");
    expect(result.running).toBe("b7b607b9");
  });

  it("raises drift when git HEAD advanced past the running commit", async () => {
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "b7b607b9\n");
    const result = await resolveCommitDrift("b7b607b9", { cwd: dir });
    // marker agrees with running, but the checked-out HEAD does not.
    expect(result.gitHead).toBe(head);
    expect(result.drift).toBe(true);
  });

  it("does not raise drift on short-SHA length differences (8-char stamp vs 7-char HEAD)", async () => {
    // The deploy stamp is 8 chars while `git rev-parse --short` defaults to 7,
    // so a naive strict-equality compare would report a false drift. The
    // running commit and marker here are the 8-char form of the same commit
    // `gitHead` resolves to at 7 chars — a shared prefix, not real drift.
    const eightChar = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
      .toString()
      .trim()
      .slice(0, 8);
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), `${eightChar}\n`);
    const result = await resolveCommitDrift(eightChar, { cwd: dir });
    expect(eightChar.startsWith(result.gitHead)).toBe(true);
    expect(result.drift).toBe(false);
  });

  it("never raises drift when the marker is absent (dev mode) and HEAD matches", async () => {
    // No dist/DEPLOY_COMMIT written → marker "unknown", which must not alarm.
    const result = await resolveCommitDrift(head, { cwd: dir });
    expect(result.deployMarker).toBe("unknown");
    expect(result.drift).toBe(false);
  });

  it("never raises drift when the running commit is unknown", async () => {
    await writeFile(path.join(dir, "dist", "DEPLOY_COMMIT"), "cd5fcd67\n");
    const result = await resolveCommitDrift("unknown", { cwd: dir });
    expect(result.drift).toBe(false);
  });
});
