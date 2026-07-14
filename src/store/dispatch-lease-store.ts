/**
 * AI-2350 — Durable dispatch lease store.
 *
 * A single canonical re-dispatch-idempotency mechanism checked at every delivery
 * point (reconciliation sweep + webhook). Prevents re-dispatches to an agent
 * for a ticket that already has an active lease, regardless of:
 *
 *   1. Session timeout (AI-2343) — durable SQLite, not in-memory map.
 *   2. Webhook path (AI-2344) — the webhook honors the lease as a refusal.
 *
 * Key: (agentId, ticketKey).
 * Columns: dispatchedAt (ISO-8601), expiresAt (ISO-8601), renewedAt (ISO-8601).
 *
 * Semantics:
 *   - acquire(): INSERT OR IGNORE. If an unexpired lease exists, returns false.
 *   - isActive(): checks (expiresAt > now) without mutating.
 *   - renew(): updates renewedAt and extends expiresAt by TTL.
 *   - release(): deletes the lease row.
 *   - restart-safe: data persists across connector restarts.
 *
 * Lease TTL is configurable via DISPATCH_LEASE_TTL_MS env var (default: 90 min).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Default lease TTL: 90 minutes — well above the 25-min session timeout and
 *  covering the longest expected agent sessions. */
export const DEFAULT_LEASE_TTL_MS = 90 * 60 * 1000;

/** Max lease TTL: 24 hours — safety cap to prevent permanent lease lockouts. */
export const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface LeaseRecord {
  /** SQLite column: agent_id */
  agent_id: string;
  /** SQLite column: ticket_key */
  ticket_key: string;
  /** SQLite column: dispatched_at */
  dispatched_at: string;
  /** SQLite column: expires_at */
  expires_at: string;
  /** SQLite column: renewed_at */
  renewed_at: string;
}

export interface AcquireResult {
  /** True if the lease was acquired (fresh insert). */
  acquired: boolean;
  /** True if an unexpired lease already existed — the dispatch should be refused. */
  refused: boolean;
  /** The existing lease record if refused, or null. */
  existingLease: LeaseRecord | null;
}

export interface LeaseStoreCounters {
  acquired: number;
  refused: number;
  renewed: number;
  released: number;
  /** Stale lease rows purged by cleanup. */
  stalePurged: number;
}

export class DispatchLeaseStore {
  private db: Database.Database;
  private readonly leaseTtlMs: number;
  private _acquired = 0;
  private _refused = 0;
  private _renewed = 0;
  private _released = 0;
  private _stalePurged = 0;

  constructor(dbPath?: string, leaseTtlMs?: number) {
    const resolvedPath = dbPath ?? path.join(
      process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
      "dispatch-lease.db",
    );
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.leaseTtlMs = this.resolveTtl(leaseTtlMs);
    this.migrate();
  }

