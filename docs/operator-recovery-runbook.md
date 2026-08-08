# Operator Recovery Runbook — Stop/Go + Freeze Checklist

> **Scope:** Slice F (INF-1334). Authored against **existing** health/admin/deploy surfaces — **no UI dependency**, **no custom UI required**. All checks use surfaces already shipped (`GET /health`, `GET /health.checkpoint`, `admin` API, `promote`/`rollback`/`deploy` CLI). There is no new dashboard or Helm control-center UI to deploy before this runbook is usable. This document runs entirely on existing health/admin/deploy surfaces.
>
> **Classification:** **declared-standalone**. End-to-end release-evidence proof is **not owned here** and is **not by this slice** — it is carried by the per-capability **integration-verify** children **INF-1335** through **INF-1338** (one per capability slice). This runbook is the operator's stop/go checklist; the integration-verify suites are the e2e proof. Do not treat this doc as the end-to-end release-evidence artifact.
>
> **Frozen-contract references:** This runbook is written against the frozen contracts of Slice A (manifest), Slice C (promotion gate), Slice D (named rollback), and Slice E (acknowledged-silence detection). See § 5 for contract terms. If any of those contracts changed, the runbook's stop/go criteria must be re-validated against the new contract.

---

## 1. When to use this runbook

Use this runbook when:

- A deploy, incident, or freeze decision requires a **stop/go** call.
- You need to answer the five operator questions before unfreezing or promoting.
- Dispatch, wake, or bootstrap health is in question after a restart or config change.

**Prerequisite surfaces (all existing, no custom UI):**

| Surface | How to reach it | What it tells you |
|---------|-----------------|-------------------|
| `GET /health` | `curl -sf http://<connector>/health` | Liveness, build commit, healthSnapshot.active |
| `GET /health.checkpoint` | `curl -sf http://<connector>/health.checkpoint` | Live `checkpoint-manifest.json` + `matchesLive` |
| `admin` | `admin` API / management console (see `docs/management-console.md`, `src/admin.ts`) | Ticket state, workflow position, governance |
| `deploy` | `promote` / `rollback` / `deploy` CLI (see § 5) | Promotion and rollback operations |

No UI dependency — every step below is a CLI or HTTP call.

---

## 2. Freeze Checklist — answer all five before go

Copy this checklist into the freeze incident ticket and check each item with evidence. A **go** requires all five answered with a fresh probe (not cached).

### Q1 — What production runs?

> Checklist item: **what production runs**

- Probe: `curl -sf http://<connector>/health | jq .` — note `commit` / `deployCommit` and `healthSnapshot`.
- Probe: `curl -sf http://<connector>/health.checkpoint | jq .` — note `checkpoint-manifest.json` identity and `matchesLive` field.
- Record the exact commit SHA serving production and the checkpoint manifest it reports. If `matchesLive` is false, production is not running the blessed manifest (see Q3).

### Q2 — What staging runs?

> Checklist item: **what staging runs**

- Probe the staging connector: `curl -sf http://<staging-connector>/health | jq .` and `curl -sf http://<staging-connector>/health.checkpoint | jq .`.
- Compare staging's `checkpoint-manifest.json` and commit against production's. Record both. Staging must be ahead of or equal to production for a promote to be valid (Slice C gate).

### Q3 — What is blessed?

> Checklist item: **what is blessed** (blessed checkpoint / blessed manifest / blessed build)

- The blessed artifact is the `checkpoint-manifest.json` frozen by Slice A and referenced by the promotion gate. Retrieve it from the source of truth (repo `config/` or the manifest store, per Slice A contract).
- Verify the blessed checkpoint id against `GET /health.checkpoint` on each environment. A blessed checkpoint is one that has passed the integration-verify children (INF-1335–INF-1338). Do not bless a checkpoint that has not cleared those suites.

### Q4 — Whether rollback is available

> Checklist item: **whether rollback is available** — rollback available

- Check retained checkpoints: the deploy store retains the last N `checkpoint-manifest.json` artifacts plus their `workflow definitions` bundles and restore artifacts.
- Verify `rollback --checkpoint <id>` can resolve the target (dry-run if available). Rollback is **available** only if the retained checkpoint exists, its restore artifact is intact, and the workflow definitions for that checkpoint are still stored. The rollback path must verify exact live identity before restoring (see § 5 Slice D).
- If no retained checkpoint is reachable or `verify identity` fails, rollback is **not available** — treat promote as higher risk.

