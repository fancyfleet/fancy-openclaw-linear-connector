/**
 * Session key normalization for Linear connector.
 *
 * All session keys must be exactly `linear-<TEAM>-<NUMBER>` in uppercase.
 * This module strips any legacy prefixes (wake-, linear-wake-, wake-linear-)
 * and enforces uppercase identifiers.
 *
 * Usage: call `normalizeSessionKey()` at every point where a session key
 * is created or passed to the gateway, session tracker, or delivery layer.
 */
/**
 * Normalize a session key to the canonical `linear-TEAM-NUMBER` format.
 *
 * Handles:
 * - `linear-ILL-152` → `linear-ILL-152` (already correct)
 * - `linear-ill-152` → `linear-ILL-152` (lowercase fix)
 * - `wake-linear-ILL-152` → `linear-ILL-152` (strip legacy prefix)
 * - `linear-wake-ILL-152` → `linear-ILL-152` (strip legacy prefix)
 * - `ILL-152` → `linear-ILL-152` (add prefix)
 * - `ill-152` → `linear-ILL-152` (fix + add prefix)
 *
 * Returns the normalized key, or throws if no valid Linear identifier found.
 */
export declare function normalizeSessionKey(key: string): string;
/**
 * Check if a string looks like it might contain a Linear identifier
 * and return the normalized key, or null if not parseable.
 * Safe variant that doesn't throw.
 */
export declare function tryNormalizeSessionKey(key: string): string | null;
//# sourceMappingURL=session-key.d.ts.map