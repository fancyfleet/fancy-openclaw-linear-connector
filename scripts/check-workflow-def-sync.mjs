#!/usr/bin/env node
/**
 * INF-723 — Workflow-def sync gate (registered-defs ⇄ __fixtures__).
 *
 * The connector's workflow-def registry can silently diverge across three
 * artifacts, in both directions, per-field, without a version bump:
 *
 *   1. WORKFLOW_DEFS_DIR  — live, what the runtime loads (host-only, not in repo)
 *   2. src/registered-defs/*.yaml         — the in-repo deploy source of truth
 *   3. src/__fixtures__/canonical-*.yaml  — what /health.fixtureDrift validates against
 *
 * This gate closes the *in-repo* half of that gap: it makes 2 and 3 unable to
 * disagree at the same commit. registered-defs is the single source; each
 * canonical-<id>.yaml fixture is a generated mirror of registered-defs/<id>.yaml.
 * The fixture-drift detector (src/fixture-drift-detector.ts) compares the LIVE
 * def against the fixture, so keeping the fixture pinned to registered-defs makes
 * "live drifted from what we shipped" the ONLY thing that detector can report —
 * instead of also silently absorbing repo-internal skew.
 *
 * Comparison mirrors the detector exactly: structural equality of the YAML-parsed
 * object trees (JSON.stringify, order-sensitive — the detector round-trips through
 * yaml.dump which preserves key order). Header comments / version-history lines are
 * non-semantic and ignored (yaml.load strips them).
 *
 * ── Ratchet ──────────────────────────────────────────────────────────────────
 * A hard fail-close on ALL drift today would brick CI: reconciling the currently
 * divergent defs is per-def judgement work, deferred to separate tickets (INF-723
 * item 4). So the gate is a ratchet: it fail-closes on drift for every def EXCEPT
 * the shrinking KNOWN_DRIFT allowlist. New drift on any other def fails immediately;
 * each reconciliation ticket removes its def from KNOWN_DRIFT. When an allowlisted
 * def comes back into sync, the gate fails and tells you to tighten the ratchet, so
 * the list can only shrink.
 *
 * Usage:
 *   node scripts/check-workflow-def-sync.mjs [--check]        # verify (CI); exit 1 on violation
 *   node scripts/check-workflow-def-sync.mjs --write [id...]  # (re)generate fixtures from registered-defs
 *   node scripts/check-workflow-def-sync.mjs --root <dir>     # operate on an alternate repo root (tests)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// ── Ratchet state ────────────────────────────────────────────────────────────

/**
 * Defs whose registered-defs/*.yaml and __fixtures__/canonical-*.yaml are KNOWN
 * to diverge in-repo as of INF-723. Each entry is tracked to a reconciliation
 * ticket (INF-723 item 4). Reconcile → remove the entry → the ratchet tightens.
 * The gate fail-closes on drift for every def NOT listed here.
 */
export const KNOWN_DRIFT = new Set([
  "dev-impl",        // fixture carries a top-level `recovery_actor` absent from registered-defs
  "dev-sprint",      // fixture stale at v8; registered-defs at v11
  "sprint",          // break_glass + states diverge at the same version (v1)
  "sprint-arm-scope", // break_glass + states diverge at the same version (v1)
  "task",            // states diverge at the same version (v2); live is v3 (backport pending)
]);

/**
 * canonical-*.yaml fixtures that intentionally have NO registered-defs sibling
 * (engine/test fixtures, not deployable workflow defs). Any OTHER orphan
 * canonical fixture fails the gate — a canonical fixture without a def is drift.
 */
export const NON_DEF_CANONICAL_FIXTURES = new Set([
  "terminal-barrier",
]);

// ── Path helpers ─────────────────────────────────────────────────────────────

export function registeredDefsDir(root) {
  return path.join(root, "src", "registered-defs");
}
export function fixturesDir(root) {
  return path.join(root, "src", "__fixtures__");
}
export function fixturePathFor(root, id) {
  return path.join(fixturesDir(root), `canonical-${id}.yaml`);
}
export function registeredDefPathFor(root, id) {
  return path.join(registeredDefsDir(root), `${id}.yaml`);
}