### Q5 — Whether dispatch/wake health has recovered

> Checklist item: **whether dispatch/wake health has recovered**

- Probe `GET /health` and `GET /health/snapshot` for `healthSnapshot.active === true` and no stuck `dispatch`/`wake` crons.
- Check cron liveness: the dispatch/wake crons must have ticked within their expected interval. Review the operational log / alert-bus for `dispatch/wake health` recovery signals.
- Confirm `dispatch/wake health has recovered` by observing at least one successful dispatch cycle after the incident window. Until dispatch/wake health has recovered, do not promote — queued work may still be draining.

### Aggregate gate

All five — **what production runs**, **what staging runs**, **what is blessed**, **whether rollback is available**, **whether dispatch/wake health has recovered** — must be answered distinctly with evidence links (curl output, commit SHAs, checkpoint ids) before a **go**. A single "all good" without per-question evidence is not a go.

---

## 3. Stop/Go criteria

| Condition | Verdict |
|-----------|---------|
| Any Q unanswered or stale (>15 min without re-probe) | **STOP** |
| `matchesLive` false on production | **STOP** — production not on blessed manifest |
| `rollback available` false and change is not trivial | **STOP** or explicitly accept risk in writing |
| `dispatch/wake health has recovered` false | **STOP** — do not promote while dispatch is still healing |
| All five answered, `matchesLive` true, rollback available, dispatch/wake health has recovered | **GO** (with blessed checkpoint id recorded) |

---

## 4. Recovery procedures (existing surfaces only)

### 4.1 Production appears stuck

1. `GET /health` — is the process up? If not, restart per `docs/deployment.md`.
2. `GET /health.checkpoint` — does `checkpoint-manifest.json` load? If `matchesLive` false, compare `checkpoint-manifest.json` on disk vs. live.
3. `admin` — inspect stuck tickets / workflow position. Use `admin` stream if needed (`src/admin-stream.ts`).

### 4.2 Staging drift

1. Compare `GET /health.checkpoint` between staging and production.
2. If staging is behind, redeploy staging from the blessed `checkpoint-manifest.json`.
3. Re-probe until `matchesLive` true on staging.

### 4.3 Dispatch/wake not recovering

1. Check `GET /health/snapshot` for per-task health.
2. Inspect cron registry outcome and last tick timestamps.
3. See Slice E contract (§ 5) for acknowledged-silence — do not confuse C6/bootstrap/model/delivery chatter with owner recovery.

---

## 5. Frozen contracts referenced (Slices A, C, D, E)

This section names each contract by its frozen terms. The runbook does not re-derive these contracts — it calls them by the terms the TDD suites assert.

### Slice A — Manifest (checkpoint-manifest)

