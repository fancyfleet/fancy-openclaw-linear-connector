/**
 * INF-723 — Workflow-def sync gate (registered-defs ⇄ __fixtures__).
 *
 * The connector's workflow-def registry silently diverged across three artifacts
 * (live WORKFLOW_DEFS_DIR, in-repo registered-defs, canonical fixtures) in both
 * directions, per-field, without a version bump — INF-720 was one symptom.
 * `scripts/check-workflow-def-sync.mjs` is the ratchet that makes the two IN-REPO
 * artifacts unable to disagree at the same commit. This suite pins its invariants.
 *
 *   AC1 — the gate passes at HEAD (known drift allowlisted, no unexpected drift)
 *   AC2 — a NEW drift on a non-allowlisted def fail-closes (the core guard)
 *   AC3 — a def that comes back into sync while still allowlisted fail-closes
 *         (the ratchet can only tighten)
 *   AC4 — a missing fixture, and an orphan canonical fixture, both fail-close
 *   AC5 — --write regenerates a fixture as a structural mirror of its registered-def
 *   AC6 — the real script exits 0 at HEAD and 1 on injected drift
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  checkWorkflowDefSync,
  writeFixtures,
  structurallyEqual,
  registeredDefIds,
  KNOWN_DRIFT,
} from "../scripts/check-workflow-def-sync.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-workflow-def-sync.mjs");

/** Copy src/registered-defs + src/__fixtures__ into an isolated temp repo root. */
function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inf723-"));
  for (const sub of ["registered-defs", "__fixtures__"]) {
    const dst = path.join(root, "src", sub);
    fs.mkdirSync(dst, { recursive: true });
    const srcDir = path.join(REPO_ROOT, "src", sub);
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith(".yaml")) fs.copyFileSync(path.join(srcDir, f), path.join(dst, f));
    }
  }
  return root;
}

/** An id that is a real registered-def and is NOT on the known-drift allowlist. */
function cleanDefId(root: string): string {
  const id = registeredDefIds(root).find((d: string) => !KNOWN_DRIFT.has(d));
  if (!id) throw new Error("no non-allowlisted registered-def found for the test");
  return id;
}

describe("INF-723 workflow-def sync gate", () => {
  it("AC1: passes at HEAD — known drift allowlisted, no unexpected drift", () => {
    const res = checkWorkflowDefSync(REPO_ROOT);
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("AC2: a NEW drift on a non-allowlisted def fail-closes", () => {
    const root = makeTempRoot();
    const id = cleanDefId(root);
    // Mutate the registered-def so it no longer matches its fixture.
    const p = path.join(root, "src", "registered-defs", `${id}.yaml`);
    const def = yaml.load(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    def.__inf723_injected_drift = true;
    fs.writeFileSync(p, yaml.dump(def));

    const res = checkWorkflowDefSync(root);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v: string) => v.includes(id) && v.includes("diverge structurally"))).toBe(true);
  });

  it("AC3: an allowlisted def that is back in sync fail-closes (ratchet only tightens)", () => {
    const root = makeTempRoot();
    const id = [...KNOWN_DRIFT][0];
    // Regenerate the fixture from the registered-def → now in sync while still allowlisted.
    writeFixtures(root, [id]);
    const res = checkWorkflowDefSync(root);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v: string) => v.includes(id) && v.includes("KNOWN_DRIFT"))).toBe(true);
  });

  it("AC4: a missing fixture and an orphan canonical fixture both fail-close", () => {
    const root = makeTempRoot();
    const id = cleanDefId(root);
    fs.rmSync(path.join(root, "src", "__fixtures__", `canonical-${id}.yaml`));
    // Orphan: a canonical fixture with no registered-def sibling and not allowlisted.
    fs.writeFileSync(
      path.join(root, "src", "__fixtures__", "canonical-inf723-orphan.yaml"),
      "id: inf723-orphan\nversion: 1\n",
    );

    const res = checkWorkflowDefSync(root);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v: string) => v.includes(id) && v.includes("no canonical fixture"))).toBe(true);
    expect(res.violations.some((v: string) => v.includes("inf723-orphan") && v.includes("no src/registered-defs"))).toBe(
      true,
    );
  });

  it("AC5: --write regenerates a fixture as a structural mirror of its registered-def", () => {
    const root = makeTempRoot();
    const id = [...KNOWN_DRIFT][0];
    const rdPath = path.join(root, "src", "registered-defs", `${id}.yaml`);
    const fxPath = path.join(root, "src", "__fixtures__", `canonical-${id}.yaml`);
    // Before: drifted (it's on the allowlist for exactly this reason).
    expect(structurallyEqual(fs.readFileSync(rdPath, "utf8"), fs.readFileSync(fxPath, "utf8"))).toBe(false);

    writeFixtures(root, [id]);

    // After: structurally identical, and the generated header names the source.
    expect(structurallyEqual(fs.readFileSync(rdPath, "utf8"), fs.readFileSync(fxPath, "utf8"))).toBe(true);
    expect(fs.readFileSync(fxPath, "utf8")).toContain(`GENERATED from src/registered-defs/${id}.yaml`);
  });

  it("AC6: the real script exits 0 at HEAD and 1 on injected drift", () => {
    // Exit 0 at HEAD.
    expect(() => execFileSync("node", [SCRIPT, "--check"], { cwd: REPO_ROOT })).not.toThrow();

    // Exit 1 against a temp root with injected drift on a clean def.
    const root = makeTempRoot();
    const id = cleanDefId(root);
    const p = path.join(root, "src", "registered-defs", `${id}.yaml`);
    const def = yaml.load(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    def.__inf723_injected_drift = true;
    fs.writeFileSync(p, yaml.dump(def));

    let exitCode = 0;
    try {
      execFileSync("node", [SCRIPT, "--check", "--root", root], { stdio: "pipe" });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? -1;
    }
    expect(exitCode).toBe(1);
  });
});
