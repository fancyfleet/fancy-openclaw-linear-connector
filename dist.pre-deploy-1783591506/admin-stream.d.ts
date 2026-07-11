/**
 * AI-1952: SSE live-refresh stream for the admin console.
 *
 * Exports:
 *   emitStreamTopic(topic) — fire-and-forget topic invalidation for internal signal sources
 *   mountStreamRoute(router) — register GET /api/stream on the admin router
 */
import type { Router } from "express";
export type StreamTopic = "board" | "fleet" | "alerts" | "events" | "dead-letters";
export declare function emitStreamTopic(topic: StreamTopic): void;
export declare function mountStreamRoute(router: Router): void;
//# sourceMappingURL=admin-stream.d.ts.map