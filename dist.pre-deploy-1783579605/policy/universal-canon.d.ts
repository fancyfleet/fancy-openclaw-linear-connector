/**
 * AI-1848 (Pillar 2 D1) — Universal policy canon loader.
 *
 * The canon is a short (~30 line) set of universal task-handling rules that
 * every dispatched agent must see, regardless of whether it read its
 * AGENTS.md / MEMORY.md. The dispatch wake message is the only guaranteed-
 * delivery channel, so the canon is inlined into every dispatch message.
 *
 * Design (mirrors step guidance / C5):
 *  - File lives in instance config: {configRoot}/policy/universal.md
 *    (outside repo + vault — survives git reset and vault reorgs).
 *  - Loaded fail-open: missing or unparseable file → WARN + no canon section.
 *    Dispatch always goes out.
 *  - Read-per-dispatch (no build-time compile): canon edits take effect
 *    without a connector rebuild. The file is re-read on every dispatch.
 *  - Version marker in YAML frontmatter (`version: v1`) is parsed and stamped
 *    into the dispatch record (pillar-4 audit surface).
 *
 * Liveness: /health exposes `universalCanon: { loaded, version }` so ac-validate
 * can confirm the canon loaded without waiting for a trigger condition.
 */
/** Result of a successful canon load. */
export interface CanonLoadResult {
    /** Canon body text (rules), without the frontmatter. */
    text: string;
    /** Version parsed from the frontmatter `version:` key. */
    version: string;
}
/**
 * Path to the universal canon file.
 *
 * Override via UNIVERSAL_POLICY_PATH for tests, mirroring the
 * WORKFLOW_DEF_PATH / WORKFLOW_GUIDANCE_DIR pattern.
 */
export declare function universalPolicyPath(): string;
/**
 * Parse the canon file: extract the version from YAML frontmatter and the
 * body text (everything after the frontmatter closing `---`).
 *
 * Accepted formats:
 *   ---
 *   version: v1
 *   ---
 *   <canon body>
 *
 * If there is no frontmatter, the version defaults to "unversioned" and the
 * entire file is treated as the body.
 */
export declare function parseCanonFile(content: string): {
    version: string;
    body: string;
};
/**
 * Load the universal canon from disk (fail-open).
 *
 * On success: caches the result and returns `{ text, version }`.
 * On missing file: logs WARN, returns null (dispatch proceeds without canon).
 * On unparseable file: logs WARN, returns null (dispatch proceeds without canon).
 *
 * Re-reads the file every call — canon edits take effect without a rebuild
 * (AC: hot-reload / read-per-dispatch).
 */
export declare function loadUniversalCanon(): Promise<CanonLoadResult | null>;
/**
 * The canon version that was injected into the most recent dispatch message
 * built in this process. Returns null when no canon was loaded (missing,
 * broken, or not yet loaded).
 *
 * Used by the delivery layer to stamp the version into the dispatch record
 * without re-reading the canon file.
 */
export declare function getActiveCanonVersion(): string | null;
/**
 * Liveness snapshot for /health. Shows whether the canon file loaded and its
 * version, so ac-validate can confirm registration without waiting for a
 * trigger condition.
 */
export declare function getCanonLiveness(): {
    loaded: boolean;
    version: string | null;
    path: string;
};
/**
 * Format the canon text as a delimited block for insertion into a dispatch
 * message. Returns null when no canon text is provided.
 *
 * The block is clearly delimited with `---` rules and a bold heading so agents
 * can visually distinguish it from per-step guidance.
 */
export declare function formatCanonBlock(canonText: string | null, version: string | null): string | null;
/** Test-only: reset module-level state between test cases. */
export declare function _resetCanonForTest(): void;
//# sourceMappingURL=universal-canon.d.ts.map