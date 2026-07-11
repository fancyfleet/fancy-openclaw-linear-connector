/**
 * Upload proxy — AI-1767.
 *
 * `uploads.linear.app` URLs require a real Linear OAuth token. Agent containers
 * only have `lpx_` proxy tokens (the connector swaps in real credentials for
 * GraphQL calls in proxy.ts, but fetch-image bypassed the proxy entirely).
 *
 * This endpoint mirrors the GraphQL proxy pattern: resolve the agent from its
 * proxy token, swap in the vaulted real Linear token, fetch the asset from
 * uploads.linear.app, and stream the bytes back to the caller.
 *
 * Security:
 *   - Same broker-token authentication as /proxy/graphql (getAgentByProxyToken).
 *   - Linear-host allowlist enforced server-side so the real token can never be
 *     sent to an arbitrary host (same rationale as the CLI-side guard, but
 *     enforced at the point where the real token is used).
 *   - Size capped at MAX_UPLOAD_BYTES to prevent unbounded buffering.
 */
import type { Request, Response } from "express";
export declare function handleProxyUploadRequest(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=proxy-upload.d.ts.map