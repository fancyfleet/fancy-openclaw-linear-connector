#!/usr/bin/env node
/**
 * INF-1329 Slice A — generate checkpoint-manifest.json for the built artifact.
 *
 * Runs as the tail of `npm run build` (after tsc + registered-defs copy).
 * Computes live digests from the just-built artifact (dist/), workflow defs,
 * and config, then writes an atomic, versioned manifest to
 * dist/checkpoint-manifest.json.
 *
 * The manifest binds commit + artifactDigest (hash of dist/ contents) +
 * workflowDefinitionsDigest + configFingerprint + secret fingerprints (sha256
 * redacted) + blessedAt/blessedBy. It is the artifact's identity — production
 * bootstrap loads it via loadCheckpointManifest() and serves it at
 * GET /health.checkpoint with live recomputation.
 *
 * Atomic: write to temp file then renameSync — no partial file.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

async function main() {
  // Import the just-built checkpoint module for digest helpers.
  // Dynamic import from dist/ — tsc has already produced dist/checkpoint-manifest.js.
  const modPath = path.join(projectRoot, "dist", "checkpoint-manifest.js");
  if (!fs.existsSync(modPath)) {
    console.error("[checkpoint-manifest] dist/checkpoint-manifest.js not found — did tsc run?");
    process.exit(1);
  }

  const mod = await import(pathToFileURL(modPath).href);

  const live = mod.computeLiveDigests();
  // computeLiveDigests already hashes dist/ (excluding checkpoint-manifest.json itself),
  // workflow defs, and config. That is the live truth — the manifest records it.
  const manifest = mod.createCheckpointManifest({
    commit: live.commit,
    artifactDigest: live.artifactDigest,
    workflowDefinitionsDigest: live.workflowDefinitionsDigest,
    configFingerprint: live.configFingerprint,
  });

  const dest = path.join(projectRoot, "dist", "checkpoint-manifest.json");
  mod.writeCheckpointManifest(dest, manifest);
  console.log(`[checkpoint-manifest] wrote ${dest}`);
  console.log(`  commit=${manifest.commit} artifact=${manifest.artifactDigest.slice(0, 16)}… workflow=${manifest.workflowDefinitionsDigest.slice(0, 16)}… config=${manifest.configFingerprint.slice(0, 16)}…`);
}

main().catch((err) => {
  console.error("[checkpoint-manifest] failed:", err);
  process.exit(1);
});
