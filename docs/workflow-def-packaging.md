# Workflow Definition Packaging

`src/registered-defs/` is the in-repo source-of-truth path for bundled canonical workflow definitions.

Runtime reconcile loads workflow definitions through `WORKFLOW_DEFS_DIR`. In production that variable points at the host-owned workflow-def directory, which is populated from the canonical repo path during deploy. The Docker image also packages the canonical repo path directly so container builds no longer depend on an accidental broad `src/` copy being present.

Fixture drift checks compare live workflow definitions against generated canonical fixture mirrors. Those mirrors are generated from the source-of-truth path by `npm run check:workflow-sync` and `node scripts/check-workflow-def-sync.mjs --write [id]`; do not hand-edit them.

Remaining WDD deletion risk: local or host workflow-def directory contents outside the repository are not deleted or garbage-collected by this packaging contract. Production treats WDD ownership as host/deploy-owned state: deploy may add or refresh files from the repo canonical path, while removal of non-repo or stale WDD files remains an explicit operator/reconciliation action.