- Artifact: `checkpoint-manifest.json` — the frozen checkpoint manifest.
- Live surface: `GET /health.checkpoint` exposes the live manifest and a `matchesLive` boolean (true only when the running artifact's `checkpoint-manifest.json` matches the manifest on disk / in config).
- Operator use: Q1/Q2/Q3 all read `checkpoint-manifest.json` via `GET /health.checkpoint` and check `matchesLive`.

### Slice C — Promotion gate (fail-closed)

- Command: `promote --from staging --checkpoint <id>` — promotes a blessed checkpoint from staging to production.
- Gate: **fail-closed** / **promotion gate** — if the checkpoint id does not match the blessed manifest, or staging does not hold that checkpoint, the gate refuses (`gate refuses` promotion). No partial promotion occurs. Operator must not bypass the gate; a refusal is a **STOP**.
- Operator use: Q3 (blessed) and the go/no-go promotion step.

### Slice D — Named rollback (retained checkpoint)

- Command: `rollback --checkpoint <id>` — restores a retained checkpoint.
- Detail: rollback operates on a **retained checkpoint** plus its **restore artifact** and **workflow definitions** bundle. Before restoring, it performs **verify identity** / **exact live identity** checks against the live deployment. If identity verification fails, rollback is not available and the operator must not force it.
- Operator use: Q4 — rollback available means the retained checkpoint, restore artifact, and workflow definitions are all present and identity-verified.

### Slice E — Acknowledged-silence detection

- Contract: **acknowledged-silence** / **acknowledged silence** / **silence detection** — detects owner silence on a ticket after acknowledgement.
- Lanes: Both **TDD** and **non-TDD** lanes are covered (equivalently, **INF-1305** for the TDD lane and **INF-1307** for the non-TDD lane). The operator must check both lanes when triaging silence — a ticket may be silent in one lane and active in the other.
- Exclusion: **C6** and bootstrap/model/delivery failures **never count as productive owner activity** / **do not count as productive owner activity** / **do not count as owner activity**. Noise on C6, bootstrap, model, or delivery channels must not be mistaken for owner recovery. Only genuine owner activity resets the silence clock. This is the same guard that prevents `dispatch/wake health has recovered` from being falsely declared on the basis of automated chatter.

### Aggregate

All four frozen contracts — **checkpoint-manifest** (A), **promote --from staging** with **fail-closed** (C), **rollback --checkpoint** with retained checkpoint (D), and **acknowledged-silence** with TDD/non-TDD lanes (E) — are referenced distinctly above. If any contract term is not found in this doc, the runbook is incomplete.

---

## 6. Worked example (no custom UI)

```bash
# Q1 — what production runs
curl -sf http://connector.prod/health | jq '{commit, healthSnapshot}'
curl -sf http://connector.prod/health.checkpoint | jq '{manifest: .checkpointManifestId, matchesLive}'

# Q2 — what staging runs
curl -sf http://connector.staging/health | jq '{commit, healthSnapshot}'
curl -sf http://connector.staging/health.checkpoint | jq '{manifest: .checkpointManifestId, matchesLive}'

# Q3 — what is blessed
cat config/checkpoint-manifest.json | jq .checkpointId
# compare against the two health.checkpoint probes above

# Q4 — whether rollback is available
rollback --checkpoint <previous-blessed-id> --dry-run  # verify retained checkpoint + restore artifact + workflow definitions + verify identity

# Q5 — whether dispatch/wake health has recovered
curl -sf http://connector.prod/health/snapshot | jq .tasks
# confirm dispatch and wake crons have ticked; check alert-bus for dispatch/wake health recovery

# Promote (only on GO)
promote --from staging --checkpoint <blessed-id>   # fail-closed promotion gate — gate refuses on mismatch
```

Every command above uses an **existing** surface (`GET /health`, `GET /health.checkpoint` / `checkpoint-manifest.json`, `admin`, `promote`/`rollback`/`deploy`). No custom UI, no new dashboard — **no UI dependency**.

---

## 7. Checklist copy-paste template

```markdown
### Freeze Go/No-Go — <date> — operator: <name>

- [ ] Q1 what production runs — prod commit: ___  checkpoint-manifest.json: ___  matchesLive: ___
- [ ] Q2 what staging runs — staging commit: ___  checkpoint-manifest.json: ___  matchesLive: ___
- [ ] Q3 what is blessed — blessed checkpoint (checkpoint-manifest.json): ___  source: ___
- [ ] Q4 whether rollback is available — retained checkpoint: ___  restore artifact: ___  workflow definitions: ___  verify identity: ___  rollback available: yes/no
- [ ] Q5 whether dispatch/wake health has recovered — dispatch/wake health: recovered / not recovered  evidence: ___
- [ ] Slice A/C/D/E contracts referenced — checkpoint-manifest + matchesLive / GET /health.checkpoint, promote --from staging --checkpoint + fail-closed/promotion gate, rollback --checkpoint + retained checkpoint, acknowledged-silence (TDD + non-TDD / INF-1305 + INF-1307) + C6 exclusion
- [ ] Classification: declared-standalone — e2e proof via INF-1335–INF-1338 integration-verify, not this doc

Verdict: STOP / GO — blessed checkpoint id: ___  rollback available: ___  dispatch/wake health has recovered: ___
```

---

## 8. References

- Slice A manifest contract: `checkpoint-manifest.json`, `GET /health.checkpoint`, `matchesLive`
- Slice C promotion gate: `promote --from staging --checkpoint <id>`, **fail-closed**, **promotion gate**
- Slice D named rollback: `rollback --checkpoint <id>`, retained checkpoint, restore artifact, workflow definitions, verify identity / exact live identity
- Slice E acknowledged-silence: **acknowledged-silence**, TDD + non-TDD / INF-1305 + INF-1307, **C6** / bootstrap / model / delivery never count as productive owner activity
- Integration-verify e2e proof: **INF-1335**, **INF-1336**, **INF-1337**, **INF-1338** / **integration-verify**
- No UI dependency — existing health/admin/deploy surfaces only; this runbook **does not require a custom UI**, does not require a new dashboard, and **does not invent a new UI surface as a prerequisite**
