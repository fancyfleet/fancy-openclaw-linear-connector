import type { Request, Response } from "express";
/**
 * Cookie-session layer for the management console (Phase 3).
 *
 * Tokens are stateless HMAC values derived from ADMIN_SECRET, so sessions
 * survive connector restarts (which are routine) and are all invalidated at
 * once by rotating ADMIN_SECRET. Header-based auth (x-admin-secret / Bearer /
 * Basic) remains first-class for API clients and the readonly socket.
 */
export declare const SESSION_COOKIE = "admin_session";
export declare const SESSION_TTL_MS: number;
export declare function mintSessionToken(secret: string, now?: Date, ttlMs?: number): string;
export declare function verifySessionToken(token: string, secret: string, now?: Date): boolean;
export declare function parseCookies(header: string | undefined): Record<string, string>;
export declare function sessionTokenFromRequest(req: Request): string | null;
export declare function setSessionCookie(res: Response, token: string, ttlMs?: number): void;
export declare function clearSessionCookie(res: Response): void;
/**
 * In-memory login throttle. Brute-forcing ADMIN_SECRET through the login
 * endpoint must be slower than guessing it offline is impossible.
 */
export declare class LoginRateLimiter {
    private maxFailures;
    private windowMs;
    private now;
    private failures;
    constructor(maxFailures?: number, windowMs?: number, now?: () => number);
    /** True when this key has exhausted its failure budget. */
    isBlocked(key: string): boolean;
    recordFailure(key: string): void;
    reset(key: string): void;
}
//# sourceMappingURL=admin-session.d.ts.map