  /**
   * Resolve TTL from argument, env var, or default. Clamped to MAX_LEASE_TTL_MS.
   */
  private resolveTtl(explicit?: number): number {
    const raw = explicit ?? process.env.DISPATCH_LEASE_TTL_MS;
    if (raw !== undefined) {
      const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!isNaN(parsed) && parsed > 0) {
        return Math.min(parsed, MAX_LEASE_TTL_MS);
      }
    }
    return DEFAULT_LEASE_TTL_MS;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_lease (
        agent_id TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        dispatched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, ticket_key)
      );
      CREATE INDEX IF NOT EXISTS idx_lease_expires
        ON dispatch_lease (expires_at);
    `);
  }

  /**
   * Resolve "now" timestamp. Overridable via options for deterministic testing.
   */
  private now(options?: { nowMs?: number }): Date {
    return new Date(options?.nowMs ?? Date.now());
  }

  /**
   * Format a timestamp as ISO-8601 without zone suffix (compatible with SQLite).
   */
  private iso(d: Date): string {
    return d.toISOString();
  }

  /**
   * Acquire a dispatch lease for (agentId, ticketKey).
   *
   * If no active lease exists, creates one and returns { acquired: true }.
   * If an unexpired lease already exists, returns { acquired: false, refused: true }
   * with the existing record — the caller MUST refuse the dispatch.
   *
   * This is a single atomic INSERT OR IGNORE + SELECT operation — no check-then-act
   * race. Uses INSERT OR IGNORE (not INSERT OR REPLACE) so an existing row survives.
   *
   * A lease is considered "expired" when expires_at < now. Expired leases are
   * silently replaced — the INSERT OR IGNORE will conflict, so we DELETE first
   * (in the same transaction) to allow re-acquisition.
   */
  acquire(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number; ttlOverrideMs?: number },
  ): AcquireResult {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.leaseTtlMs));

    const acquire = this.db.transaction((): AcquireResult => {
      // Check if an unexpired lease exists
      const row = this.db.prepare(
        `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at
         FROM dispatch_lease
         WHERE agent_id = ? AND ticket_key = ?`,
      ).get(agentId, ticketKey) as LeaseRecord | undefined;

      if (row) {
        const expiresMs = new Date(row.expires_at).getTime();
        if (expiresMs > now.getTime()) {
          // Unexpired lease exists — refuse
          this._refused++;
          return {
            acquired: false,
            refused: true,
            existingLease: row,
          };
        }
        // Expired lease: DELETE first, then INSERT below
        this.db.prepare(
          `DELETE FROM dispatch_lease WHERE agent_id = ? AND ticket_key = ?`,
        ).run(agentId, ticketKey);
      }

      // Acquire the lease
      this.db.prepare(
        `INSERT INTO dispatch_lease (agent_id, ticket_key, dispatched_at, expires_at, renewed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(agentId, ticketKey, this.iso(now), this.iso(expiresAt), this.iso(now));

      this._acquired++;
      return {
        acquired: true,
        refused: false,
        existingLease: null,
      };
    });

    return acquire();
  }

  /**
   * Check whether an unexpired lease exists without mutating.
   * Returns the lease record, or null if none exists or expired.
   */
  isActive(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number },
  ): LeaseRecord | null {
    const now = this.now(options);
    const row = this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at
       FROM dispatch_lease
       WHERE agent_id = ? AND ticket_key = ? AND expires_at > ?`,
    ).get(agentId, ticketKey, this.iso(now)) as LeaseRecord | undefined;

    return row ?? null;
  }

  /**
   * Renew a lease, extending its expiry by the TTL from now.
   * Returns true if the lease existed and was unexpired.
   *
   * Called when session activity is observed for the (agent, ticket) pair.
   */
  renew(
    agentId: string,
    ticketKey: string,
    options?: { nowMs?: number; ttlOverrideMs?: number },
  ): boolean {
    const now = this.now(options);
    const expiresAt = new Date(now.getTime() + (options?.ttlOverrideMs ?? this.leaseTtlMs));

    const result = this.db.prepare(
      `UPDATE dispatch_lease
       SET renewed_at = ?, expires_at = ?
       WHERE agent_id = ? AND ticket_key = ? AND expires_at > ?`,
    ).run(this.iso(now), this.iso(expiresAt), agentId, ticketKey, this.iso(now));

    if (result.changes > 0) {
      this._renewed++;
      return true;
    }
    return false;
  }

  /**
   * Release a lease — delete the row.
   * Called on session end or terminal transition.
   * Returns true if a row was deleted.
   */
  release(agentId: string, ticketKey: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE agent_id = ? AND ticket_key = ?`,
    ).run(agentId, ticketKey);

    if (result.changes > 0) {
      this._released++;
      return true;
    }
    return false;
  }

  /**
   * Release all leases for a given agent.
   * Returns the number of rows deleted.
   */
  releaseAll(agentId: string): number {
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE agent_id = ?`,
    ).run(agentId);
    if (result.changes > 0) {
      this._released += result.changes;
    }
    return result.changes;
  }

  /**
   * Purge all expired leases. Returns count of rows deleted.
   * Called on a periodic interval or at startup.
   */
  purgeExpired(options?: { nowMs?: number }): number {
    const now = this.now(options);
    const result = this.db.prepare(
      `DELETE FROM dispatch_lease WHERE expires_at <= ?`,
    ).run(this.iso(now));

    if (result.changes > 0) {
      this._stalePurged += result.changes;
    }
    return result.changes;
  }

  /**
   * Get a lease record (even if expired). For diagnostics.
   */
  get(agentId: string, ticketKey: string): LeaseRecord | null {
    const row = this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at
       FROM dispatch_lease
       WHERE agent_id = ? AND ticket_key = ?`,
    ).get(agentId, ticketKey) as LeaseRecord | undefined;
    return row ?? null;
  }

  /** Get all active (unexpired) leases. For diagnostics/metrics. */
  getAllActive(options?: { nowMs?: number }): LeaseRecord[] {
    const now = this.now(options);
    return this.db.prepare(
      `SELECT agent_id, ticket_key, dispatched_at, expires_at, renewed_at
       FROM dispatch_lease
       WHERE expires_at > ?
       ORDER BY agent_id, ticket_key`,
    ).all(this.iso(now)) as LeaseRecord[];
  }

  get counters(): LeaseStoreCounters {
    return {
      acquired: this._acquired,
      refused: this._refused,
      renewed: this._renewed,
      released: this._released,
      stalePurged: this._stalePurged,
    };
  }

  close(): void {
    this.db.close();
  }
}
