import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface StartupCommitResult {
  commit: string;
  /** Where the commit came from: the deploy stamp, git HEAD, or neither. */
  source: "deploy-stamp" | "git" | "unknown";
}

/**
 * Resolve the commit that /health reports (AI-1841).
 *
 * Under the AI-1832 deploy model the shared working tree is never touched by
 * deploys and may sit on an unrelated feature branch, so `git rev-parse HEAD`
 * says nothing about the code actually running. The deploy script stamps the
 * deployed commit into dist/DEPLOY_COMMIT for exactly this reason — prefer
 * that stamp, and fall back to git HEAD only when it is absent (dev mode,
 * `npm run dev`, test runs).
 */
export async function resolveStartupCommit(
  opts: { deployCommitPath?: string; cwd?: string } = {},
): Promise<StartupCommitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const stampPath = opts.deployCommitPath ?? path.join(cwd, "dist", "DEPLOY_COMMIT");
  try {
    const stamped = (await readFile(stampPath, "utf8")).trim();
    if (stamped) return { commit: stamped, source: "deploy-stamp" };
  } catch {
    // Stamp absent or unreadable — fall through to git.
  }
  const commit = await new Promise<string>((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd }, (err, stdout) => {
      resolve(err ? "unknown" : stdout.trim());
    });
  });
  return { commit, source: commit === "unknown" ? "unknown" : "git" };
}

export interface CommitDrift {
  /**
   * The commit THIS process is actually running — captured at boot and
   * immutable for the process lifetime (the `commit` /health already reports).
   */
  running: string;
  /** dist/DEPLOY_COMMIT as it reads on disk right now (latest deploy intent). */
  deployMarker: string;
  /** git HEAD of the runtime tree right now (what is currently checked out). */
  gitHead: string;
  /**
   * True when the running commit no longer matches a *known* deploy marker or a
   * *known* checked-out HEAD — i.e. a newer commit was stamped/checked-out but
   * this process was never restarted onto it (the INF-1147/INF-1176
   * "marked-deployed but not live" class defect), or the boot-time marker read
   * lagged the built code. `unknown` values (dev mode / stamp absent / no repo)
   * never raise drift — the alarm requires a concrete disagreement between two
   * real commits.
   */
  drift: boolean;
}

/**
 * Detect deploy-marker vs actually-running-commit drift (INF-1201).
 *
 * A deploy re-stamps dist/DEPLOY_COMMIT and checks out the new commit, but the
 * running Node process keeps whatever code it loaded at boot until it is
 * restarted. Nothing detected that gap, so a "deployed" fix could silently not
 * be live for hours while every observer read the marker and believed it was.
 * This live-reads the marker and git HEAD and compares them to `running`
 * (the commit the process booted with) so the gap is observable at /health.
 */
export async function resolveCommitDrift(
  running: string,
  opts: { deployCommitPath?: string; cwd?: string } = {},
): Promise<CommitDrift> {
  const cwd = opts.cwd ?? process.cwd();
  const stampPath = opts.deployCommitPath ?? path.join(cwd, "dist", "DEPLOY_COMMIT");

  let deployMarker = "unknown";
  try {
    const stamped = (await readFile(stampPath, "utf8")).trim();
    if (stamped) deployMarker = stamped;
  } catch {
    // Marker absent or unreadable — dev mode. Leaves deployMarker "unknown".
  }

  const gitHead = await new Promise<string>((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd }, (err, stdout) => {
      resolve(err ? "unknown" : stdout.trim());
    });
  });

  // Short SHAs can differ in length (deploy stamp is 8 chars, `git --short`
  // defaults to 7), so compare by common prefix rather than strict equality.
  const disagrees = (other: string): boolean =>
    other !== "unknown" &&
    running !== "unknown" &&
    !(running.startsWith(other) || other.startsWith(running));

  const drift = disagrees(deployMarker) || disagrees(gitHead);
  return { running, deployMarker, gitHead, drift };
}
