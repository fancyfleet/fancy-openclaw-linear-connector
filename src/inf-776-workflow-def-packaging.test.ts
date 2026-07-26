/**
 * INF-776 — canonical workflow-def packaging and drift-fixture consolidation.
 *
 * Red tests only. These pin the packaging/source-of-truth contract Igor should
 * implement without changing runtime code here.
 *
 *   AC1 — one documented in-repo source-of-truth path for bundled canonical defs
 *         used by runtime reconcile and fixture drift checks.
 *   AC2 — Docker/runtime packaging explicitly ships only the workflow-def files
 *         reconcile needs, not accidental src/ availability.
 *   AC3 — npm workflow sync checks pass from a clean repo-shaped tree and fail
 *         on intentional registered-def ⇄ fixture drift.
 *   AC4 — covered in the Linear handoff comment: remaining WDD deletion risk
 *         and production WDD ownership treatment must be named there or in the PR.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "@jest/globals";
import {
  canonicalFixtureIds,
  registeredDefIds,
} from "../scripts/check-workflow-def-sync.mjs";

const REPO_ROOT = process.cwd();
const SOURCE_OF_TRUTH_PATH = "src/registered-defs/";
const FIXTURE_PATH = "src/__fixtures__/";
const DOC_PATH = path.join(REPO_ROOT, "docs", "workflow-def-packaging.md");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const SYNC_SCRIPT = path.join(REPO_ROOT, "scripts", "check-workflow-def-sync.mjs");
const INSTALLED_NODE_MODULES = path.resolve(REPO_ROOT, "..", "..", "node_modules");

function copyYamlDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    if (file.endsWith(".yaml")) {
      fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
  }
}

function makeCleanRepoShape(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inf776-clean-clone-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(SYNC_SCRIPT, path.join(root, "scripts", "check-workflow-def-sync.mjs"));
  copyYamlDir(path.join(REPO_ROOT, "src", "registered-defs"), path.join(root, "src", "registered-defs"));
  copyYamlDir(path.join(REPO_ROOT, "src", "__fixtures__"), path.join(root, "src", "__fixtures__"));

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    type?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      type: packageJson.type,
      scripts: { "check:workflow-sync": packageJson.scripts?.["check:workflow-sync"] },
      dependencies: { "js-yaml": packageJson.dependencies?.["js-yaml"] },
    }, null, 2),
  );
  fs.copyFileSync(path.join(REPO_ROOT, "package-lock.json"), path.join(root, "package-lock.json"));
  // Model a clean clone after dependency install without making this contract
  // test run npm install itself.
  fs.symlinkSync(INSTALLED_NODE_MODULES, path.join(root, "node_modules"), "dir");
  return root;
}

function runtimeDockerfileLines(): string[] {
  const raw = fs.readFileSync(DOCKERFILE, "utf8");
  const runtimeFrom = raw.lastIndexOf("\nFROM node:22-alpine");
  expect(runtimeFrom).toBeGreaterThanOrEqual(0);
  return raw.slice(runtimeFrom).split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("INF-776 AC1: documented canonical workflow-def source path", () => {
  it("documents one source-of-truth path used by runtime reconcile and fixture drift", () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
    const doc = fs.readFileSync(DOC_PATH, "utf8");

    expect(doc).toContain(SOURCE_OF_TRUTH_PATH);
    expect(doc).toMatch(/source[- ]of[- ]truth/i);
    expect(doc).toMatch(/runtime reconcile/i);
    expect(doc).toMatch(/fixture drift/i);

    const canonicalPathMentions = doc.match(/src\/(?:registered-defs|__fixtures__)\/?/g) ?? [];
    expect(new Set(canonicalPathMentions)).toEqual(new Set([SOURCE_OF_TRUTH_PATH]));
  });
});

describe("INF-776 AC2: runtime image packages explicit workflow-def payload", () => {
  it("copies bundled canonical defs and drift fixtures into the runtime image without copying all of src/", () => {
    const runtimeLines = runtimeDockerfileLines();
    const copyLines = runtimeLines.filter((line) => line.startsWith("COPY "));

    expect(copyLines).toContain(`COPY ${SOURCE_OF_TRUTH_PATH} ${SOURCE_OF_TRUTH_PATH}`);
    expect(copyLines).toContain(`COPY ${FIXTURE_PATH} ${FIXTURE_PATH}`);
    expect(copyLines.some((line) => /^COPY\s+(--from=\S+\s+)?src\/\s+src\/?$/.test(line))).toBe(false);
  });

  it("ships exactly the repo workflow defs that runtime reconcile can load", () => {
    const registered = registeredDefIds(REPO_ROOT);
    const fixtures = canonicalFixtureIds(REPO_ROOT).filter((id: string) => id !== "terminal-barrier");

    expect(registered).toEqual(fixtures);
    expect(registered.length).toBeGreaterThan(0);

    const runtimeLines = runtimeDockerfileLines();
    expect(runtimeLines.join("\n")).toContain(SOURCE_OF_TRUTH_PATH);
    expect(runtimeLines.join("\n")).toContain(FIXTURE_PATH);
  });
});

describe("INF-776 AC3: npm workflow sync gate remains clean-clone runnable and drift-sensitive", () => {
  it("keeps npm run check:workflow-sync wired to the canonical sync script", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["check:workflow-sync"]).toBe("node scripts/check-workflow-def-sync.mjs --check");
  });

  it("passes on a clean repo-shaped tree and fails when a fixture intentionally drifts", () => {
    const root = makeCleanRepoShape();

    expect(() => {
      execFileSync("npm", ["run", "check:workflow-sync", "--", "--root", root], {
        cwd: root,
        env: process.env,
        stdio: "pipe",
      });
    }).not.toThrow();

    const driftFixture = path.join(root, "src", "__fixtures__", "canonical-dev-impl.yaml");
    fs.appendFileSync(driftFixture, "\ninf776_intentional_fixture_drift: true\n");

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync("npm", ["run", "check:workflow-sync", "--", "--root", root], {
        cwd: root,
        env: process.env,
        stdio: "pipe",
      });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? -1;
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("dev-impl");
    expect(stderr).toContain("diverge structurally");
  });
});
