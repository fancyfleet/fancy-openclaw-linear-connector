/**
 * AI-1848 (Pillar 2 D1) — Universal policy canon loader tests.
 *
 * Verifies:
 *  - File loads successfully with version + body parsed from frontmatter.
 *  - Missing file → fail-open (returns null, WARN logged, no crash).
 *  - Broken/unparseable file → fail-open.
 *  - Empty file → fail-open.
 *  - Hot-reload: file edits take effect on the next load (read-per-dispatch).
 *  - getActiveCanonVersion() reflects the last loaded version.
 *  - getCanonLiveness() reports loaded state + version for /health.
 *  - formatCanonBlock() produces a clearly delimited section.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadUniversalCanon,
  getActiveCanonVersion,
  getCanonLiveness,
  formatCanonBlock,
  parseCanonFile,
  universalPolicyPath,
  _resetCanonForTest,
} from "./universal-canon.js";

// ── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-test-"));
  _resetCanonForTest();
});

afterEach(() => {
  _resetCanonForTest();
  delete process.env.UNIVERSAL_POLICY_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setCanonFile(content: string): string {
  const filePath = path.join(tmpDir, "universal.md");
  fs.writeFileSync(filePath, content, "utf8");
  process.env.UNIVERSAL_POLICY_PATH = filePath;
  return filePath;
}

// ── parseCanonFile ────────────────────────────────────────────────────────

describe("parseCanonFile", () => {
  it("extracts version from frontmatter and returns body", () => {
    const result = parseCanonFile("---\nversion: v1\n---\nRule 1\nRule 2");
    expect(result.version).toBe("v1");
    expect(result.body).toBe("Rule 1\nRule 2");
  });

  it("strips quotes from version value", () => {
    const result = parseCanonFile('---\nversion: "v2.1"\n---\nBody');
    expect(result.version).toBe("v2.1");
  });

  it("defaults to 'unversioned' when no frontmatter", () => {
    const result = parseCanonFile("Just rules\nNo frontmatter");
    expect(result.version).toBe("unversioned");
    expect(result.body).toBe("Just rules\nNo frontmatter");
  });

  it("defaults to 'unversioned' when frontmatter has no version key", () => {
    const result = parseCanonFile("---\nauthor: matt\n---\nRules here");
    expect(result.version).toBe("unversioned");
    expect(result.body).toBe("Rules here");
  });
});

// ── loadUniversalCanon ────────────────────────────────────────────────────

describe("loadUniversalCanon", () => {
  it("loads a valid canon file with version and text", async () => {
    setCanonFile("---\nversion: v1\n---\n1. Be honest.\n2. Be thorough.");
    const result = await loadUniversalCanon();
    expect(result).not.toBeNull();
    expect(result!.version).toBe("v1");
    expect(result!.text).toContain("Be honest.");
    expect(result!.text).toContain("Be thorough.");
  });

  it("missing file → fail-open (returns null, no throw)", async () => {
    process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "nonexistent.md");
    const result = await loadUniversalCanon();
    expect(result).toBeNull();
    expect(getActiveCanonVersion()).toBeNull();
  });

  it("empty file → fail-open (returns null)", async () => {
    setCanonFile("");
    const result = await loadUniversalCanon();
    expect(result).toBeNull();
  });

  it("whitespace-only file → fail-open (returns null)", async () => {
    setCanonFile("   \n  \n");
    const result = await loadUniversalCanon();
    expect(result).toBeNull();
  });

  it("frontmatter but empty body → fail-open (returns null)", async () => {
    setCanonFile("---\nversion: v1\n---\n");
    const result = await loadUniversalCanon();
    expect(result).toBeNull();
  });

  it("getActiveCanonVersion reflects last loaded version", async () => {
    setCanonFile("---\nversion: v3\n---\nRule text.");
    await loadUniversalCanon();
    expect(getActiveCanonVersion()).toBe("v3");
  });

  it("getActiveCanonVersion is null after a failed load (missing file)", async () => {
    setCanonFile("---\nversion: v1\n---\nInitial rules.");
    await loadUniversalCanon();
    expect(getActiveCanonVersion()).toBe("v1");

    // Now point to a missing file — should clear active canon.
    process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "gone.md");
    const result = await loadUniversalCanon();
    expect(result).toBeNull();
    expect(getActiveCanonVersion()).toBeNull();
  });
});

// ── Hot-reload (AC: canon edits take effect without a rebuild) ────────────

describe("hot-reload — read-per-dispatch", () => {
  it("editing the canon file changes the text on the next load", async () => {
    const filePath = setCanonFile("---\nversion: v1\n---\nOriginal rules.");
    expect(await loadUniversalCanon()).toMatchObject({ version: "v1", text: "Original rules." });

    // Edit the file (hot-reload scenario)
    fs.writeFileSync(filePath, "---\nversion: v2\n---\nUpdated rules.", "utf8");
    const result = await loadUniversalCanon();
    expect(result).toMatchObject({ version: "v2", text: "Updated rules." });
    expect(getActiveCanonVersion()).toBe("v2");
  });
});

// ── getCanonLiveness (AC: observable at /health) ──────────────────────────

describe("getCanonLiveness", () => {
  it("reports loaded=false before any load", () => {
    process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "universal.md");
    const liveness = getCanonLiveness();
    expect(liveness.loaded).toBe(false);
    expect(liveness.version).toBeNull();
  });

  it("reports loaded=true + version after successful load", async () => {
    setCanonFile("---\nversion: v1\n---\nRules.");
    await loadUniversalCanon();
    const liveness = getCanonLiveness();
    expect(liveness.loaded).toBe(true);
    expect(liveness.version).toBe("v1");
  });

  it("reports loaded=false after a failed load", async () => {
    process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "missing.md");
    await loadUniversalCanon();
    const liveness = getCanonLiveness();
    expect(liveness.loaded).toBe(false);
    expect(liveness.version).toBeNull();
  });
});

// ── formatCanonBlock ──────────────────────────────────────────────────────

describe("formatCanonBlock", () => {
  it("produces a clearly delimited block with heading and version", () => {
    const block = formatCanonBlock("Rule one.\nRule two.", "v1");
    expect(block).toContain("---");
    expect(block).toContain("**Universal task-handling canon (v1):**");
    expect(block).toContain("Rule one.");
    expect(block).toContain("Rule two.");
  });

  it("omits version tag when version is null", () => {
    const block = formatCanonBlock("Rule.", null);
    expect(block).toContain("**Universal task-handling canon:**");
    expect(block).not.toContain("(v");
  });

  it("returns null for empty text", () => {
    expect(formatCanonBlock("", "v1")).toBeNull();
    expect(formatCanonBlock(null, "v1")).toBeNull();
    expect(formatCanonBlock("   ", "v1")).toBeNull();
  });
});

// ── universalPolicyPath ───────────────────────────────────────────────────

describe("universalPolicyPath", () => {
  it("respects UNIVERSAL_POLICY_PATH env override", () => {
    process.env.UNIVERSAL_POLICY_PATH = "/custom/path/canon.md";
    expect(universalPolicyPath()).toBe("/custom/path/canon.md");
  });
});
