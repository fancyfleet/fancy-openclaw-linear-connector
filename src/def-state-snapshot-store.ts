/**
 * AI-1914 — Persisted def-state snapshot store (AC3 support).
 *
 * The AC3 validator `validateDefStateRemovals(previousStateIds, nextDef)` needs a
 * source of the PREVIOUS version's state-id set to decide whether the incoming def
 * removes a state without a migration mapping or a strand acknowledgement. That
 * source must survive a connector restart — after a restart there is no prior
 * in-memory registry cache to diff against, so an in-memory-only baseline would
 * fail open on exactly the deploy (restart) where a new def version activates.
 *
 * This store persists, per workflow def id, the state-id list of the last
 * SUCCESSFULLY ACTIVATED def version to a JSON file on disk. On the next
 * registry load, `loadWorkflowRegistry` reads the recorded snapshot as
 * `previousStateIds` and refuses to activate a def that removes a state without a
 * path (AC3). A def that fails validation is NOT recorded, so its prior good
 * baseline is preserved until the operator fixes the def.
 *
 * Storage path resolves as: the explicit DEF_STATE_SNAPSHOTS_PATH override, else
 * `<DATA_DIR>/def-state-snapshots.json`, using the same
 * `process.env.DATA_DIR ?? <cwd>/data` convention every other connector store
 * uses (see src/ac-record-store.ts, src/db.ts). jest.setup.ts points DATA_DIR at
 * a fresh temp dir per test file, so the snapshot file is isolated per test file
 * and never touches live deployment state.
 *
 * Fail-open on I/O: a missing/corrupt snapshot file yields an empty baseline
 * (⇒ nothing looks removed ⇒ activation proceeds), matching the fail-open posture
 * of the other connector stores. The fail-CLOSED decision (refusing activation
 * when a removal IS detected) lives in loadWorkflowRegistry, not here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "def-state-snapshot-store");

/**
 * Resolve the on-disk path for persisted def-state snapshots.
 *
 * Precedence: the explicit DEF_STATE_SNAPSHOTS_PATH override, else the shared
 * data directory (`DATA_DIR` env, else `<cwd>/data`) joined with
 * "def-state-snapshots.json". Resolved at call time — not module load — so
 * DATA_DIR / DEF_STATE_SNAPSHOTS_PATH set by tests before the first store
 * operation are honored.
 */
export function defStateSnapshotsPath(): string {
  if (process.env.DEF_STATE_SNAPSHOTS_PATH) return process.env.DEF_STATE_SNAPSHOTS_PATH;
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "def-state-snapshots.json");
}

/** The recorded state-id set of the last activated version of a workflow def. */
export interface DefStateSnapshot {
  /** State ids present in the last successfully activated def version. */
  stateIds: string[];
  /** Def version at the time of recording (observability only; comparison is by state set). */
  version?: number;
  /** ISO timestamp when the snapshot was recorded. */
  recordedAt: string;
}

/** In-memory store: workflow def id → snapshot. */
const _store = new Map<string, DefStateSnapshot>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/**
 * Load persisted snapshots from disk. Idempotent — only loads once.
 * Fail-open: a missing or corrupt file starts an empty store and logs.
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(defStateSnapshotsPath(), "utf8");
    const data = JSON.parse(raw) as Record<string, DefStateSnapshot>;
    for (const [key, snap] of Object.entries(data)) {
      if (snap && Array.isArray(snap.stateIds)) _store.set(key, snap);
    }
    log.info(`def-state-snapshot-store: loaded ${_store.size} snapshot(s) from ${defStateSnapshotsPath()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`def-state-snapshot-store: no snapshot file at ${defStateSnapshotsPath()} — starting fresh`);
    } else {
      log.warn(`def-state-snapshot-store: failed to load snapshots from ${defStateSnapshotsPath()}: ${msg}`);
    }
  }
}

/** Persist the current store to disk. Fail-open: logs errors but never throws. */
async function persist(): Promise<void> {
  try {
    const data: Record<string, DefStateSnapshot> = {};
    for (const [key, snap] of _store) data[key] = snap;
    const target = defStateSnapshotsPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`def-state-snapshot-store: failed to persist snapshots to ${defStateSnapshotsPath()}: ${msg}`);
  }
}

/**
 * Return the recorded state-id list for a def's previous activated version,
 * or null if none has been recorded yet (first-ever load ⇒ no removal baseline).
 */
export async function getDefStateSnapshot(defId: string): Promise<string[] | null> {
  await ensureLoaded();
  const snap = _store.get(defId);
  return snap ? [...snap.stateIds] : null;
}

/**
 * Record the state-id set of a def version that has just passed validation and
 * been activated. Overwrites the prior snapshot for that def id (rolling
 * baseline: the previous version is always the immediately-preceding activated
 * one). Persists to disk so the baseline survives a restart.
 */
export async function recordDefStateSnapshot(
  defId: string,
  stateIds: string[],
  version?: number,
): Promise<void> {
  await ensureLoaded();
  const existing = _store.get(defId);
  // Avoid a redundant disk write when the activated state set is unchanged.
  if (existing && existing.stateIds.length === stateIds.length &&
      existing.stateIds.every((s, i) => s === stateIds[i]) && existing.version === version) {
    return;
  }
  _store.set(defId, { stateIds: [...stateIds], version, recordedAt: new Date().toISOString() });
  await persist();
}

/** Clear the in-memory snapshot cache + reload flag (the durable on-disk baseline
 *  is NOT deleted). Called by resetWorkflowCache so a reload re-reads from disk. */
export function clearDefStateSnapshotStore(): void {
  _store.clear();
  _loaded = false;
}

// ── AC3 removal guard arming ─────────────────────────────────────────────────
// The def-state-removal check + snapshot recording in loadWorkflowRegistry are
// active only when the guard is armed. The production entry point arms it at
// bootstrap (see index.ts / createApp), so the initial and every subsequent
// registry load is protected. The general test population never arms it — so
// unrelated tests that load differently-shaped fixtures under the same def id
// (independent scenarios, not sequential versions) are not diffed against each
// other. This mirrors the AC6 load-sweep auth-token gate: load-bearing for test
// isolation, not cosmetic. Arming survives resetWorkflowCache (live-reload) so a
// live def edit is still checked without a restart.

let _guardArmed = false;

/** Arm the def-state-removal guard. Idempotent. Called at production bootstrap. */
export function armDefStateRemovalGuard(): void {
  _guardArmed = true;
}

/** Whether the def-state-removal guard is armed. */
export function isDefStateRemovalGuardArmed(): boolean {
  return _guardArmed;
}

/** Disarm the guard. Test seam only — never called in production. */
export function disarmDefStateRemovalGuard(): void {
  _guardArmed = false;
}
