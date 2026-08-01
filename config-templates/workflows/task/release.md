# Step: release (non-code `wf:task` deliverables)

## What this covers

A `wf:task` ticket is a department **doing something** — a governed Linear
workflow action, a decision, a spec sign-off, a document. Its deliverable is
**non-code**: there is no branch and no pull request, by design. This note
documents the sanctioned release path for these tickets and the force-deploy /
escape recovery rule when a release routes through a multi-body requester role.

Origin: [INF-862](https://linear.app/fancymatt/issue/INF-862). A `wf:task`
deliverable ([INF-850](https://linear.app/fancymatt/issue/INF-850)) was routed
onto the dev-impl merge/deploy spine and reached the `merge` state, where the
release gate (§5.6) demands branch/PR evidence. None exists for a non-code
deliverable, so the ticket stranded: Hanzo could not complete, `needs-human`, or
force-deploy cleanly, and it had to be escaped back to requester intake and
completed ad hoc. That is the failure this path exists to prevent.

## Intended non-code task release behavior

A `wf:task` ticket releases through its **own** workflow — never through
dev-impl. The `task` workflow def (`src/registered-defs/task.yaml`) declares the
contract explicitly:

```yaml
release:
  kind: non-code-task
  approved_state: sign-off
  terminal_state: done
  requires_github_pr_evidence: false
```

The release path for an approved non-code task is:

1. The worker does the work and `submit`s to the department head (`review`).
2. The head `approve`s; the ticket advances to **`sign-off`**, delegated to the
   requester. `sign-off` is the approval gate — "is this what I asked for?"
3. The requester runs **`linear continue-workflow <identifier>`** (the `accept`
   transition) to carry the ticket to the **`done`** terminal.

There is **no GitHub pull request requirement** anywhere on this path — a
non-code task has no PR, and the release gate does not, and must not, ask for
one. A `wf:task` ticket must never be placed on the dev-impl `merge`/`deploy`
spine; if you see a non-code deliverable there, the routing is wrong — move it
back onto the `task` workflow rather than trying to force it through the code
release gate.

If you are on a `wf:dev-impl` ticket and hit
`'continue' blocked: cannot release — no branch/PR evidence found`, that message
now names this path: the deliverable is non-code and belongs on `wf:task`.

## Multi-body requester target: force-deploy / escape recovery

The `requester` role is **multi-body** — both `matt` and `ai` fill it (see the
department roster and `task.yaml` role-binding modes). When a recovery action
that routes through the requester role — a **force-deploy** or an **escape**
break-glass back to requester intake — does not name a body, the target is
**ambiguous**: the proxy cannot tell which requester body to route to.

Rule:

- **Provide an explicit target.** When force-deploy / escape routes through the
  multi-body `requester` role, the target is **required** unless it can be
  resolved unambiguously. Name the body:
  `linear escape {identifier} --target <matt|ai>` (or the force-deploy
  equivalent). An unresolvable multi-body role with no `--target` fails loudly
  ("target required / ambiguous") rather than picking a body silently.
- **The already-designated requester wins when unambiguous.** If the ticket
  already has a pinned requester (the body instance-bound at intake — commonly
  `ai`, the de-facto sign-off authority, or `matt`), the proxy should route the
  recovery to **that** designated requester instead of demanding a target. Only
  when no requester is pinned, or the pin cannot be resolved, is an explicit
  `--target` required.

This is the same family as the escape-target defect fixed in INF-555: a recovery
verb that routes through a role, not a body, must resolve role → body before it
can act, and must surface the required target cleanly instead of wedging on a
bare command.

## What NOT to do

- Do NOT route a non-code `wf:task` deliverable through dev-impl merge/deploy —
  it will strand on the branch/PR evidence gate.
- Do NOT reach for force-deploy / escape to "unstick" a stranded non-code task —
  fix the routing (put it on `wf:task`) so it releases via `sign-off` → `done`.
- Do NOT force-deploy / escape through the multi-body requester role **without**
  an explicit `--target` when the requester is not already pinned.
