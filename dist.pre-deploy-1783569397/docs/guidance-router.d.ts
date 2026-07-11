/**
 * AI-1849 (Pillar 2 D2) — Connector docs endpoint.
 *
 * Serves instance-config docs (policy/, capability renderings) read-only to
 * authenticated agents using their lpx proxy token. The `linear guidance`
 * CLI verb fetches docs through this endpoint.
 *
 * Routes:
 *   GET /docs           — topic list
 *   GET /docs/:topic    — doc body (or per-agent capability rendering)
 *
 * Auth: Bearer lpx_* proxy token (NOT admin secret).
 */
import { Router } from "express";
export interface GuidanceTopic {
    id: string;
    description: string;
}
export declare function createGuidanceRouter(): Router;
/** Liveness snapshot for /health. */
export declare function getDocsLiveness(): {
    registered: true;
};
//# sourceMappingURL=guidance-router.d.ts.map