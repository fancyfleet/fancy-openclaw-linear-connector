# Leaked-credential rotation gate (INF-529)

A ticket whose whole purpose is **rotate a leaked credential** must not be
closeable without the rotation actually happening. Before this gate, silence read
as resolution: AI-2372 ("Rotate leaked `GEMINI_API_KEY`") was closed **Invalid**
with the key still live, and the already-pushed secret was externally harvested
for a $300+/day bill (origin: GEN-328).

The non-negotiable outcome: **a `sec:leaked-credential` ticket cannot resolve
without the key actually being rotated and the old value revoked.**

## Two enforcement layers

Closes reach Linear by two disjoint paths; each needs its own net.

| Path | Who | Reaches the proxy? | Net |
|---|---|---|---|
| Semantic CLI verb / raw mutation | an **agent** | yes | **Layer 1 — proxy gate** |
| UI state change | a **human** | no | **Layer 2 — reopen sweep** |

### Layer 1 — proxy gate (`leaked-credential-gate.ts`)

Wired into the proxy chain in `proxy.ts` alongside `checkEnforcementRules`, as a
**standalone** gate — *not* a branch inside the workflow gate. The origin failure
was a plain, non-workflow ticket, and both `checkEnforcementRules` and
`checkWorkflowRules` short-circuit for tickets with no `wf:*` label. This gate
keys on the `sec:leaked-credential` label alone and fires regardless of workflow.

It blocks a close when all of:
- the mutation is a close — a resolving verb (`complete-work`, `complete`,
  `cancel`, `abandon`, `invalidate`) **or** a raw `stateId` whose
  Linear `WorkflowState.type` is `completed`/`canceled` (covers Done, Canceled,
  Invalid), and
- the ticket carries `sec:leaked-credential`, and
- no rotation-confirmation artifact is present.

`refuse-work` is deliberately **not** a gated verb. It is decline-and-reroute
(sets status to Todo and re-delegates), not a terminal resolution — the mandate
is "cannot **close** without rotation," not "cannot reroute before rotation."
Gating it would strand a mis-delegated `sec:leaked-credential` ticket behind its
own protection. A refuse that somehow forwarded a genuine `completed`/`canceled`
`stateId` is still caught by the authoritative `stateId` type check.

Break-glass (steward) bypasses — a genuine non-rotation close is a human decision.

**Fail posture is asymmetric by design:** broad fail-*open* until we have
affirmative evidence the mutation is both a close and on a labelled ticket (a
transient Linear blip must not block unrelated fleet traffic); narrow fail-*closed*
once that evidence exists (if we cannot verify the artifact, we block — for a
security ticket the artifact must be affirmatively present).

### Layer 2 — reopen sweep (`leaked-credential-sweep.ts`)

A periodic sweep that re-opens any `sec:leaked-credential` ticket closed
(Done/Canceled/Invalid) within the lookback window without a rotation artifact,
posting a loud comment. Idempotent (a reopen marker prevents a reopen/reclose
war), advisory-safe (errors never throw), and blast-radius-capped
(`maxReopensPerCycle`).

**Disabled by default.** Set `LEAKED_CRED_SWEEP_ENABLED=1` to arm it — it mutates
ticket state, so arming is a deliberate operator step. Inert until the label is in
use. The proxy gate is always on regardless.

## The rotation-confirmation artifact

A comment on the ticket, in either form (both require an affirmative revocation
signal — the old value must be dead, not merely superseded):

- **Structured marker** (mirrors `artifact-disclosure:`):
  ```
  <!-- rotation-confirmed: {"credential":"GEMINI_API_KEY","revoked":true} -->
  ```
  The JSON payload must assert `revoked: true`.
- **Plaintext**: a line beginning `ROTATION-CONFIRMED` where the comment also
  asserts revocation/disablement/deletion of the old value, e.g.
  ```
  ROTATION-CONFIRMED: rotated GEMINI_API_KEY, old value revoked in console.
  ```

Detection logic is shared by both layers in `leaked-credential-artifact.ts` so
they can never disagree.

## The label

`sec:leaked-credential` is a **workspace-level** Linear label (so it applies to
tickets on any team). Apply it to any ticket whose resolution requires rotating a
leaked credential. Do **not** retroactively apply it to already-resolved historical
tickets — the gate is forward-looking, and (if the sweep is armed) a retroactive
label on a closed, artifact-less ticket would trigger a reopen.

## Environment flags

| Var | Default | Meaning |
|---|---|---|
| `LEAKED_CRED_SWEEP_ENABLED` | unset (off) | `1` arms the Layer 2 reopen sweep |
| `LEAKED_CRED_SWEEP_LOOKBACK_DAYS` | `30` | how far back the sweep scans |
| `LEAKED_CRED_SWEEP_POLL_INTERVAL_MS` | `3600000` (1h) | sweep cadence |
| `LEAKED_CRED_SWEEP_MAX_REOPENS` | `10` | per-cycle reopen cap |
