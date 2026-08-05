/**
 * INF-1274 AC (verbatim):
 *   - Replace all 94 call sites with `const log = createModuleLogger("module-name");`.
 *   - `grep -rn 'componentLogger(createLogger' src/**\/*.ts` (excluding tests,
 *     excluding the new helper's own implementation) returns zero matches.
 *
 * This test walks src/**\/*.ts itself (rather than shelling out to grep, per
 * intake's globstar-portability note) and asserts the raw
 * `componentLogger(createLogger` construction is gone from every production
 * call site outside logger.ts (the primitives) and logging.ts (the new
 * helper's own implementation).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname); // src/

const OFFENDING_PATTERN = /componentLogger\(createLogger/;

// Files allowed to contain the raw construction: the low-level primitives
// module and the new helper that wraps them. Everything else is a call site
// that must go through createModuleLogger().
const ALLOWED_BASENAMES = new Set(["logger.ts", "logging.ts"]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("INF-1274 AC: componentLogger(createLogger duplication eliminated", () => {
  it("no production call site outside logger.ts/logging.ts uses componentLogger(createLogger(...) directly", () => {
    const files = walkTsFiles(SRC_DIR).filter((f) => {
      const base = path.basename(f);
      if (base.endsWith(".test.ts")) return false;
      if (ALLOWED_BASENAMES.has(base)) return false;
      return true;
    });

    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (OFFENDING_PATTERN.test(content)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("createModuleLogger is used as the module-logger construction across the codebase (sanity: helper is actually adopted, not just defined)", () => {
    const files = walkTsFiles(SRC_DIR).filter((f) => {
      const base = path.basename(f);
      if (base.endsWith(".test.ts")) return false;
      if (ALLOWED_BASENAMES.has(base)) return false;
      return true;
    });

    const adopters = files.filter((f) =>
      /createModuleLogger\(/.test(fs.readFileSync(f, "utf8")),
    );

    // 93 non-test production call sites were duplicating the pattern at
    // intake time (94 total matches include one occurrence inside a helper
    // module). Assert broad adoption rather than hard-coding 93, so the test
    // doesn't need updating if the module is split/renamed — but a handful
    // of adopters would indicate the migration stalled partway through.
    expect(adopters.length).toBeGreaterThanOrEqual(80);
  });
});
