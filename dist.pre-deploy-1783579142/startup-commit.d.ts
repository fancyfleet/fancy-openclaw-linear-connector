export interface StartupCommitResult {
    commit: string;
    /** Where the commit came from: the deploy stamp, git HEAD, or neither. */
    source: "deploy-stamp" | "git" | "unknown";
}
/**
 * Resolve the commit that /health reports (AI-1841).
 *
 * Under the AI-1832 deploy model the shared working tree is never touched by
 * deploys and may sit on an unrelated feature branch, so `git rev-parse HEAD`
 * says nothing about the code actually running. The deploy script stamps the
 * deployed commit into dist/DEPLOY_COMMIT for exactly this reason — prefer
 * that stamp, and fall back to git HEAD only when it is absent (dev mode,
 * `npm run dev`, test runs).
 */
export declare function resolveStartupCommit(opts?: {
    deployCommitPath?: string;
    cwd?: string;
}): Promise<StartupCommitResult>;
//# sourceMappingURL=startup-commit.d.ts.map