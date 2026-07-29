/**
 * AI-1493 / INF-996: Per-ticket role-binding store.
 *
 * Originally the "implementer store" (AI-1493): it recorded the implementer body
 * so `reject`/`request-changes` could route back to the prior implementer without
 * a human choice. INF-996 generalizes it into a **per-ticket, per-role binding
 * store** — the persistence layer for the `owner_binding: bound` primitive
 * (wf:chore's implementer + reviewer are pinned at intake and read back here,
 * never re-resolved from the role pool).
 *
 * A ticket's record holds `bindings: { <role>: <bodyId> }`. The implementer role
 * is the original single-body record; `recordImplementer`/`getImplementer` are
 * kept as thin wrappers over `recordBinding('implementer', …)`/`getBinding(…, 'implementer')`.
 *
 * Back-compat: legacy on-disk records were `{ bodyId, workflowId, recordedAt }`
 * (single body = the implementer). On load they migrate transparently to
 * `{ bindings: { implementer: bodyId }, … }`, so existing prior-implementer data
 * is never stranded.
 *
 * Storage is a JSON file (IMPLEMENTER_STORE_PATH env or /tmp/implementer-store.json
 * by default), keyed by Linear issue UUID.
 *
 * Fail-open: if the store is unavailable, callers fall back to explicit targeting
 * (safe, just not automatic).
 */

import fs from "node:fs/promises";
import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "implementer-store");

/** The role key for the original single-body record (back-compat). */
export const IMPLEMENTER_ROLE = "implementer";

/** Default path for persisted binding records. Override via IMPLEMENTER_STORE_PATH env. */
const DEFAULT_IMPLEMENTER_STORE_PATH = "/tmp/implementer-store.json";

function implementerStorePath(): string {
  return process.env.IMPLEMENTER_STORE_PATH ?? DEFAULT_IMPLEMENTER_STORE_PATH;
}

/** A ticket's bound seats: role → body id. */
export interface BindingRecord {
  bindings: Record<string, string>;
  workflowId: string;
  recordedAt: string;
}

/** Legacy on-disk shape (pre-INF-996): a single implementer body. */
interface LegacyImplementerRecord {
  bodyId: string;
  workflowId: string;
  recordedAt: string;
}

/** In-memory store: Linear issue UUID → BindingRecord. */
const _store = new Map<string, BindingRecord>();

/** Whether the initial load from disk has been attempted. */
let _loaded = false;

/** Normalize a persisted entry (legacy single-body OR new bindings map) to a BindingRecord. */
function normalizeRecord(entry: BindingRecord | LegacyImplementerRecord): BindingRecord | null {
  if (entry && typeof entry === "object" && "bindings" in entry && entry.bindings && typeof entry.bindings === "object") {
    return {
      bindings: { ...entry.bindings },
      workflowId: entry.workflowId ?? "",
      recordedAt: entry.recordedAt ?? new Date(0).toISOString(),
    };
  }
  // Legacy: { bodyId, workflowId, recordedAt } → { bindings: { implementer: bodyId } }
  if (entry && typeof entry === "object" && "bodyId" in entry && typeof entry.bodyId === "string") {
    return {
      bindings: { [IMPLEMENTER_ROLE]: entry.bodyId },
      workflowId: entry.workflowId ?? "",
      recordedAt: entry.recordedAt ?? new Date(0).toISOString(),
    };
  }
  return null;
}

/**
 * Load persisted binding records from disk. Idempotent — only loads once.
 * Fail-open: if the file doesn't exist or is corrupt, start empty and warn.
 * Legacy single-body records migrate to the bindings shape on read.
 */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(implementerStorePath(), "utf8");
    const data = JSON.parse(raw) as Record<string, BindingRecord | LegacyImplementerRecord>;
    let migrated = 0;
    for (const [key, entry] of Object.entries(data)) {
      const record = normalizeRecord(entry);
      if (!record) continue;
      if (!("bindings" in entry)) migrated++;
      _store.set(key, record);
    }
    log.info(
      `implementer-store: loaded ${_store.size} record(s) from ${implementerStorePath()}` +
        (migrated ? ` (migrated ${migrated} legacy single-body record(s) → bindings)` : ""),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.info(`implementer-store: no persisted records file at ${implementerStorePath()} — starting fresh`);
    } else {
      log.warn(`implementer-store: failed to load persisted records from ${implementerStorePath()}: ${msg}`);
    }
  }
}

