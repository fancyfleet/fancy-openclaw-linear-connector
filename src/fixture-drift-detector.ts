/**
 * AI-1894 AC3: Fixture-drift detector.
 *
 * Compares every deployed workflow definition (from WORKFLOW_DEFS_DIR) against
 * its canonical fixture in src/__fixtures__/. Reports warnings on divergence
 * so a live-config edit without a fixture sync is loud, not silent.
 *
 * A "match" is structural equality: the same YAML-parsed object tree after
 * stripping non-semantic header comments. Version bumps and history comments
 * in the header are NOT structural drift — only state/transition/edge changes.
 *
 * Liveness is observable at /health.fixtureDrift and via the alert bus:
 *   - healthy: all deployed defs have matching canonical fixtures
 *   - unhealthy: drift detected (one or more defs diverge)
 *
 * Design: AI-1894, Pillar 1 — deployed-fixture integrity.
 */

import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { componentLogger, createLogger } from "./logger.js";
import { notify } from "./alerts/alert-bus.js";
import { defaultWorkflowDefPath } from "./instance-config.js";
import { checkDefAgainstFixture, fixturePathFor } from "./fixture-drift-core.js";

export { checkDefAgainstFixture, fixturePathFor } from "./fixture-drift-core.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "fixture-drift");

// ── Types ──────────────────────────────────────────────────────────────────

export interface FixtureDriftEntry {
  /** Workflow def id (e.g. "dev-impl", "task"). */
  workflowId: string;
  /** Release/reload gate verdict for this def. */
  gateVerdict: "served" | "refused";
  /** Human-readable gate reason. */
  reason: string | null;
  /** Loaded workflow def version. */
  version: number | undefined;
  /** Canonical fixture version. */
  fixtureVersion: number | undefined;
  /** Whether the canonical fixture exists for this def. */
  fixtureExists: boolean;
  /** Whether the canonical fixture is structurally in sync. */
  inSync: boolean;
  /** Description of any drift, or null if in sync. */
  driftDescription: string | null;
}

export interface FixtureDriftGateStatus {
  mode: "enforce";
  healthy: boolean;
  refused: number;
  served: number;
  bootFailure: string | null;
}

export interface FixtureDriftStatus {
  /** ISO timestamp of the last check, or null if never run. */
  lastCheck: string | null;
  /** True only when ALL deployed defs have matching canonical fixtures. */
  healthy: boolean;
  /** Release/reload gate summary derived from the same drift check. */
  gate: FixtureDriftGateStatus;
  /** Per-def drift details. */
  entries: FixtureDriftEntry[];
  /** Number of defs with drift. */
  drifted: number;
  /** Total deployed defs checked. */
  total: number;
}

// ── Singleton state ────────────────────────────────────────────────────────

let _status: FixtureDriftStatus = {
  lastCheck: null,
  healthy: true,
  gate: { mode: "enforce", healthy: true, refused: 0, served: 0, bootFailure: null },
  entries: [],
  drifted: 0,
  total: 0,
};

// ── Deployed source discovery ──────────────────────────────────────────────

async function deployedDefSources(): Promise<Array<{ id: string; content: string }>> {
  const dir = process.env.WORKFLOW_DEFS_DIR || process.env.WORKFLOW_DEF_DIR || undefined;
  const files = dir
    ? (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort().map((f) => path.join(dir, f))
    : [process.env.WORKFLOW_DEF_PATH || defaultWorkflowDefPath()];

  const sources: Array<{ id: string; content: string }> = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const parsed = yaml.load(content) as Record<string, unknown> | null;
    const id = parsed && typeof parsed.id === "string"
      ? parsed.id
      : path.basename(file).replace(/\.ya?ml$/i, "");
    sources.push({ id, content });
  }
  return sources;
}

// ── Main check ─────────────────────────────────────────────────────────────

/**
 * Run the full drift check across all loaded workflow defs against their
 * canonical fixtures. Writes to singleton state, alerts on any drift.
 * Never throws — errors are captured as entries.
 */
export async function runFixtureDriftCheck(): Promise<FixtureDriftStatus> {
  try {
    const entries: FixtureDriftEntry[] = [];

    for (const { id, content } of await deployedDefSources()) {
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      const result = await checkDefAgainstFixture(id, content);
      const reason = result.inSync ? null : result.driftDescription;
      const version = parsed && typeof parsed.version === "number" ? parsed.version : undefined;
      entries.push({
        workflowId: id,
        gateVerdict: result.inSync ? "served" : "refused",
        reason,
        version,
        fixtureVersion: result.fixtureVersion,
        fixtureExists: result.fixtureExists,
        inSync: result.inSync,
        driftDescription: result.driftDescription,
      });
    }

    const drifted = entries.filter((e) => !e.inSync).length;
    const healthy = drifted === 0;
    const lastCheck = new Date().toISOString();

    _status = {
      lastCheck,
      healthy,
      gate: {
        mode: "enforce",
        healthy,
        refused: drifted,
        served: entries.length - drifted,
        bootFailure: null,
      },
      entries,
      drifted,
      total: entries.length,
    };

    if (drifted > 0) {
      const driftDetails = entries
        .filter((e) => !e.inSync)
        .map((e) => `${e.workflowId}: ${e.driftDescription}`)
        .join(" | ");
      log.error(`fixture-drift: ${drifted}/${entries.length} def(s) drifted: ${driftDetails}`);
      notify({
        severity: "warning",
        source: "fixture-drift",
        title: `Fixture drift detected — ${drifted}/${entries.length} workflow def(s) out of sync`,
        detail: driftDetails,
        dedupKey: "fixture-drift|drift",
      });
    } else if (entries.length > 0) {
      log.info(`fixture-drift: all ${entries.length} deployed def(s) match canonical fixtures`);
    }

    return _status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fixture-drift check failed to run: ${msg}`);
    _status = {
      lastCheck: new Date().toISOString(),
      healthy: false,
      gate: {
        mode: "enforce",
        healthy: false,
        refused: 0,
        served: 0,
        bootFailure: msg,
      },
      entries: [],
      drifted: 0,
      total: 0,
    };
    return _status;
  }
}

/**
 * Get the latest drift check status (no re-run).
 */
export function getFixtureDriftLiveness(): FixtureDriftStatus {
  return _status;
}

/**
 * Reset status (for tests).
 */
export function resetFixtureDriftStatus(): void {
  _status = {
    lastCheck: null,
    healthy: true,
    gate: { mode: "enforce", healthy: true, refused: 0, served: 0, bootFailure: null },
    entries: [],
    drifted: 0,
    total: 0,
  };
}
