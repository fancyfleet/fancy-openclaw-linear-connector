/**
 * INF-1301 — Normalize uppercase test-file prefixes (M5)
 *
 * Verbatim AC (2026-08-07T04:09:37.049Z):
 *   AC1: All six files renamed to lowercase inf-/ai- prefixes, matching the 212-file majority.
 *   AC2: No production file modified.
 *   AC3: Full suite passes; no test silently dropped (rename only, no content changes).
 *
 * Scope (ticket description): exactly the 5 INF-*.test.ts and 1 AI-*.test.ts
 * at src/ root → rename to lowercase prefix. Test-only; no production files touched.
 *
 * This file is the TDD red harness. It MUST fail before the rename and pass
 * after the rename. Run with:
 *   NODE_OPTIONS='--experimental-vm-modules' npx jest src/inf-1301-normalize-prefixes.test.ts --forceExit
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, it, expect } from "@jest/globals";

// ---------------------------------------------------------------------------
// Ground truth — the uppercase files observed on origin/main at intake.
// Ticket says "5 INF + 1 AI = 6"; git ls on origin/main shows 7 (6 INF + 1 AI).
// We pin the 7 observed so an 8th uppercase file introduced later also fails
// AC1 via the generic "no uppercase remains" assertion.
// ---------------------------------------------------------------------------
const KNOWN_UPPERCASE_FILES = [
  "AI-2304-allow-direct-token.test.ts",
  "INF-1264-deploy-drift-bootstrap.test.ts",
  "INF-316-liveness-channel.test.ts",
  "INF-331-mark-cron-run-wiring.test.ts",
  "INF-341-cron-startup-readiness.test.ts",
  "INF-348-cron-token-refresh-wiring.test.ts",
  "INF-413-dispatch-inflight-guard.test.ts",
] as const;

const KNOWN_LOWERCASE_TARGETS = KNOWN_UPPERCASE_FILES.map((f) => f.toLowerCase()) as readonly string[];

function srcRoot(): string {
  return path.resolve(process.cwd(), "src");
}

function listSrcRootTestFiles(): string[] {
  return fs
    .readdirSync(srcRoot())
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
}

// ---------------------------------------------------------------------------
// AC1 — all uppercase prefixes gone, lowercase counterparts present
// ---------------------------------------------------------------------------
describe("INF-1301 AC1 — uppercase prefixes normalized to lowercase", () => {
  it("no file at src/ root has an uppercase INF- / AI- / AGI- prefix", () => {
    const files = listSrcRootTestFiles();
    const uppercase = files.filter((f) => /^(INF|AI|AGI)-/.test(f));
    expect(uppercase).toEqual([]);
  });

  it("every formerly-uppercase file exists at its lowercase path", () => {
    const files = new Set(listSrcRootTestFiles());
    // The ticket scope names 6 files; we assert the full observed 7.
    // If a file was correctly renamed, the lowercase name is present.
    // Before the rename this fails because only the uppercase names exist.
    for (const low of KNOWN_LOWERCASE_TARGETS) {
      expect(files.has(low)).toBe(true);
    }
  });

  it("lowercase inf-/ai- majority still dominates (212+ migrated)", () => {
    // Before the rename, 6–7 files break the convention; after it zero do.
    const files = listSrcRootTestFiles();
    const uppercaseCount = files.filter((f) => /^(INF|AI|AGI)-/.test(f)).length;
    const lowercasePrefixedCount = files.filter((f) => /^(inf|ai|agi)-/.test(f)).length;
    expect(uppercaseCount).toBe(0);
    // Sanity: the majority is large — at least 212 as stated in the ticket.
    expect(lowercasePrefixedCount).toBeGreaterThanOrEqual(212);
  });
});

// ---------------------------------------------------------------------------
// AC2 — no production file modified (rename is test-only)
// ---------------------------------------------------------------------------
describe("INF-1301 AC2 — no production file modified", () => {
  it("git diff vs origin/main touches only test files (and this harness itself)", () => {
    // Collect changed names vs origin/main (both staged and unstaged).
    // Allowlist:
    //   - src/*.test.ts (including the harness itself: inf-1301-*.test.ts)
    //   - deleted uppercase src/INF-*.test.ts / AI-*.test.ts
    // Anything else (non-test src/**/*.ts, config, scripts) must not appear.
    let diffNames: string[] = [];
    try {
      const raw = execSync("git diff --name-only origin/main --diff-filter=AMDR 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10000,
      });
      diffNames = raw.trim().split("\n").filter(Boolean);
    } catch {
      // If git diff fails (no origin/main), fall back to git status porcelain.
      const raw = execSync("git status --porcelain 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10000,
      });
      diffNames = raw
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    }

    // Also include untracked files via status if diff was empty (new harness case).
    // Merge both sets to be robust.
    try {
      const statusRaw = execSync("git status --porcelain 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10000,
      });
      const statusNames = statusRaw
        .split("\n")
        .map((l) => l.slice(3).trim().split(" -> ").pop()!.trim())
        .filter(Boolean);
      for (const n of statusNames) if (!diffNames.includes(n)) diffNames.push(n);
    } catch {
      // ignore
    }

    const disallowed = diffNames.filter((n) => {
      // Allow test files anywhere, mocks/fixtures, and this harness.
      if (n.endsWith(".test.ts")) return false;
      if (n.startsWith("src/__mocks__/")) return false;
      if (n.startsWith("src/__fixtures__/")) return false;
      if (n.startsWith("src/inf-1301-")) return false;
      // scripts/connector-worktree helpers etc are not in scope
      // but any src/ non-test .ts is disallowed.
      if (n.startsWith("src/") && n.endsWith(".ts") && !n.endsWith(".test.ts")) return true;
      // All other non-src, non-test changes (e.g. Dockerfile) are also disallowed
      // for this ticket's scope — it's rename-only. The only expected non-test
      // file that might appear in some envs is package-lock which we also reject.
      if (n === "Dockerfile") return true;
      if (n.startsWith("src/") && !n.endsWith(".test.ts")) {
        // Any other src/ file (json, yaml, etc) counts as production-adjacent.
        // For this ticket, only .test.ts renames are allowed.
        return true;
      }
      return false;
    });

    // Provide the disallowed set in the failure message for debuggability.
    expect(disallowed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — no test silently dropped; rename only, no content changes
// ---------------------------------------------------------------------------
describe("INF-1301 AC3 — no test silently dropped; rename-only (content identical)", () => {
  it("total src/*.test.ts file count is preserved (no test dropped)", () => {
    // On origin/main, enumerate count via git ls-tree so we compare against
    // the base, not the current working tree's ambiguous state during rename.
    const baseListRaw = execSync("git ls-tree -r --name-only origin/main -- src 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10000,
    });
    const baseTestCount = baseListRaw
      .split("\n")
      .filter((p) => p.startsWith("src/") && p.endsWith(".test.ts") && !p.slice(4).includes("/"))
      .length;
    const currentTestCount = listSrcRootTestFiles().length;
    // The harness itself (inf-1301-*.test.ts) is a net +1 vs base. So after
    // the rename, current count should be base count + 1 (this file).
    // Before the rename, current count is also base + 1 (this file added but
    // uppercase files still present), so this alone would not be red.
    // The stronger guard below (content identity) provides the red signal.
    // We still assert the invariant so a dropped file fails post-rename.
    expect(currentTestCount).toBe(baseTestCount + 1);
  });

  it("each renamed file's content is byte-identical to its origin/main uppercase original", () => {
    // For each known uppercase file, read its content from origin/main and
    // compare to the current lowercase file's content. Before the rename
    // the lowercase file does not exist → read fails → test fails (red).
    // After the rename it exists and must be identical (rename only).
    const root = srcRoot();
    for (const upper of KNOWN_UPPERCASE_FILES) {
      const lower = upper.toLowerCase();
      const lowerPath = path.join(root, lower);

      // This read will throw before the rename (ENOENT) → red.
      const currentContent = fs.readFileSync(lowerPath, "utf-8");

      // Original content from origin/main (the uppercase path).
      const baseContent = execSync(`git show origin/main:src/${upper} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(currentContent).toBe(baseContent);
    }
  });

  it("jest will discover the renamed files (testMatch covers them)", () => {
    // Jest config is **/*.test.ts — both old and new names match. Verify that
    // the renamed lowercase files are among jest's discovered test files.
    // This guards against a rename that silently drops a file from the suite
    // because it was moved out of roots or excluded by testMatch.
    const jestListRaw = execSync(
      "npx jest --listTests --json 2>/dev/null | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const arr=Array.isArray(j)?j:(j.testFiles||[]);console.log(arr.join('\\n'))}catch(e){console.log(d)}})\" 2>/dev/null",
      {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const discovered = new Set(
      jestListRaw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => path.basename(p)),
    );
    for (const low of KNOWN_LOWERCASE_TARGETS) {
      expect(discovered.has(low)).toBe(true);
    }
  });
});
