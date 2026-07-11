/**
 * AI-1900 — Known-human Linear user IDs.
 *
 * Humans (Matt) are deliberately absent from agents.json, so every event on a
 * ticket assigned to a human used to trip the no-route routing pager
 * ("unknown to agents.json"). A ticket assigned to a human is a *correct*
 * no-route, not the silent "assigned it and nothing happened" failure the
 * pager exists to catch. This module resolves the configured human IDs so the
 * webhook can drop them from the pager while genuinely unknown IDs (typo'd
 * delegate, unregistered agent) keep paging.
 *
 * Config file (instance config, NOT committed to this repo):
 *   {configRoot}/config/known-humans.yaml   (override: KNOWN_HUMANS_PATH)
 *
 *   known_humans:
 *     - id: 544710ca-0438-478e-b97f-3aaee89cbb69
 *       name: Matt Henry
 *     - 00000000-0000-0000-0000-000000000000   # bare id also accepted
 *
 * Fail posture: a missing file means no known humans (pager behaves exactly
 * as before — the exclusion is opt-in). A malformed file is treated the same
 * but raises a deduped warning alert: silently losing the exclusion would put
 * the false-positive noise right back on the channel.
 */
export declare function knownHumansPath(): string;
/** Test hook: drop the mtime-keyed cache. */
export declare function resetKnownHumansCache(): void;
/**
 * Load the known-human map (Linear user ID → display name), cached by
 * (path, mtime) so config edits are picked up without a restart. Never throws.
 */
export declare function loadKnownHumans(): ReadonlyMap<string, string>;
/** Display name for a configured known-human Linear user ID, or null. */
export declare function knownHumanName(linearUserId: string): string | null;
//# sourceMappingURL=known-humans.d.ts.map