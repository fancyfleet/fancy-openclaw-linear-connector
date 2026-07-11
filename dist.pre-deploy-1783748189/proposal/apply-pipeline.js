/**
 * AI-2039 (P4-C4) — Apply pipeline: atomic, TOCTOU-guarded, versioned applies.
 *
 * An approved proposal mutates live step-guidance files
 * (`workflows/<wf>/<state>.md`) or workflow-def YAML (`workflows/<wf>.yaml`)
 * in the instance config dir — safely, idempotently, versioned, and reversibly.
 *
 * Guarantees (AC of record AI-2039 AC4.1–4.8):
 *  - **Atomic** (AC4.1): every file is written to a sibling temp file and
 *    renamed into place, so a concurrent wake read only ever observes the
 *    complete old or complete new bytes — never a torn/partial file — and no
 *    temp file is left behind.
 *  - **Hot-reload** (AC4.2/4.3): step guidance is read fresh per dispatch, so a
 *    guidance apply needs no invalidation. Workflow-def YAML *is* cached, so a
 *    YAML apply calls the injected `reloadWorkflowDefs()` (wired to
 *    `resetWorkflowCache` in prod) — an explicit def-cache reload, no restart.
 *  - **TOCTOU guard** (AC4.4): each target's current on-disk bytes are re-hashed
 *    and compared to the captured `oldContent.hash`. Any mismatch refuses the
 *    whole apply as `stale` (no write, no commit, no version bump) — a manual
 *    edit landing between generation and approval is preserved.
 *  - **Idempotent** (AC4.5): keyed by `idempotencyKey`; a second (or concurrent)
 *    apply of the same proposal is a no-op that returns `alreadyApplied`. An
 *    in-process per-key lock serializes double-clicks so exactly one apply and
 *    one version bump happen.
 *  - **Versioned + reversible** (AC4.6): every apply increments the `version:`
 *    field of the owning workflow-def YAML and commits both the changed file and
 *    the bumped def to git in the config dir. `git revert` restores prior content
 *    AND prior version.
 *  - **Baseline capture** (AC4.7): the cluster metrics snapshot + observation
 *    window is captured at apply time and stored with the applied record so a
 *    before/after comparison is computable at pilot. Not captured on a stale
 *    refusal.
 *  - **Failure surfacing** (AC4.8): any failure (e.g. the git commit) rolls the
 *    files back to their pre-apply bytes (no half-write), records `apply-failed`
 *    with a `retryable` flag, and is re-runnable via {@link retryApply}.
 *
 * Proposal shape is C3's amended `targets[]` (AI-2038 AC3.1):
 *   { id, idempotencyKey, targets: [{ kind, path, oldContent:{hash,snapshot}, newContent, diff }] }
 * where `path` is relative to `deps.configRoot`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * The workflow-def YAML that owns a target and whose version this apply bumps.
 * A `yaml` target IS the def. A `guidance` target lives at
 * `workflows/<wf>/<state>.md`; its owning def is `workflows/<wf>.yaml`.
 */
