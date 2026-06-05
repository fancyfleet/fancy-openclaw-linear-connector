/**
 * GraphQL pass-through proxy — Phase 0B, design.md §4.6.
 *
 * Sits between the Linear CLI and api.linear.app. v0 is transparent:
 * every request is forwarded unchanged so the proxy can be validated as
 * load-bearing before any enforcement logic is added.
 *
 * Future phases add outbound instruction injection (§4.6 outbound) and
 * inbound command validation (§4.6 inbound) scoped to workflow tickets.
 */
import type { Request, Response } from "express";
export declare function handleProxyRequest(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=proxy.d.ts.map