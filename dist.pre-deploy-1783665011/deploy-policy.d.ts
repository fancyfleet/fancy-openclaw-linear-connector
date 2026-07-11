/**
 * AI-1795 — Per-repo deploy policy: which repos lack CI auto-deploy.
 *
 * The dev-impl `deploy` transition (deployment → ac-validate) assumes merge
 * alone puts the new build in production. For repos without CI auto-deploy
 * (e.g. linear-webhook-fancymatt) that assumption is false: merge leaves the
 * running service on the old artifact, and ac-validate verifies a stale build.
 * Twice on AI-1775 this recurred despite YAML-comment guidance, so the engine
 * now enforces it: workflow-gate consults this policy and rejects `deploy` on
 * flagged repos, pointing at `handoff-host-deploy` instead.
 *
 * Policy file (instance config, NOT committed to this repo):
 *   {configRoot}/config/deploy-policy.yaml   (override: DEPLOY_POLICY_PATH)
 *
 *   repos:
 *     linear-webhook-fancymatt:
 *       ci_auto_deploy: false
 *     fancymatt/some-other-repo:      # owner-qualified keys also accepted
 *       ci_auto_deploy: false
 *
 * Fail posture: a missing policy file means no repos are flagged (the guard
 * is opt-in per repo, so absence must not block anyone). A malformed file is
 * treated the same but raises a deduped warning alert — silently losing
 * enforcement is exactly the failure mode this module exists to close.
 */
export interface DeployPolicy {
    /** Keyed by repo name ("linear-webhook-fancymatt") or "owner/repo". */
    repos: Record<string, {
        ci_auto_deploy?: boolean;
    }>;
}
export declare function deployPolicyPath(): string;
/** Test hook: drop the mtime-keyed cache. */
export declare function resetDeployPolicyCache(): void;
/**
 * Load the deploy policy, cached by (path, mtime) so config edits are picked
 * up without a restart. Never throws.
 */
export declare function loadDeployPolicy(): DeployPolicy;
/**
 * Of the given repo refs, return those flagged `ci_auto_deploy: false` in the
 * policy (deduped, in policy-key form for stable messaging).
 */
export declare function reposWithoutCiAutoDeploy(repoRefs: string[]): string[];
/**
 * Extract "owner/repo" refs from GitHub URLs (PR/branch/commit attachments).
 * Non-GitHub URLs and unparseable strings are ignored.
 */
export declare function githubRepoFromUrl(url: string): string | null;
//# sourceMappingURL=deploy-policy.d.ts.map