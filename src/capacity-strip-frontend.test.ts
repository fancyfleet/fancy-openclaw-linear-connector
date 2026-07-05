/**
 * AI-1802 AC1 (frontend gap) — Strip *shows*: capacity strip rendered in the console.
 *
 * Root cause of the AC-validate rollback (Astrid, 2026-07-05):
 *   "the test phase scoped coverage to the endpoint only, so implementation /
 *    review / merge all passed against endpoint-shaped tests while the
 *    user-facing half of the deliverable was untested."
 *
 * This file closes that gap. It verifies:
 *
 *   1. Source-level: the React CapacityStrip component exists, is mounted on
 *      the Fleet page, fetches GET /admin/api/capacity, and renders
 *      over-capacity state visibly (AC1 "Strip shows").
 *
 *   2. Build-level: a production web build (`cd web && npm run build`) emits
 *      the capacity strip into web/dist. This is the test that would have
 *      caught the second AC-validate failure — web/dist was never rebuilt
 *      after PR #154, so the live console served a stale SPA without the
 *      strip. The deploy pipeline had no web-build step; this test enforces
 *      that a clean build includes the frontend deliverable.
 *
 * AC2 (read-only) is already covered by capacity-strip.test.ts (mutation
 * endpoints → 404). This file does not duplicate that coverage.
 *
 * These tests use static analysis on source files and build output rather
 * than a React component harness, because the web/ directory has no jsdom /
 * testing-library infrastructure and adding that is an implementation
 * decision outside the test-author role.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const WEB_DIR = path.join(REPO_ROOT, "web");
const WEB_SRC = path.join(WEB_DIR, "src");
const WEB_DIST = path.join(WEB_DIR, "dist");
const COMPONENT_PATH = path.join(WEB_SRC, "components", "CapacityStrip.tsx");
const FLEET_PAGE_PATH = path.join(WEB_SRC, "pages", "FleetPage.tsx");
const TYPES_PATH = path.join(WEB_SRC, "types.ts");

function readFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

function readWebFile(rel: string): string {
  return fs.readFileSync(path.join(WEB_DIR, rel), "utf-8");
}

// ===========================================================================
// AC1 (source-level): Capacity strip component exists and meets the AC
// ===========================================================================

describe("AI-1802 AC1 (frontend source): CapacityStrip component", () => {
  //
  it("CapacityStrip.tsx exists in web/src/components/", () => {
    expect(fs.existsSync(COMPONENT_PATH)).toBe(true);
  });

  //
  it("exports a CapacityStrip React component", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    expect(src).toMatch(/export\s+function\s+CapacityStrip/);
  });

  //
  it("fetches capacity data from GET /admin/api/capacity", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    // The component must reference the capacity endpoint — this is what
    // wires the visible strip to the backend data source.
    expect(src).toContain("/admin/api/capacity");
  });

  //
  it("renders slotsUsed / cap per agent (AC1 core data)", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    expect(src).toMatch(/slotsUsed/);
    expect(src).toMatch(/\.cap\b/);
    expect(src).toMatch(/parkedCount/);
  });

  //
  it("visually distinguishes over-capacity agents (slotsUsed > cap)", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    // Over-capacity must be visually distinct — a class toggle or chip
    // that makes slotsUsed > cap immediately apparent.
    expect(src).toMatch(/over[\s-]?cap/i);
    // Boolean condition derived from comparing slotsUsed against cap
    expect(src).toMatch(/slotsUsed\s*>\s*\w*\.?\s*cap/);
  });

  //
  it("excludes idle agents (renders from API data, not hardcoded)", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    // The component must consume the agents array from the API response
    // rather than rendering a static list.
    expect(src).toMatch(/agents/);
    // Must not contain hardcoded agent names
    expect(src).not.toMatch(/["']igor["']/i);
    expect(src).not.toMatch(/["']astrid["']/i);
  });

  //
  it("is read-only — no form, button, or mutation action (AC2)", () => {
    const src = readWebFile("src/components/CapacityStrip.tsx");
    expect(src).not.toMatch(/<button/i);
    expect(src).not.toMatch(/<form/i);
    expect(src).not.toMatch(/onClick/);
    expect(src).not.toMatch(/apiPost|apiPut|apiPatch|apiDelete/);
  });
});

// ===========================================================================
// AC1 (integration): Fleet page mounts the capacity strip
// ===========================================================================

describe("AI-1802 AC1 (integration): Fleet page mounts CapacityStrip", () => {
  //
  it("FleetPage.tsx imports the CapacityStrip component", () => {
    const src = readWebFile("src/pages/FleetPage.tsx");
    expect(src).toMatch(/import.*CapacityStrip/i);
  });

  //
  it("FleetPage.tsx renders <CapacityStrip /> in the page", () => {
    const src = readWebFile("src/pages/FleetPage.tsx");
    expect(src).toMatch(/<CapacityStrip\s*\/>/);
  });
});

// ===========================================================================
// AC1 (types): CapacityResponse / CapacityAgent types defined
// ===========================================================================

describe("AI-1802 AC1 (types): web frontend type definitions", () => {
  //
  it("types.ts defines CapacityAgent with agentId, slotsUsed, cap, parkedCount", () => {
    const src = readWebFile("src/types.ts");
    expect(src).toMatch(/interface\s+CapacityAgent/);
    expect(src).toMatch(/agentId:\s*string/);
    expect(src).toMatch(/slotsUsed:\s*number/);
    expect(src).toMatch(/cap:\s*number/);
    expect(src).toMatch(/parkedCount:\s*number/);
  });

  //
  it("types.ts defines CapacityResponse with agents array", () => {
    const src = readWebFile("src/types.ts");
    expect(src).toMatch(/interface\s+CapacityResponse/);
    expect(src).toMatch(/agents:\s*CapacityAgent\[\]/);
  });
});

// ===========================================================================
// AC1 (build-level): production web build includes the capacity strip
//
// This is the test that would have caught the second AC-validate failure.
// web/dist was stale (built from PR #140) because the deploy pipeline had
// no `cd web && npm run build` step. A clean build MUST emit the strip.
// ===========================================================================

describe("AI-1802 AC1 (build): web/dist production artifact includes capacity strip", () => {
  // The deployed web/dist is the artifact the connector serves to browsers.
  // It must contain the capacity strip — AC1 says "Strip shows".
  // This test checks the committed / existing build output, exactly what a
  // deploy would ship. If this fails, the web frontend was not rebuilt after
  // a source change — the exact bug that caused the second AC-validate fail.

  //
  it("web/dist directory exists", () => {
    expect(fs.existsSync(WEB_DIST)).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIST, "index.html"))).toBe(true);
  });

  //
  it("web/dist/assets contains at least one JS bundle", () => {
    const assetsDir = path.join(WEB_DIST, "assets");
    expect(fs.existsSync(assetsDir)).toBe(true);
    const jsFiles = fs
      .readdirSync(assetsDir)
      .filter((f) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  //
  it("built JS bundle references the capacity endpoint (GET /admin/api/capacity)", () => {
    const jsFiles = fs
      .readdirSync(path.join(WEB_DIST, "assets"))
      .filter((f) => f.endsWith(".js"));

    const allJs = jsFiles
      .map((f) => readWebFile(path.join("dist", "assets", f)))
      .join("\n");

    expect(allJs).toContain("/admin/api/capacity");
  });

  //
  it("built JS bundle contains capacity strip rendering logic (slotsUsed, parkedCount)", () => {
    const jsFiles = fs
      .readdirSync(path.join(WEB_DIST, "assets"))
      .filter((f) => f.endsWith(".js"));

    const allJs = jsFiles
      .map((f) => readWebFile(path.join("dist", "assets", f)))
      .join("\n");

    expect(allJs).toMatch(/slotsUsed/);
    expect(allJs).toMatch(/parkedCount/);
  });

  //
  it("built CSS includes over-capacity styling (AC1 visual distinction)", () => {
    const cssFiles = fs
      .readdirSync(path.join(WEB_DIST, "assets"))
      .filter((f) => f.endsWith(".css"));

    const allCss = cssFiles
      .map((f) => readWebFile(path.join("dist", "assets", f)))
      .join("\n");

    expect(allCss.toLowerCase()).toMatch(/over[\s-]?cap/);
  });

  // -----------------------------------------------------------------------
  // Vite build verification: a fresh vite build must emit capacity strip code
  // into the bundle. We run `npx vite build` (not `npm run build` which
  // includes tsc --noEmit) to isolate capacity-strip coverage from
  // pre-existing TS errors in other pages (e.g. WorkflowsPage.tsx).
  // -----------------------------------------------------------------------

  let viteBuildOk = false;
  let viteBuildError: string | undefined;
  let viteDistJs = "";
  let viteDistCss = "";

  beforeAll(() => {
    try {
      execSync("npx vite build --outDir dist-vitest", {
        cwd: WEB_DIR,
        timeout: 120_000,
        stdio: "pipe",
        env: { ...process.env },
      });
      viteBuildOk = true;

      const vitestAssetsDir = path.join(WEB_DIR, "dist-vitest", "assets");
      if (fs.existsSync(vitestAssetsDir)) {
        viteDistJs = fs
          .readdirSync(vitestAssetsDir)
          .filter((f) => f.endsWith(".js"))
          .map((f) => fs.readFileSync(path.join(vitestAssetsDir, f), "utf-8"))
          .join("\n");
        viteDistCss = fs
          .readdirSync(vitestAssetsDir)
          .filter((f) => f.endsWith(".css"))
          .map((f) => fs.readFileSync(path.join(vitestAssetsDir, f), "utf-8"))
          .join("\n");
      }
    } catch (err) {
      viteBuildError = err instanceof Error ? err.message : String(err);
    }
  }, 130_000);

  afterAll(() => {
    // Clean up the throwaway build directory
    const vitestDir = path.join(WEB_DIR, "dist-vitest");
    if (fs.existsSync(vitestDir)) {
      fs.rmSync(vitestDir, { recursive: true, force: true });
    }
  });

  //
  it("vite build completes without error", () => {
    expect(viteBuildOk).toBe(true);
    if (!viteBuildOk && viteBuildError) {
      throw new Error(`vite build failed: ${viteBuildError}`);
    }
  });

  //
  it("vite build output contains /admin/api/capacity in the JS bundle", () => {
    expect(viteBuildOk).toBe(true);
    expect(viteDistJs).toContain("/admin/api/capacity");
  });

  //
  it("vite build output contains over-capacity CSS class in the stylesheet", () => {
    expect(viteBuildOk).toBe(true);
    expect(viteDistCss.toLowerCase()).toMatch(/over[\s-]?cap/);
  });
});

// ===========================================================================
// Deploy gate: root build script must include the web frontend build
//
// The deploy runbook and CI relied on `npm run build` at the repo root,
// which only compiles the backend (tsc). The web frontend build was missing
// from the deploy pipeline. This test enforces that the root build or a
// deploy-configured script includes the web build step.
// ===========================================================================

describe("AI-1802 deploy gate: web build included in build/deploy pipeline", () => {
  //
  it("root package.json references web build in its build script (or a deploy script)", () => {
    const pkg = JSON.parse(readFile("package.json")) as {
      scripts: Record<string, string>;
    };

    // The root build script must either:
    // (a) directly include a web build step, or
    // (b) there must be a dedicated deploy/build script that does.
    const allScripts = Object.entries(pkg.scripts).map(
      ([name, cmd]) => `${name}: ${cmd}`,
    );

    const hasWebBuildStep = allScripts.some((s) =>
      /web.*npm\s+run\s+build|npm\s+run\s+build.*web/i.test(s),
    );

    expect(hasWebBuildStep).toBe(true);
  });

  //
  it("deployment documentation includes a web frontend build step", () => {
    // The deploy runbook (docs/deployment.md) must mention building the web
    // frontend — otherwise operators will miss the step in production.
    const deployDoc = readFile("docs/deployment.md");
    expect(deployDoc).toMatch(/web.*npm\s+run\s+build|npm\s+run\s+build.*web/i);
  });
});
