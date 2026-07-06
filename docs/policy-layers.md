# Policy Layers — Universal Canon + Step Guidance

The connector injects task-handling policy into every dispatch message at two layers:

| Layer | Scope | Where it lives | AC/Source |
|-------|-------|----------------|-----------|
| **L0 — Universal canon** | Rules that apply to *every* ticket, regardless of workflow or team | `{configRoot}/policy/universal.md` | AI-1848 (Pillar 2 D1) |
| **B3 — Per-step guidance** | Rules specific to a workflow state (e.g. "write tests before implementation") | `{configRoot}/workflows/{workflowId}/{state}.md` | AI-1354 / AI-1381 (Phase 3 / C5) |

Both layers live in **instance config** (`~/.openclaw/linear-connector` by default), not in the repo or the vault. This survives `git reset --hard` and vault reorganizations.

---

## L0 — Universal Canon (AI-1848)

The canon is a short (~30 line) set of universal task-handling rules inlined into **every** dispatch message — workflow, ad-hoc, and mention paths. It is the only guaranteed-delivery channel to a dispatched agent.

### File location

```
{configRoot}/policy/universal.md
```

Override for tests via `UNIVERSAL_POLICY_PATH` env var.

### Format

YAML frontmatter carries the version marker; the body is the canon text:

```markdown
---
version: v1
---

1. Read the ticket fully before acting.
2. Use only legal workflow commands for your state.
...
```

### Fail-open

Missing, empty, or unparseable canon file → the dispatch goes out **without** the canon section and a WARN is logged. No dispatch is ever blocked by a canon failure.

### Hot-reload

The canon file is re-read on **every dispatch** (read-per-dispatch). Editing the file takes effect immediately — no rebuild or restart needed. The version bump (`v1` → `v2`) is reflected in the next dispatch message and the next `/health` poll.

### Version stamping

Each dispatch record persists the canon version that was injected, visible in the dispatch cycles admin API (`/api/dispatches`) as `canon_version` on each dispatch entry, and in the operational event store's `detail_json`.

### Liveness (`/health`)

The `/health` endpoint includes a `universalCanon` field so deployment validation (ac-validate) can confirm the canon loaded without waiting for a trigger:

```json
{
  "universalCanon": {
    "loaded": true,
    "version": "v1",
    "path": "/home/fancymatt/.openclaw/linear-connector/policy/universal.md"
  }
}
```

### Bootstrap registration

The canon is loaded at server bootstrap (`loadUniversalCanon()` in `index.ts` main) before `createApp()`, so `/health` reports liveness immediately on boot. This satisfies the AI-1808 background-component registration requirement.

---

## B3 — Per-Step Guidance (AI-1354 / C5)

State-scoped guidance files live alongside their workflow definitions:

```
{configRoot}/workflows/{workflowId}/{state}.md
```

These are injected into workflow-ticket dispatch messages only, after the canon block. See the [architecture doc](architecture.md) §4.6 for the mode-switch design.

---

## Relationship in the dispatch message

```
You were delegated AI-1848: <title>

---
**Universal task-handling canon (v1):**
<canon rules — applies to every ticket>
---

This is a [dev-impl] workflow ticket in state: **implementation**

Your legal action(s) for this state:
- Run `linear submit AI-1848` (→ code-review)

---
**Step guidance (accumulated lessons for this state):**
<state-specific rules>
---
```

The canon appears **once**, clearly delimited, **before** per-step guidance — on all three paths (workflow, ad-hoc, mention).
