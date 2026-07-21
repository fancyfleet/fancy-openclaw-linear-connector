# INF-280 — Spike: Hot-path dispatch mutex

## Question

Prove a correct, low-latency mutex on (agent,ticket) that prevents concurrent
duplicate dispatch sessions ([INF-227](https://linear.app/fancymatt/issue/INF-227))
without adding meaningful dispatch latency. Validate under concurrent-wake load.

## Verdict

**Feasible with caveats.** The existing `DispatchLeaseStore` (AI-2350) is a
correct, low-latency mutex. All concurrent-race scenarios pass. However, not
every dispatch path checks it — the coverage is incomplete by design in some
cases, but may need attention in others.

---

## The mechanism: DispatchLeaseStore (AI-2350)

**What it is:** A SQLite-backed (WAL mode, IMMEDIATE transactions) lease store
keyed on `(agent_id, ticket_key)`. Atomically serializes concurrent `acquire()`
calls through SQLite's built-in transaction isolation.

**Key properties:**
- **Atomic acquire**: Only one of N concurrent callers wins
- **TTL-based expiry**: Default 90 min, configurable via `DISPATCH_LEASE_TTL_MS`
- **Ticket-state awareness**: Compares `ticket_updated_at` — a newer state
  supersedes the old lease (legitimate re-dispatch)
- **Durable (SQLite)**: Survives connector restart
- **Release API**: `release()`, `releaseAll()`, `purgeExpired()`

---

## Results: Concurrent-wake test (all pass)

Run by `npx tsx spike/INF-280/concurrent-wake-test.ts`.

| Test | Result | Detail |
|------|--------|--------|
| Concurrent acquire (10 callers) | ✅ | 1 acquired, 9 refused |
| Supersede race (newer updatedAt) | ✅ | New-state callers admitted |
| Cross-path dedup (webhook+bag+sweep) | ✅ | Only first dispatches |
| Release + re-acquire | ✅ | Correctly cycles |
| TTL expiry (30ms) | ✅ | Expired leases allow re-dispatch |

**Latency (1000 acquire+release cycles):**

| Metric | Value |
|--------|-------|
| Avg | 0.048 ms |
| P50  | 0.024 ms |
| P95  | 0.030 ms |
| P99  | 0.161 ms |
| Max  | 3.772 ms |

→ **The mutex adds ~0.05ms average latency** to the dispatch hot path. This is
effectively zero relative to the gateway API call (tens to hundreds of ms).

---

## Dispatch path coverage audit

### ✅ Paths that check the lease store

| Path | File:Line | How |
|------|-----------|-----|
| Webhook dispatch (primary) | `webhook/index.ts:679` | Explicit `dispatchLeaseStore.acquire()` |
| Webhook delivery (backstop) | `delivery/deliver.ts:132` | `deliverToAgent()` checks lease |
| Delegation-reconciliation sweep | `delegation-reconciliation-sweep.ts:535` | Explicit before wake dispatch |

### ⚠️ Paths using deliverToAgent WITHOUT lease store

| Path | File:Line | Risk |
|------|-----------|------|
| Startup drain | `index.ts:1298` | **Low** — no active leases at startup. Lease not written by this path, so no dedup. Restart-echo not fully gated. |

### ⚠️ Paths using deliverMessageToAgent (NO lease check)

These deliver messages to **existing sessions** (not creating new ones), so in
theory no new duplicate dispatch can arise. But they bypass the lease check:

| Path | File:Line | Note |
|------|-----------|------|
| Bag wake-up | `bag/wake-up.ts:188` | Has own session-tracker dedup |
| Managing wake | `bag/managing-wake.ts:138` | Non-duplicate by nature |
| Stuck-delegate detector | `bag/stuck-delegate-detector.ts:519` | Has own active-session check |
| Stale session C4 re-poke | `index.ts:625` | Only fires for known-stale sessions |
| Stale session C4 re-poke (fetchability) | `index.ts:821` | Same |
| Resignal delivery | `index.ts:895` | Has own session-tracker dedup in resignalPendingTickets |
| Enrollment healing | `index.ts:1238` | Admin-triggered — bypass OK |
| Admin direct delivery | `index.ts:1412` | Admin-triggered — bypass OK |
| AI direct delivery | `index.ts:1643` | Admin-triggered — bypass OK |

### Security-in-depth assessment

The `resignalPendingTickets` function in `resignal.ts:70-81` has a **two-layer
in-memory dedup**:
1. `sessionTracker.isActiveForTicket()` — checks before dispatching
2. `sessionTracker.startSession()` — atomic claim; returns false if already
   claimed by concurrent caller

This means the bag/wake-up path is protected by a separate mechanism from the
lease store. The two mechanisms are **complementary**:
- **Lease store** (SQLite, durable): catches replay across restarts, sweep
  paths, and webhook replay
- **Session tracker** (in-memory): catches intra-process races between resignal
  and bag dispatch

### Edge case: concurrent webhook + bag wake-up

If a webhook arrives at the exact moment a bag wake-up fires for the same
(agent, ticket):

1. **Webhook path**: Checks lease store → acquires lease → dispatches ✅
2. **Bag wake-up path**: Checks session tracker → if session already started,
   skips. Otherwise dispatches via `deliverMessageToAgent()` which checks no
   lease. **Potential for a second delivery.**

However, both the webhook path's `deliverToAgent` (deliver.ts:132) and the
session tracker's `startSession()` act as backstops. The race window is:
- Between `startSession()` returning true and the webhook dispatch reaching
  the session tracker; or
- Between the webhook's lease acquire and the bag's `deliverMessageToAgent`

**This is a real gap**, though low-probability given the ~0.05ms lease acquire
time.

---

## Implications for implementation AC

If a production implementation is scoped, it should:

1. **Move the lease check into `deliverMessageToAgent`** (or create a
   `leaseAwareDeliverMessageToAgent` wrapper). This closes the gap for all 7+
   `deliverMessageToAgent` callers with one change.

2. **Add a `dispatchLeaseStore` parameter to the startup drain path**
   (`index.ts:1298`). Low priority — leases don't exist at startup.

3. **Pass `updatedAt` in the lease check from all callers** (not just the
   webhook). Currently only the webhook path passes `updatedAt` for supersede
   semantics. Without it, stale leases block legitimate re-dispatches.

4. **Consider removing the redundant lease check in `webhook/index.ts:679`** if
   `deliverToAgent` at `deliver.ts:132` already checks it. Retain for defensive
   depth.

---

## Evidence

The spike test and this document live at `spike/INF-280/`.

- **Test script**: `spike/INF-280/concurrent-wake-test.ts`
- **Findings**: This file
- **Igor commit**: `git log spike/INF-280-hot-path-dispatch-mutex`
