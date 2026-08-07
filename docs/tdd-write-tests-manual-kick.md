# TDD write-tests manual-kick recipe — INF-1305

This documents the post-INF-1295 write-tests lane rule for the TDD singleton.

## When to use

A write-tests ticket (`wf:dev-impl` / `state:write-tests`, delegate TDD) has a
dispatch lease that remains idempotent/acknowledged (`skippedIdempotent: 1` on
redispatch) while no usable output has landed — no failing-test artifact pushed,
no concrete blocker comment, no `tests-ready` transition.

Live evidence that produced this recipe (engine-watch 2026-08-07 06:04Z):

- INF 1301 / 1302 / 1303 / 1294 — no-activity shape: dispatch failures at
  04:33Z and 04:49Z, connector-admin redispatch returned `skippedIdempotent: 1`,
  no test artifact.
- INF 1300 / 1304 — C6 bootstrap/model-error shape: TDD C6 error earlier in the
  same batch; later redispatches should be watched, not advanced blindly.
- INF 1305 itself — redispatch returned `skippedIdempotent: 1` / healed 0 after
  repeated no-activity comments, reproducing the same lease/no-output class.

## Rule (verbatim phrases required by AC5)

> **Do not advance write-tests without an inspectable test artifact.**

The advancing action is the `tests-ready` (→ implementation) transition that
hands off to the implementer. It requires a pushed branch containing the
failing-test file that the reviewer can inspect — a comment describing intent
does not count.

> **One connector-admin redispatch is allowed.**

If the dispatch record is missing (gateway accepted the dispatch but the agent
never started — the C6/model/bootstrap no-activity path), one
connector-admin redispatch is allowed to heal a stale delivery record. It is
the only manual kick permitted without a code artifact.

> **Idempotent / no-heal means the class-owner fix must handle it.**

If the redispatch returns `skippedIdempotent: 1`, `isEscalated`, or otherwise
heals zero records, and still no artifact or explicit TDD blocker appears, do
not keep redispatching. The class-owner connector/runtime fix on INF-1305 (the
`writeTestsNoOutputStall` component and its `/health` + warnings surfacing) is
the owner — the per-ticket retry loop is not the fix.

The keywords `idempotent` and `class-owner` in the previous sentence are the
AC5 phrase gates the TDD test suite checks for.

## Telemetry

After INF-1305, liveness is observable without waiting for a failure:

- `GET /health` → `writeTestsNoOutputStall: { scheduled, active, subscribed, stalledCount, stalledTickets }`.
  `scheduled`/`active`/`subscribed` prove the component is registered at the
  production entry point (`index.ts` → `createApp` → `registerWriteTestsNoOutputStall`);
  `stalledCount`/`stalledTickets` let engine-watch distinguish healthy
  in-progress dispatch (lease active, ticket progressing) from
  idempotent-but-stalled dispatch (lease active, no output for longer than the
  no-activity window).
- `GET /health` → `crons` includes `write-tests-no-output-stall` (registered
  inside the registrar, AI-1810 pattern).
- Repeated idempotent/no-output cycles for the same `(tdd, ticket)` are
  surfaced as a distinct actionable failure (stalled entry / `warnings` kind
  `write-tests-no-output-stall`) rather than left in live write-tests limbo.

## See also

- `src/write-tests-no-output-stall.ts` — registrar + `/health` state.
- `src/inf-1305-tdd-write-tests-idempotent-no-output.test.ts` — AC1–AC8 red suite.
