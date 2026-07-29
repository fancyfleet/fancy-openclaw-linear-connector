/**
 * Session key normalization for Linear connector.
 *
 * All session keys must be exactly `linear-<TEAM>-<NUMBER>` in uppercase.
 * This module strips any legacy prefixes (wake-, linear-wake-, wake-linear-)
 * and enforces uppercase identifiers.
 *
 * Usage: call `normalizeSessionKey()` at every point where a session key
 * is created or passed to the gateway, session tracker, or delivery layer.
 *
 * INF-982: Session keys may carry an optional `:r<N>` recovery-version suffix
 * (e.g. `linear-INF-982:r2`) for stale re-dispatch. normalizeSessionKey strips
 * this suffix and returns the clean base key so internal tracking (sessionTracker,
 * bag, ackTracker) uses the canonical form. The versioned form is used only at
 * the gateway dispatch layer to create a fresh OpenClaw session label.
 */

/** Linear issue identifier pattern: 1-10 uppercase letters, hyphen, 1-6 digits */
const LINEAR_ID_RE = /^([A-Z]{1,10})-(\d{1,6})$/;

/** Recovery-version suffix pattern: :r<N> at end of key */
const RECOVERY_VERSION_SUFFIX_RE = /:r\d+$/i;

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
 * - `linear-INF-982:r2` → `linear-INF-982` (strip recovery version)
 *
 * Returns the normalized key, or throws if no valid Linear identifier found.
 */
export function normalizeSessionKey(key: string): string {
  if (!key || typeof key !== "string") {
    throw new Error(`Invalid session key: ${key}`);
  }

  // Strip recovery-version suffix (:r<N>) before any other processing
  let cleaned = key.replace(RECOVERY_VERSION_SUFFIX_RE, "");

  // Strip known legacy prefixes
  cleaned = cleaned
    .replace(/^wake-linear-/i, "")   // wake-linear-ILL-152
    .replace(/^linear-wake-/i, "")   // linear-wake-ILL-152
    .replace(/^wake-/i, "")          // wake-ILL-152
    .replace(/^linear-/i, "");       // linear-ILL-152 → ILL-152

  // Force uppercase (handles lowercase like ill-152 → ILL-152)
  cleaned = cleaned.toUpperCase();

  // Validate the identifier matches TEAM-NUMBER pattern
  if (!LINEAR_ID_RE.test(cleaned)) {
    throw new Error(
      `Cannot normalize session key "${key}": "${cleaned}" is not a valid Linear identifier`
    );
  }

  return `linear-${cleaned}`;
}

/**
 * Check if a string looks like it might contain a Linear identifier
 * and return the normalized key, or null if not parseable.
 * Safe variant that doesn't throw.
 */
export function tryNormalizeSessionKey(key: string): string | null {
  try {
    return normalizeSessionKey(key);
  } catch {
    return null;
  }
}

/**
 * Extract the raw Linear identifier from a possibly-versioned session key.
 * Strips any recovery-version suffix and legacy prefixes, returning just the
 * team-number portion (without `linear-` prefix or `:rN` suffix).
 * E.g. "linear-INF-982:r2" → "INF-982"
 */
export function stripRecoveryVersion(sessionKey: string): string {
  const normalized = tryNormalizeSessionKey(sessionKey);
  if (normalized) return normalized;
  // Fallback: remove recovery version and try again
  const stripped = sessionKey.replace(RECOVERY_VERSION_SUFFIX_RE, "");
  return tryNormalizeSessionKey(stripped) ?? sessionKey;
}

/**
 * Build a fresh session key for a stale re-dispatch, incorporating a
 * monotonic recovery attempt number so OpenClaw creates a new session label
 * instead of reusing the stale one. The stale-session forensics module uses
 * the session key to find the session file; a fresh key prevents it from
 * reading the OLD session's JSONL (zero-output, stale findings).
 *
 * Format: `linear-INF-982:r<attempt>`
 *
 * normalizeSessionKey strips the `:rN` suffix and returns the clean base key
 * for internal tracking. The versioned form is passed through to the gateway
 * at dispatch time.
 */
export function makeFreshSessionKey(baseKey: string, attemptNumber: number): string {
  const normalized = normalizeSessionKey(baseKey);
  return `${normalized}:r${attemptNumber}`;
}
