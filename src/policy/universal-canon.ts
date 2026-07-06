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

import fs from "node:fs/promises";
import path from "node:path";
import { instanceConfigRoot } from "../instance-config.js";
import { componentLogger, createLogger } from "../logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "universal-canon");

/** Result of a successful canon load. */
export interface CanonLoadResult {
  /** Canon body text (rules), without the frontmatter. */
  text: string;
  /** Version parsed from the frontmatter `version:` key. */
  version: string;
}

/**
 * Last canon loaded by `loadUniversalCanon()`. Tracked module-level so the
 * delivery layer can stamp the version into the dispatch record without
 * re-reading the file (the message builder already read it moments ago).
 */
let activeCanon: CanonLoadResult | null = null;

/**
 * Path to the universal canon file.
 *
 * Override via UNIVERSAL_POLICY_PATH for tests, mirroring the
 * WORKFLOW_DEF_PATH / WORKFLOW_GUIDANCE_DIR pattern.
 */
export function universalPolicyPath(): string {
  return (
    process.env.UNIVERSAL_POLICY_PATH ??
    path.join(instanceConfigRoot(), "policy", "universal.md")
  );
}

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
export function parseCanonFile(content: string): { version: string; body: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2];
    const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);
    const version = versionMatch ? versionMatch[1].trim().replace(/^["']|["']$/g, "") : "unversioned";
    return { version, body: body.trim() };
  }
  return { version: "unversioned", body: content.trim() };
}

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
export async function loadUniversalCanon(): Promise<CanonLoadResult | null> {
  const filePath = universalPolicyPath();
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) {
      log.warn(`universal-canon: canon file is empty at ${filePath} — dispatch will proceed without canon section`);
      activeCanon = null;
      return null;
    }
    const { version, body } = parseCanonFile(content);
    if (!body.trim()) {
      log.warn(`universal-canon: canon file has frontmatter but empty body at ${filePath} — dispatch will proceed without canon section`);
      activeCanon = null;
      return null;
    }
    activeCanon = { text: body, version };
    log.debug(`universal-canon: loaded version '${version}' from ${filePath}`);
    return activeCanon;
  } catch (err) {
    // ENOENT (file missing) or EACCES (permissions) or any other read error
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      `universal-canon: could not load canon file at ${filePath} — dispatch will proceed without canon section. Reason: ${reason}`,
    );
    activeCanon = null;
    return null;
  }
}

/**
 * The canon version that was injected into the most recent dispatch message
 * built in this process. Returns null when no canon was loaded (missing,
 * broken, or not yet loaded).
 *
 * Used by the delivery layer to stamp the version into the dispatch record
 * without re-reading the canon file.
 */
export function getActiveCanonVersion(): string | null {
  return activeCanon?.version ?? null;
}

/**
 * Liveness snapshot for /health. Shows whether the canon file loaded and its
 * version, so ac-validate can confirm registration without waiting for a
 * trigger condition.
 */
export function getCanonLiveness(): {
  loaded: boolean;
  version: string | null;
  path: string;
} {
  return {
    loaded: activeCanon !== null,
    version: activeCanon?.version ?? null,
    path: universalPolicyPath(),
  };
}

/**
 * Format the canon text as a delimited block for insertion into a dispatch
 * message. Returns null when no canon text is provided.
 *
 * The block is clearly delimited with `---` rules and a bold heading so agents
 * can visually distinguish it from per-step guidance.
 */
export function formatCanonBlock(canonText: string | null, version: string | null): string | null {
  if (!canonText || !canonText.trim()) return null;
  const versionTag = version ? ` (${version})` : "";
  return [
    "",
    "---",
    `**Universal task-handling canon${versionTag}:**`,
    "",
    canonText.trim(),
    "---",
  ].join("\n");
}

/** Test-only: reset module-level state between test cases. */
export function _resetCanonForTest(): void {
  activeCanon = null;
}
