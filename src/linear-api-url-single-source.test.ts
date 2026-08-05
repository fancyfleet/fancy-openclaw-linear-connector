/**
 * INF-1271: Consolidate LINEAR_API_URL to a single source of truth in linear-helpers.ts.
 *
 * AC mapping:
 *   AC1 — linear-helpers.ts remains the single `export const LINEAR_API_URL` source of truth.
 *   AC2 — no other non-test .ts file under src/ declares its own `const LINEAR_API_URL`.
 *   AC3 — the two known inline fetch() offenders no longer hardcode the URL literal.
 *   AC4 — no non-test .ts file under src/ (other than linear-helpers.ts) contains the
 *         literal URL string at all, catching inline fetch() calls beyond AC3's two examples.
 *   AC5 — not covered here; validated by running the full suite after the refactor.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINEAR_API_URL } from "./linear-helpers.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const srcDir = path.join(repoRoot, "src");
const LINEAR_HELPERS_PATH = path.join(srcDir, "linear-helpers.ts");
const LITERAL_URL = "https://api.linear.app/graphql";

function walkTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...walkTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

// Test files legitimately mock/fixture the literal URL (e.g. linear-helpers.test.ts
// stubs global.fetch), so they're out of scope for both the declaration and literal scans.
function nonTestSourceFiles(): string[] {
  return walkTsFiles(srcDir).filter(
    (f) => !f.endsWith(".test.ts") && f !== LINEAR_HELPERS_PATH,
  );
}

describe("INF-1271: LINEAR_API_URL single source of truth", () => {
  it("AC1: linear-helpers.ts exports LINEAR_API_URL as the canonical Linear GraphQL endpoint", () => {
    expect(LINEAR_API_URL).toBe(LITERAL_URL);
  });

  it("AC2: no other non-test .ts file under src/ declares its own LINEAR_API_URL constant", () => {
    const declarationPattern = /const\s+LINEAR_API_URL\s*=/;
    const offenders = nonTestSourceFiles()
      .filter((f) => declarationPattern.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(repoRoot, f));

    expect(offenders).toEqual([]);
  });

  it("AC3: webhook/index.ts and delivery/build-message.ts no longer hardcode the Linear GraphQL URL", () => {
    const targets = [
      path.join(srcDir, "webhook", "index.ts"),
      path.join(srcDir, "delivery", "build-message.ts"),
    ];
    const offenders = targets
      .filter((f) => fs.readFileSync(f, "utf8").includes(LITERAL_URL))
      .map((f) => path.relative(repoRoot, f));

    expect(offenders).toEqual([]);
  });

  it("AC4: no non-test .ts file under src/ (other than linear-helpers.ts) contains the literal Linear GraphQL URL", () => {
    const offenders = nonTestSourceFiles()
      .filter((f) => fs.readFileSync(f, "utf8").includes(LITERAL_URL))
      .map((f) => path.relative(repoRoot, f));

    // toEqual([]) prints the full offenders array in its diff on failure, giving the
    // implementer the exact file list without needing a hardcoded expected count here.
    expect(offenders).toEqual([]);
  });
});
