import { execFile } from "node:child_process";
import { createModuleLogger } from "./logging.js";
import { notify } from "./alerts/alert-bus.js";
import { registerCron, markCronRun, formatIntervalMs } from "./cron/registry.js";

const log = createModuleLogger("deploy-drift");

export interface DeployDriftCheckOptions {
  getLiveCommit: () => Promise<string>;
  getMainCommit: () => Promise<string>;
  onDrift?: (info: DeployDriftCheckResult) => void;
}

export interface DeployDriftCheckResult {
  liveCommit: string | null;
  mainCommit: string | null;
  driftDetected: boolean;
  alertRaised: boolean;
  checkedAt: string;
}

/**
 * Live and main commits are independently-abbreviated git SHAs of possibly
 * different lengths (resolveStartupCommit's `git rev-parse --short HEAD` picks
 * a dynamic disambiguation length; resolveMainCommit() hardcodes 7 chars) — the
 * same commit can legitimately show up as "34e8130c" on one side and "34e8130"
 * on the other. Compare on the shorter common prefix rather than raw equality
 * so that length alone never manufactures a false drift alert.
 */
function commitsMatch(a: string, b: string): boolean {
  const len = Math.min(a.length, b.length);
  if (len === 0) return a === b;
  return a.slice(0, len) === b.slice(0, len);
}

export async function checkDeployDrift(opts: DeployDriftCheckOptions): Promise<DeployDriftCheckResult> {
  const checkedAt = new Date().toISOString();
  const [liveResult, mainResult] = await Promise.allSettled([opts.getLiveCommit(), opts.getMainCommit()]);
  const liveCommit = liveResult.status === "fulfilled" ? liveResult.value : null;
  const mainCommit = mainResult.status === "fulfilled" ? mainResult.value : null;
  const resolvedBoth = liveResult.status === "fulfilled" && mainResult.status === "fulfilled";
  // A failure to resolve either side must NEVER collapse to driftDetected: false —
  // that would be a false-positive "healthy" during an outage of the check itself.
  const driftDetected = resolvedBoth ? !commitsMatch(liveCommit as string, mainCommit as string) : true;
  const alertRaised = driftDetected;
  const result: DeployDriftCheckResult = { liveCommit, mainCommit, driftDetected, alertRaised, checkedAt };
  if (alertRaised) {
    opts.onDrift?.(result);
  }
  return result;
}

export interface DeployDriftCronOptions extends DeployDriftCheckOptions {
  cadenceMs?: number;
}

export interface DeployDriftHealthState {
  scheduled: boolean;
  driftDetected: boolean;
  alertRaised: boolean;
  liveCommit: string | null;
  mainCommit: string | null;
  lastCheckAt: string | null;
}

const DEFAULT_CADENCE_MS = 15 * 60 * 1000;
const CRON_NAME = "deploy-drift";

let healthState: DeployDriftHealthState = {
  scheduled: false,
  driftDetected: false,
  alertRaised: false,
  liveCommit: null,
  mainCommit: null,
  lastCheckAt: null,
};
let activeOptions: DeployDriftCronOptions | null = null;

function defaultOnDrift(info: DeployDriftCheckResult): void {
  const msg = `[deploy-drift] ALERT — live/main commit drift. live=${info.liveCommit} main=${info.mainCommit} checkedAt=${info.checkedAt}`;
  log.error(msg);
  notify({
    severity: "critical",
    source: "deploy-drift",
    title: "Deploy drift: live commit diverged from main",
    detail: `live=${info.liveCommit} main=${info.mainCommit} checkedAt=${info.checkedAt}`,
    dedupKey: "deploy-drift|live-main",
  });
}

async function performCheck(): Promise<DeployDriftCheckResult> {
  if (!activeOptions) throw new Error("deploy-drift: performCheck called before registerDeployDriftCron");
  const options = activeOptions;
  const result = await checkDeployDrift({
    getLiveCommit: options.getLiveCommit,
    getMainCommit: options.getMainCommit,
    onDrift: (info) => {
      defaultOnDrift(info);
      options.onDrift?.(info);
    },
  });
  healthState = {
    scheduled: true,
    driftDetected: result.driftDetected,
    alertRaised: result.alertRaised,
    liveCommit: result.liveCommit,
    mainCommit: result.mainCommit,
    lastCheckAt: result.checkedAt,
  };
  markCronRun(CRON_NAME);
  return result;
}

/** Register the live/main drift detector as an in-process recurring job. */
export function registerDeployDriftCron(options: DeployDriftCronOptions): void {
  activeOptions = options;
  const cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;
  registerCron(CRON_NAME, `every ${formatIntervalMs(cadenceMs)}`);
  healthState = { ...healthState, scheduled: true };
  // Fire an immediate check so /health is observable without waiting for the
  // cadence to elapse (AC6), and so deploy churn can't starve the first check
  // until the interval's first tick (INF-1263 AC3) — not awaited; production
  // callers see it land on the next event-loop tick, tests use
  // runDeployDriftCheckForTest() instead.
  setTimeout(() => {
    performCheck().catch((err) => {
      log.error(`[deploy-drift] initial check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 0);
  const timer = setInterval(() => {
    performCheck().catch((err) => {
      log.error(`[deploy-drift] scheduled check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, cadenceMs);
  timer.unref();
  log.info(`[deploy-drift] scheduled every ${cadenceMs}ms`);
}

/** Test-only: force a synchronous check without waiting for the interval. */
export async function runDeployDriftCheckForTest(): Promise<DeployDriftCheckResult> {
  return performCheck();
}

export function getDeployDriftState(): DeployDriftHealthState {
  return { ...healthState };
}

export function resetDeployDriftStateForTest(): void {
  healthState = {
    scheduled: false,
    driftDetected: false,
    alertRaised: false,
    liveCommit: null,
    mainCommit: null,
    lastCheckAt: null,
  };
  activeOptions = null;
}

/**
 * Production getMainCommit: read-only `git ls-remote` against origin/main —
 * does NOT fetch/checkout/reset, so it cannot race the deploy script's own
 * git operations against the same working tree (AI-1832 deploy worktree is
 * shared between this live process and periodic deploys).
 */
export async function resolveMainCommit(opts: { cwd?: string } = {}): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], { cwd }, (err, stdout) => {
      if (err) return reject(err);
      const sha = stdout.trim().split(/\s+/)[0];
      if (!sha) return reject(new Error("git ls-remote returned no SHA for origin/main"));
      resolve(sha.slice(0, 7));
    });
  });
}
