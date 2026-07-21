/**
 * INF-280 — Spike: Hot-path dispatch mutex.
 *
 * Validates that the DispatchLeaseStore correctly serializes concurrent
 * dispatch attempts for the same (agent, ticket) without introducing
 * meaningful dispatch latency.
 *
 * This is a standalone throwaway spike — not part of the production test suite.
 * Run with `npx tsx spike/INF-280/concurrent-wake-test.ts`
 */

import { DispatchLeaseStore } from "../../src/store/dispatch-lease-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Configuration ──────────────────────────────────────────────────────────

const TICKET_KEY = "linear-INF-280";
const AGENT_ID = "igor";
const TTL_MS = 90 * 60 * 1000; // 90 min (default)

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spike-inf-280-"));
  return path.join(dir, "dispatch-lease.db");
}

function cleanup(dbPath: string): void {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Test 1: Concurrent acquire — only 1 of N wins ─────────────────────────
async function testConcurrentAcquire(): Promise<void> {
  const dbPath = makeTempDbPath();
  const store = new DispatchLeaseStore(dbPath, TTL_MS);

  const CONCURRENCY = 10;
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      store.acquire(AGENT_ID, TICKET_KEY, {
        nowMs: startedAt + i,  // slightly staggered to simulate real concurrency
        updatedAt: "2026-07-21T20:21:00.000Z",
      }),
    ),
  );

  const acquired = results.filter((r) => r.acquired);
  const refused = results.filter((r) => r.refused);

  console.log("── Test 1: Concurrent acquire ──");
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Acquired:    ${acquired.length} (expected: 1)`);
  console.log(`  Refused:     ${refused.length} (expected: ${CONCURRENCY - 1})`);

  const pass = acquired.length === 1 && refused.length === CONCURRENCY - 1;
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}`);

  store.close();
  cleanup(dbPath);
}

// ── Test 2: Newer updatedAt supersedes under concurrent load ─────────────
async function testSupersedeRace(): Promise<void> {
  const dbPath = makeTempDbPath();
  const store = new DispatchLeaseStore(dbPath, TTL_MS);

  const CONCURRENCY = 10;
  const now = Date.now();

  // Half of the callers have UPDATED_AT_NEW, half have UPDATED_AT_OLD.
  // The ones with UPDATED_AT_NEW should NOT be refused (they supersede).
  const UPDATED_AT_OLD = "2026-07-21T19:00:00.000Z";
  const UPDATED_AT_NEW = "2026-07-21T20:21:00.000Z";

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => {
      const isNew = i >= CONCURRENCY / 2;
      return store.acquire(AGENT_ID, TICKET_KEY, {
        nowMs: now + i,
        updatedAt: isNew ? UPDATED_AT_NEW : UPDATED_AT_OLD,
      });
    }),
  );

  const acquired = results.filter((r) => r.acquired);
  const refused = results.filter((r) => r.refused);
  const superseded = results.filter((r) => r.superseded);
  const newCallersAcquired = results.filter((r, i) => r.acquired && i >= CONCURRENCY / 2).length;

  console.log("\n── Test 2: Supersede race ──");
  console.log(`  Concurrency:          ${CONCURRENCY} (${CONCURRENCY/2} old, ${CONCURRENCY/2} new)`);
  console.log(`  Acquired:             ${acquired.length}`);
  console.log(`  Refused:              ${refused.length}`);
  console.log(`  New-callers acquired: ${newCallersAcquired} (expected: >= 1)`);

  const pass = newCallersAcquired >= 1;
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}`);

  store.close();
  cleanup(dbPath);
}

// ── Test 3: Cross-path dedup — simulate webhook + bag + sweep ────────────
async function testCrossPathDedup(): Promise<void> {
  const dbPath = makeTempDbPath();
  const store = new DispatchLeaseStore(dbPath, TTL_MS);

  const now = Date.now();
  const UPDATED_AT = "2026-07-21T20:21:00.000Z";

  // Simulate three concurrent callers from different dispatch paths
  const [webhook, bag, sweep] = await Promise.all([
    // webhook path — first dispatch
    store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now, updatedAt: UPDATED_AT }),
    // bag wake-up — same ticket, should be refused
    store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now + 1, updatedAt: UPDATED_AT }),
    // sweep reconciliation — same ticket, should be refused
    store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now + 2, updatedAt: UPDATED_AT }),
  ]);

  console.log("\n── Test 3: Cross-path dedup ──");
  console.log(`  Webhook:  ${webhook.acquired ? "dispatched" : "refused"} (expected: dispatched)`);
  console.log(`  Bag:      ${bag.refused ? "refused" : "dispatched"} (expected: refused)`);
  console.log(`  Sweep:    ${sweep.refused ? "refused" : "dispatched"} (expected: refused)`);

  const pass = webhook.acquired && bag.refused && sweep.refused;
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}`);

  store.close();
  cleanup(dbPath);
}

