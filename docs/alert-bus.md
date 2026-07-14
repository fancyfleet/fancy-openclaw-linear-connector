# Alert Bus (Phase 2 — alert pipeline overhaul)

_Astrid, 2026-07-02 (Phase 1). AI-2190 (Phase 2 — dedup, state-change, digest, startup buffer, 2026-07-13)._

## Problem

The original alert pipeline (Phase 1) pushed chronic repeats to the operator channel while swallowing genuine criticals:

* `registry-policy` pushed the same 3–4 violations on every fire (hourly + every restart).
* `token-refresh` critical storms during transient failures were pushed in bulk; only the genuinely broken agent needed attention.
* The one genuinely scary alert — `Connector refusing to start — empty agent roster` — was **never pushed** (fired before push channel init).

Phase 2 addresses all four gaps.

## Core API

```ts
// Report a violation
notify({
  severity: "info" | "warning" | "critical",
  source:   "dispatch" | "config-health" | "token-refresh" | ...,  // subsystem slug
  title:    "one-line human summary",
  detail?:  "multiline context",     // redacted + truncated before storage/push
  agent?:   "felix",
  ticket?:  "AI-1234",
  dedupKey?: "custom-key",           // default: source|title|agent|ticket
})

// Signal that a previously-reported violation has cleared
resolve({
  severity: "info" | "warning" | "critical",
  source:   "...",
  title:    "...",
  dedupKey?: "custom-key",          // must match the original notify's dedupKey
})

// Flush the startup buffer after push channel init is confirmed
flushStartupBuffer()  // or call bus.flushStartupBuffer()
```

## Sinks

Every `notify()` flows to three sinks; sinks never throw into the caller:

1. **Log sink** — always. `[alert]` component logger, severity-mapped.
2. **Store sink** — always. `alerts` SQLite table (`data/alerts.db`), the console's event feed.
3. **Push sink** — severity ≥ `ALERT_PUSH_MIN_SEVERITY` (default `warning`), controlled, deduped, digest-eligible.

`resolve()` logs + pushes (one CLEARED notice) but does not create a store row (the original violation row remains).

## Push Controls

### 1. Escalating cooldown (replaces fixed severity windows)

Instead of a fixed severity-based suppression window, each `dedupKey` independently escalates through cooldown tiers:

| Tier | Label | Cooldown |
|---|---|---|
| 0 | `first fire` | Immediate (no delay) |
| 1 | `1st re-fire` | 5 min |
| 2 | `2nd re-fire` | 30 min |
| 3 | `3rd re-fire` | 120 min |
| 4 | `chronic (6h+)` | 360 min |

Tier advances on each re-fire outside the current cooldown. **Calling `resolve()` resets the tier to 0**, so a genuine fix → re-fire cycle doesn't accumulate stale escalation.

Within a cooldown, the alert's `count` still increments in the store; only the push is suppressed. When the cooldown expires and the alert re-fires, the push includes a label: `[1st re-fire]`, `[chronic (6h+)]`, etc.

### 2. State-change alerting (resolve)

`resolve()` produces a `[connector:$severity] ✓ CLEARED: $title` push. This is the notification that a previously-violating condition returned to normal.

Resolve notices are one-off and budget-tracking (they consume a slot in the 15-minute push budget) but bypass cooldown — you always get the clear signal. They are rate-limited only by the storm budget.

A `resolve()` for a dedup_key that was never `notify()`'d is a no-op (no push, no log error).

### 3. Daily digest

Pushes are segmented:

- **Critical** alerts always push individually (cooldown-governed, storm-controlled).
- **Warning** alerts push individually only if the dedup_key has been active for <6h.
- **Warning** alerts active for >6h and **info** alerts never push individually — they collect in a daily digest.
- The digest fires **once per calendar day** (America/Denver). It contains a summary of all digest-eligible alerts with top-count offenders listed.

The digest is itself a push (consumes one budget slot). The digest timer is a 1-hour check; it fires at most once per day. If no digest-eligible alerts exist on a given day, no digest is pushed.

### 4. Startup-buffer guarantee

All alerts during the first 30s after `AlertBus` construction are **buffered in memory** — never lost, never unpushed. After the window expires:

1. All buffered alerts are flushed through the normal push path.
2. Subsequent alerts go through the normal cooldown/digest/budget path.

Call `flushStartupBuffer()` explicitly to flush early (e.g., after push channel init confirms). Calling it is idempotent.

This guarantees that criticals like "Connector refusing to start — empty agent roster" are always pushed, even though they fire before the push chain is wired in.

### 5. Global push budget (unchanged from Phase 1)

Max 20 pushes per 15-minute window. On overflow, one final `critical` digest push ("ALERT STORM — push budget exhausted") and then silence until the window frees. Everything still lands in the store. Budget raised from 10 (Phase 1) to 20 to accommodate resolve notices.

## Config

| Env | Default | Meaning |
|---|---|---|
| `ALERT_PUSH_ENABLED` | `true` | Push sink on/off (log+store sinks unconditional) |
| `ALERT_PUSH_MIN_SEVERITY` | `warning` | Minimum severity that pushes |
| `ALERT_PUSH_BUDGET` | `20` | Max pushes per 15-min window |
| `ALERTS_DB_PATH` | `$DATA_DIR/alerts.db` | Store location |
| `ALERT_STARTUP_BUFFER_MS` | `30000` | Startup-buffer window in ms |
| `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` | (existing) | Push target |

## What this deliberately does NOT solve

**The dead-man problem.** A dead connector can't alert about itself. That assertion lives host-side (Grover's watchdog).

## Console integration (Phase 3)

Unchanged from Phase 1: the `alerts` table is the console's event feed — list + filter by severity/source/agent, ack button. The Phase 2 digest is a separate push artifact (no store row for digests).