/** All registered-def ids (basename without .yaml), sorted. */
export function registeredDefIds(root) {
  return fs
    .readdirSync(registeredDefsDir(root))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

/** All canonical-<id> fixture ids present in __fixtures__, sorted. */
export function canonicalFixtureIds(root) {
  return fs
    .readdirSync(fixturesDir(root))
    .filter((f) => f.startsWith("canonical-") && f.endsWith(".yaml"))
    .map((f) => f.replace(/^canonical-/, "").replace(/\.yaml$/, ""))
    .sort();
}

/**
 * Structural equality between a registered-def and its fixture, matching the
 * fixture-drift detector's comparison (parsed-tree JSON.stringify, order-sensitive).
 */
export function structurallyEqual(rdContent, fxContent) {
  return JSON.stringify(yaml.load(rdContent)) === JSON.stringify(yaml.load(fxContent));
}

// ── Core check ───────────────────────────────────────────────────────────────

/**
 * Evaluate the ratchet over a repo root. Pure (no I/O side effects beyond reads,
 * no process.exit) so the jest test can assert on the structured result.
 * Returns { ok, violations: string[], notices: string[] }.
 */
export function checkWorkflowDefSync(root) {
  const violations = [];
  const notices = [];

  const defIds = registeredDefIds(root);
  const defIdSet = new Set(defIds);

  for (const id of defIds) {
    const fxPath = fixturePathFor(root, id);
    if (!fs.existsSync(fxPath)) {
      violations.push(`${id}: registered-def has no canonical fixture (${path.relative(root, fxPath)})`);
      continue;
    }
    const rdContent = fs.readFileSync(registeredDefPathFor(root, id), "utf8");
    const fxContent = fs.readFileSync(fxPath, "utf8");
    const inSync = structurallyEqual(rdContent, fxContent);

    if (inSync) {
      if (KNOWN_DRIFT.has(id)) {
        violations.push(
          `${id}: now IN SYNC but still on the KNOWN_DRIFT allowlist — reconciled; ` +
            `remove "${id}" from KNOWN_DRIFT in scripts/check-workflow-def-sync.mjs to tighten the ratchet.`,
        );
      }
      continue;
    }

    // drifted
    if (KNOWN_DRIFT.has(id)) {
      notices.push(`${id}: known in-repo drift (tracked, INF-723 item 4) — registered-defs ⇄ fixture differ`);
    } else {
      violations.push(
        `${id}: registered-defs/${id}.yaml and __fixtures__/canonical-${id}.yaml diverge structurally. ` +
          `Regenerate the fixture from the registered-def: ` +
          `node scripts/check-workflow-def-sync.mjs --write ${id}`,
      );
    }
  }

  // Orphan canonical fixtures: a canonical-<id>.yaml with no registered-def and
  // not on the intentional non-def allowlist.
  for (const id of canonicalFixtureIds(root)) {
    if (defIdSet.has(id)) continue;
    if (NON_DEF_CANONICAL_FIXTURES.has(id)) continue;
    violations.push(
      `${id}: __fixtures__/canonical-${id}.yaml has no src/registered-defs/${id}.yaml sibling. ` +
        `Either add the registered-def or, if this is an intentional non-def fixture, ` +
        `add "${id}" to NON_DEF_CANONICAL_FIXTURES.`,
    );
  }

  return { ok: violations.length === 0, violations, notices };
}

/**
 * The single generation step: (re)write canonical-<id>.yaml as a mirror of
 * registered-defs/<id>.yaml, so the two repo artifacts cannot disagree.
 * Preserves a generated header pointing back at the source. Returns written ids.
 */
export function writeFixtures(root, ids) {
  const targets = ids && ids.length ? ids : registeredDefIds(root);
  const written = [];
  for (const id of targets) {
    const rdPath = registeredDefPathFor(root, id);
    if (!fs.existsSync(rdPath)) {
      throw new Error(`cannot generate fixture for "${id}": no registered-def at ${rdPath}`);
    }
    const rdContent = fs.readFileSync(rdPath, "utf8");
    const header =
      `# GENERATED from src/registered-defs/${id}.yaml — do not hand-edit.\n` +
      `# Regenerate: node scripts/check-workflow-def-sync.mjs --write ${id}\n` +
      `# The canonical fixture is a mirror of the registered-def (INF-723 single-source rule).\n`;
    // Strip any leading comment block from the source so the generated header is authoritative,
    // then re-emit the semantic YAML unchanged.
    const semantic = rdContent.replace(/^(?:#[^\n]*\n)*/, "");
    fs.writeFileSync(fixturePathFor(root, id), header + semantic);
    written.push(id);
  }
  return written;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: "check", root: process.cwd(), ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--write") args.mode = "write";
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (!a.startsWith("-")) args.ids.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "help") {
    console.log(
      [
        "check-workflow-def-sync — registered-defs ⇄ __fixtures__ ratchet (INF-723)",
        "",
        "  --check            verify sync (default); exit 1 on any violation",
        "  --write [id...]    (re)generate canonical fixtures from registered-defs",
        "  --root <dir>       operate on an alternate repo root",
      ].join("\n"),
    );
    return;
  }

  if (args.mode === "write") {
    const written = writeFixtures(args.root, args.ids);
    for (const id of written) console.log(`[workflow-def-sync] wrote __fixtures__/canonical-${id}.yaml`);
    console.log(`[workflow-def-sync] regenerated ${written.length} fixture(s) from registered-defs`);
    return;
  }

  const { ok, violations, notices } = checkWorkflowDefSync(args.root);
  for (const n of notices) console.log(`[workflow-def-sync] notice: ${n}`);
  if (!ok) {
    console.error(`[workflow-def-sync] ✗ ${violations.length} sync violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(
    `[workflow-def-sync] ✓ registered-defs ⇄ fixtures in sync ` +
      `(${notices.length} known-drift def(s) allowlisted, tracked to INF-723 item 4)`,
  );
}

// Run only when invoked directly, not when imported by the test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