// ── Test 4: TTL expiry — expired lease allows re-dispatch ────────────────
async function testTtlExpiry(): Promise<void> {
  const dbPath = makeTempDbPath();
  const SHORT_TTL_MS = 30; // 30ms TTL for quick expiry testing
  const store = new DispatchLeaseStore(dbPath, SHORT_TTL_MS);

  const now = Date.now();
  const UPDATED_AT = "2026-07-21T20:21:00.000Z";

  // Acquire a lease with very short TTL
  const first = store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now, updatedAt: UPDATED_AT });
  console.log("\n── Test 4: TTL expiry ──");
  console.log(`  First acquire: ${first.acquired ? "ok" : "failed"}`);

  // Immediately try again — should be refused (lease not expired yet)
  const immediate = store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now + 5, updatedAt: UPDATED_AT });
  console.log(`  Immediate retry (5ms): ${immediate.refused ? "refused (correct)" : "acquired"}`);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, SHORT_TTL_MS + 20));

  // Try again — should acquire now (old lease expired)
  const afterExpiry = store.acquire(AGENT_ID, TICKET_KEY, { nowMs: Date.now(), updatedAt: UPDATED_AT });
  console.log(`  After TTL expiry: ${afterExpiry.acquired ? "acquired (correct)" : "refused"}`);

  const pass = first.acquired && immediate.refused && afterExpiry.acquired;
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}`);

  store.close();
  cleanup(dbPath);
}

// ── Test 5: Latency benchmark ────────────────────────────────────────────
async function testLatency(): Promise<void> {
  const dbPath = makeTempDbPath();
  const store = new DispatchLeaseStore(dbPath, TTL_MS);
  const UPDATED_AT = "2026-07-21T20:21:00.000Z";

  // Warmup
  for (let i = 0; i < 100; i++) {
    const key = `${TICKET_KEY}-warmup-${i}`;
    store.acquire(AGENT_ID, key, { nowMs: Date.now(), updatedAt: UPDATED_AT });
    store.release(AGENT_ID, key);
  }

  // Benchmark: measure 1000 acquire + release cycles (hot path)
  const latencies: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const key = `${TICKET_KEY}-latency-${i}`;
    const start = performance.now();
    store.acquire(AGENT_ID, key, { nowMs: Date.now(), updatedAt: UPDATED_AT });
    const elapsed = performance.now() - start;
    latencies.push(elapsed);
    store.release(AGENT_ID, key);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const max = sorted[sorted.length - 1];

  console.log("\n── Test 5: Latency benchmark (1000 cycles) ──");
  console.log(`  Avg: ${avg.toFixed(3)}ms`);
  console.log(`  P50: ${p50.toFixed(3)}ms`);
  console.log(`  P95: ${p95.toFixed(3)}ms`);
  console.log(`  P99: ${p99.toFixed(3)}ms`);
  console.log(`  Max: ${max.toFixed(3)}ms`);
  console.log(`  ${max < 10 ? "✅ PASS (all under 10ms)" : "⚠️  WARN (some over 10ms)"}`);

  store.close();
  cleanup(dbPath);
}

// ── Test 6: Release then re-acquire ──────────────────────────────────────
async function testReleaseAndReacquire(): Promise<void> {
  const dbPath = makeTempDbPath();
  const store = new DispatchLeaseStore(dbPath, TTL_MS);
  const UPDATED_AT = "2026-07-21T20:21:00.000Z";

  const now = Date.now();

  // Acquire
  const first = store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now, updatedAt: UPDATED_AT });
  console.log("\n── Test 6: Release + re-acquire ──");
  console.log(`  First acquire: ${first.acquired ? "ok" : "failed"}`);

  // Release
  const released = store.release(AGENT_ID, TICKET_KEY);
  console.log(`  Release: ${released ? "ok" : "no-op"}`);

  // Re-acquire — should succeed
  const second = store.acquire(AGENT_ID, TICKET_KEY, { nowMs: now + 10, updatedAt: UPDATED_AT });
  console.log(`  Re-acquire: ${second.acquired ? "ok (correct)" : "refused"}`);

  const pass = first.acquired && released && second.acquired;
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}`);

  store.close();
  cleanup(dbPath);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  INF-280 — Spike: Hot-path dispatch mutex");
  console.log("  Verifies DispatchLeaseStore (AI-2350) correctness");
  console.log("═══════════════════════════════════════════════════════\n");

  await testConcurrentAcquire();
  await testSupersedeRace();
  await testCrossPathDedup();
  await testReleaseAndReacquire();
  await testTtlExpiry();
  await testLatency();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Spike complete");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Spike failed:", err);
  process.exit(1);
});