function owningDefRelPath(target) {
    if (target.kind === "yaml")
        return target.path;
    return `${path.dirname(target.path)}.yaml`;
}
/** Increment the first `version: N` field; returns the new content and version. */
function bumpVersion(content) {
    const match = content.match(/^(\s*version:\s*)(\d+)/m);
    if (!match) {
        throw new Error("workflow def has no numeric 'version:' field to increment");
    }
    const next = Number(match[2]) + 1;
    const out = content.replace(/^(\s*version:\s*)(\d+)/m, (_full, prefix) => `${prefix}${next}`);
    return { content: out, version: next };
}
let _tmpCounter = 0;
/** Write `content` to a sibling temp file, then atomically rename it into place. */
async function atomicWrite(absPath, content) {
    const dir = path.dirname(absPath);
    const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${process.pid}-${_tmpCounter++}`);
    await fs.writeFile(tmp, content, "utf8");
    try {
        await fs.rename(tmp, absPath);
    }
    catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => { });
        throw err;
    }
}
async function git(configRoot, args) {
    const { stdout } = await execFileAsync("git", args, { cwd: configRoot });
    return stdout.trim();
}
// ── Per-key serialization (AC4.5 concurrent double-click) ───────────────────
// A single in-process lock per idempotencyKey. Two concurrent apply()s of the
// same proposal serialize; the second sees the first's recorded "applied" and
// returns alreadyApplied — exactly one real apply, one commit, one version bump.
const _applyLocks = new Map();
async function withKeyLock(key, fn) {
    while (_applyLocks.has(key)) {
        await _applyLocks.get(key).catch(() => { });
    }
    let release;
    const held = new Promise((resolve) => (release = resolve));
    _applyLocks.set(key, held);
    try {
        return await fn();
    }
    finally {
        _applyLocks.delete(key);
        release();
    }
}
// ── Core apply ──────────────────────────────────────────────────────────────
async function doApply(proposal, deps) {
    const { configRoot, store, captureMetrics, reloadWorkflowDefs, now } = deps;
    // (AC4.5) Idempotency: a proposal already applied is a no-op.
    const existing = store.getByIdempotencyKey(proposal.idempotencyKey);
    if (existing && existing.status === "applied") {
        return {
            status: "applied",
            alreadyApplied: true,
            version: existing.version,
            commit: existing.commit,
            metricsBaseline: existing.metricsBaseline,
        };
    }
    // (AC4.4) TOCTOU guard: re-hash each current file against the captured hash.
    const staleTargets = [];
    for (const target of proposal.targets) {
        const abs = path.join(configRoot, target.path);
        let current;
        try {
            current = await fs.readFile(abs, "utf8");
        }
        catch {
            current = null;
        }
        const currentHash = current === null ? null : sha256hex(current);
        if (currentHash !== target.oldContent.hash)
            staleTargets.push(target.path);
    }
    if (staleTargets.length > 0) {
        // No write, no commit, no version bump, no baseline capture (AC4.7).
        store.record({
            id: proposal.id,
            idempotencyKey: proposal.idempotencyKey,
            status: "stale",
            staleTargets,
            updatedAt: now(),
        });
        return { status: "stale", staleTargets };
    }
    // (AC4.7) Baseline capture — only past the TOCTOU gate.
    const metricsBaseline = captureMetrics();
    // Snapshots of every file we touch, for rollback on failure (AC4.8).
    const originals = new Map();
    const hasYamlTarget = proposal.targets.some((t) => t.kind === "yaml");
    try {
        // Build the write plan: target bytes, then a version bump on each owning def.
        const writes = new Map();
        for (const target of proposal.targets) {
            writes.set(path.join(configRoot, target.path), target.newContent);
        }
        // (AC4.6) Every apply bumps the owning workflow-def YAML version — including
        // a guidance-only apply. Bump each unique owning def exactly once.
        const defRelPaths = [...new Set(proposal.targets.map(owningDefRelPath))].sort();
        let primaryVersion;
        for (const defRel of defRelPaths) {
            const defAbs = path.join(configRoot, defRel);
            const base = writes.has(defAbs) ? writes.get(defAbs) : await fs.readFile(defAbs, "utf8");
            const bumped = bumpVersion(base);
            writes.set(defAbs, bumped.content);
            if (primaryVersion === undefined)
                primaryVersion = bumped.version;
        }
        // Snapshot originals, then write everything atomically.
        for (const abs of writes.keys()) {
            try {
                originals.set(abs, await fs.readFile(abs, "utf8"));
            }
            catch {
                originals.set(abs, null);
            }
        }
        for (const [abs, content] of writes) {
            await atomicWrite(abs, content);
        }
        // (AC4.6) Commit the changed file(s) + version-bumped def to git.
        await git(configRoot, ["add", "-A"]);
        await git(configRoot, ["commit", "-m", `apply: proposal ${proposal.id} (v${primaryVersion})`]);
        const commit = await git(configRoot, ["rev-parse", "HEAD"]);
        // (AC4.3) A YAML apply reloads the def cache; guidance is served fresh.
        if (hasYamlTarget)
            reloadWorkflowDefs();
        store.record({
            id: proposal.id,
            idempotencyKey: proposal.idempotencyKey,
            status: "applied",
            version: primaryVersion,
            commit,
            metricsBaseline,
            updatedAt: now(),
        });
        return { status: "applied", version: primaryVersion, commit, metricsBaseline };
    }
    catch (err) {
        // (AC4.8) Roll every touched file back to its pre-apply bytes — no half-write.
        for (const [abs, orig] of originals) {
            try {
                if (orig === null)
                    await fs.rm(abs, { force: true });
                else
                    await atomicWrite(abs, orig);
            }
            catch {
                // best-effort restore
            }
        }
        const error = err instanceof Error ? err.message : String(err);
        store.record({
            id: proposal.id,
            idempotencyKey: proposal.idempotencyKey,
            status: "apply-failed",
            error,
            retryable: true,
            updatedAt: now(),
        });
        return { status: "apply-failed", error, retryable: true };
    }
}
// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Apply an approved proposal. Atomic, TOCTOU-guarded, idempotent, versioned,
 * and reversible. See the module header for the AC mapping.
 */
export async function applyProposal(proposal, deps) {
    return withKeyLock(proposal.idempotencyKey, () => doApply(proposal, deps));
}
/**
 * Re-run a previously failed (or not-yet-applied) apply — the API's retry
 * affordance (AC4.8). Identical to {@link applyProposal}: an already-applied
 * proposal short-circuits to `alreadyApplied`, so a retry after success still
 * bumps the version exactly once total.
 */
export async function retryApply(proposal, deps) {
    return withKeyLock(proposal.idempotencyKey, () => doApply(proposal, deps));
}
//# sourceMappingURL=apply-pipeline.js.map