/** Persist the current store to disk. Fail-open: logs errors but never throws. */
async function persist(): Promise<void> {
  try {
    const data: Record<string, BindingRecord> = {};
    for (const [key, record] of _store) {
      data[key] = record;
    }
    await fs.writeFile(implementerStorePath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`implementer-store: failed to persist records to ${implementerStorePath()}: ${msg}`);
  }
}

/**
 * Bind a role to a body for a ticket. Merges into any existing bindings for the
 * ticket (other roles are preserved). Persists after recording.
 */
export async function recordBinding(issueId: string, role: string, bodyId: string, workflowId: string): Promise<void> {
  await ensureLoaded();
  const existing = _store.get(issueId);
  const bindings = { ...(existing?.bindings ?? {}), [role]: bodyId };
  _store.set(issueId, { bindings, workflowId, recordedAt: new Date().toISOString() });
  log.info(`implementer-store: bound role '${role}' → '${bodyId}' for ${issueId} (workflow: ${workflowId})`);
  await persist();
}

/** Read the bound body for a role on a ticket, or null if not bound. */
export async function getBinding(issueId: string, role: string): Promise<string | null> {
  await ensureLoaded();
  return _store.get(issueId)?.bindings[role] ?? null;
}

/** Read all role bindings for a ticket (a copy), or null if none recorded. */
export async function getBindings(issueId: string): Promise<Record<string, string> | null> {
  await ensureLoaded();
  const record = _store.get(issueId);
  return record ? { ...record.bindings } : null;
}

/**
 * Remove a single role binding for a ticket. If it was the last binding, the
 * ticket record is dropped entirely. Persists after removal.
 */
export async function removeBinding(issueId: string, role: string): Promise<void> {
  await ensureLoaded();
  const record = _store.get(issueId);
  if (!record || !(role in record.bindings)) return;
  delete record.bindings[role];
  if (Object.keys(record.bindings).length === 0) {
    _store.delete(issueId);
  }
  log.info(`implementer-store: removed binding '${role}' for ${issueId}`);
  await persist();
}

/** Drop ALL bindings for a ticket (cleanup on escape/demote/terminal). */
export async function clearTicketBindings(issueId: string): Promise<void> {
  await ensureLoaded();
  if (_store.has(issueId)) {
    _store.delete(issueId);
    log.info(`implementer-store: cleared all bindings for ${issueId}`);
    await persist();
  }
}

// ── Back-compat wrappers (the original implementer API) ──────────────────────

/** Record the implementer for a ticket. Wrapper over recordBinding('implementer'). */
export async function recordImplementer(issueId: string, bodyId: string, workflowId: string): Promise<void> {
  await recordBinding(issueId, IMPLEMENTER_ROLE, bodyId, workflowId);
}

/** Get the recorded implementer body id for a ticket, or null. */
export async function getImplementer(issueId: string): Promise<string | null> {
  return getBinding(issueId, IMPLEMENTER_ROLE);
}

/**
 * Remove a ticket's record on escape/demote. Preserves the original behavior
 * (drops the whole ticket, not just the implementer role) since escape/demote
 * take the ticket out of the workflow entirely.
 */
export async function removeImplementer(issueId: string): Promise<void> {
  await clearTicketBindings(issueId);
}

/**
 * INF-996 freeze helper. If a ticket's current state pins its owner_role
 * (`owner_binding: 'bound'`) AND a body is bound for that role, return the bound
 * body id — its seat is authoritative and must NOT be re-derived from the role
 * pool. Returns null for static roles, roles with no owner_role, or unbound
 * tickets (i.e. "not frozen — proceed with normal resolution").
 *
 * Used by the reconciliation sweeps and the routing-guard so a bound chore seat
 * survives a reconciliation/routing pass unchanged (the anti-INF-943 property).
 */
export async function boundSeatFor(
  state: { owner_role?: string; owner_binding?: string } | undefined,
  issueId: string,
): Promise<string | null> {
  if (!state || state.owner_binding !== "bound" || !state.owner_role) return null;
  return getBinding(issueId, state.owner_role);
}

/** Clear all records (for testing). */
export function clearImplementerStore(): void {
  _store.clear();
  _loaded = false;
}
