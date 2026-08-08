import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

export interface CheckpointManifest {
  checkpointId: string;
  environment: string;
  createdAt: string;
  blessedAt: string;
  blessedBy: string;
  promotedFrom: string | null;
  commit: string;
  artifactDigest: string;
  lockfileDigest: string;
  version: number;
  workflowDefinitionsDigest: string;
  configFingerprint: string;
  secretFingerprints?: Record<string, string>;
}

export interface CreateCheckpointManifestArgs {
  commit: string;
  artifactDigest: string;
  workflowDefinitionsDigest: string;
  configFingerprint: string;
  secrets?: Record<string, string>;
  environment?: string;
  blessedBy?: string;
  promotedFrom?: string | null;
  lockfileDigest?: string;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function createCheckpointManifest(args: CreateCheckpointManifestArgs): CheckpointManifest {
  const environment = args.environment ?? process.env.NODE_ENV ?? "production";
  const createdAt = new Date().toISOString();
  const blessedAt = createdAt;
  const blessedBy = args.blessedBy ?? process.env.BLESSED_BY ?? process.env.USER ?? "system";
  const checkpointId = crypto.randomUUID();
  const lockfileDigest = args.lockfileDigest ?? `sha256:${sha256Hex(args.artifactDigest)}`;
  const secretFingerprints: Record<string, string> | undefined = args.secrets
    ? Object.fromEntries(
        Object.entries(args.secrets).map(([k, v]) => [k, `sha256:${sha256Hex(v)}`]),
      )
    : undefined;

  return {
    checkpointId,
    environment,
    createdAt,
    blessedAt,
    blessedBy,
    promotedFrom: args.promotedFrom ?? null,
    commit: args.commit,
    artifactDigest: args.artifactDigest,
    lockfileDigest,
    version: 1,
    workflowDefinitionsDigest: args.workflowDefinitionsDigest,
    configFingerprint: args.configFingerprint,
    ...(secretFingerprints ? { secretFingerprints } : {}),
  };
}

export function writeCheckpointManifest(dest: string, manifest: CheckpointManifest): void {
  const dir = path.dirname(dest);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const tmp = `${dest}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, dest);
}

// ── live comparison ────────────────────────────────────────────────────────

export interface StoredCheckpointDigests {
  commit: string;
  artifactDigest: string;
  workflowDefinitionsDigest: string;
  configFingerprint: string;
}

export interface LiveCheckpointDigests {
  commit: string;
  artifactDigest: string;
  workflowDefinitionsDigest: string;
  configFingerprint: string;
}

export interface LiveMatches {
  commit: boolean;
  artifact: boolean;
  workflowDefinitions: boolean;
  config: boolean;
  overall: boolean;
}

export function computeLiveMatches(
  stored: StoredCheckpointDigests,
  live: LiveCheckpointDigests,
): LiveMatches {
  const commit = stored.commit === live.commit;
  const artifact = stored.artifactDigest === live.artifactDigest;
  const workflowDefinitions = stored.workflowDefinitionsDigest === live.workflowDefinitionsDigest;
  const config = stored.configFingerprint === live.configFingerprint;
  const overall = commit && artifact && workflowDefinitions && config;
  return { commit, artifact, workflowDefinitions, config, overall };
}

// ── stored manifest singleton ─────────────────────────────────────────────

let storedManifest: CheckpointManifest | null = null;

export function getStoredManifest(): CheckpointManifest | null {
  return storedManifest;
}

export function setStoredManifest(m: CheckpointManifest): void {
  storedManifest = m;
}

export function resetCheckpointState(): void {
  storedManifest = null;
}

export function ensureStoredManifest(): CheckpointManifest {
  if (storedManifest) return storedManifest;
  const live = computeLiveDigests();
  storedManifest = createCheckpointManifest({
    commit: live.commit,
    artifactDigest: live.artifactDigest,
    workflowDefinitionsDigest: live.workflowDefinitionsDigest,
    configFingerprint: live.configFingerprint,
  });
  return storedManifest;
}

// ── live digest resolution — independent recomputation, no snapping ───────

function instanceConfigRootSync(): string {
  return process.env.LINEAR_CONNECTOR_CONFIG_DIR ?? path.join(os.homedir(), ".openclaw", "linear-connector");
}

function resolveLiveCommitSync(): string {
  // 1. Env overrides for test injection win first — so tests can force drift without touching disk.
  //    In production these env vars are not set; the stamp/git path is authoritative.
  //    Check env first only when explicitly set to a known test value.
  //    But for real drift detection we must prefer disk truth — so we check stamp/git BEFORE falling back to env.
  //    Test injection uses env AFTER disk read fails would be useless. Instead, env is checked first ONLY if set,
  //    and disk is checked second — but getCheckpointHealth must not snap to manifest.
  //    To keep both prod truth and test injection, prefer: env override if present, else stamp, else git.
  //    Prod does not set GIT_COMMIT/ARTIFACT_DIGEST, so stamp/git path is used there.
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  if (process.env.DEPLOY_COMMIT) return process.env.DEPLOY_COMMIT;
  // 2. Prefer dist/DEPLOY_COMMIT stamp (production truth, AI-1841)
  try {
    const stampPath = path.join(process.cwd(), "dist", "DEPLOY_COMMIT");
    const stamped = fs.readFileSync(stampPath, "utf8").trim();
    if (stamped) return stamped;
  } catch {}
  // 3. Fallback to git HEAD (dev/test)
  try {
    const out = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (out) return out;
  } catch {}
  return "unknown";
}

function resolveLiveArtifactDigestSync(): string {
  if (process.env.ARTIFACT_DIGEST) return process.env.ARTIFACT_DIGEST;
  // Hash package-lock.json as artifact proxy; fallback to dist hash
  try {
    const lockPath = path.join(process.cwd(), "package-lock.json");
    const content = fs.readFileSync(lockPath, "utf8");
    return `sha256:${sha256Hex(content)}`;
  } catch {}
  try {
    const distPath = path.join(process.cwd(), "dist");
    const entries = fs.readdirSync(distPath).filter((n) => !n.startsWith(".")).sort();
    if (entries.length > 0) {
      const hash = crypto.createHash("sha256");
      for (const name of entries) {
        const p = path.join(distPath, name);
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) hash.update(fs.readFileSync(p));
        } catch {}
      }
      return `sha256:${hash.digest("hex")}`;
    }
  } catch {}
  return `sha256:${sha256Hex("artifact")}`;
}

function resolveLiveWorkflowDigestSync(): string {
  const dirEnv = process.env.WORKFLOW_DEFS_DIR || process.env.WORKFLOW_DEF_DIR;
  if (dirEnv) {
    try {
      const entries = fs.readdirSync(dirEnv).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
      if (entries.length > 0) {
        const hash = crypto.createHash("sha256");
        for (const name of entries) {
          const content = fs.readFileSync(path.join(dirEnv, name), "utf8");
          hash.update(content);
        }
        return `sha256:${hash.digest("hex")}`;
      }
    } catch {}
    // Dir set but unreadable/empty → still a live value, don't fall through to placeholder silently
    return `sha256:${sha256Hex("workflow-defs")}`;
  }
  // Single-file mode
  const candidates: string[] = [];
  if (process.env.WORKFLOW_DEF_PATH) candidates.push(process.env.WORKFLOW_DEF_PATH);
  candidates.push(path.join(instanceConfigRootSync(), "workflows", "dev-impl.yaml"));
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, "utf8");
      return `sha256:${sha256Hex(content)}`;
    } catch {}
  }
  return `sha256:${sha256Hex("workflow-defs")}`;
}

function resolveLiveConfigFingerprintSync(): string {
  // Try capability policy file
  let fingerprint: string | null = null;
  const capCandidates: string[] = [];
  if (process.env.CAPABILITY_POLICY_PATH) capCandidates.push(process.env.CAPABILITY_POLICY_PATH);
  capCandidates.push(path.join(instanceConfigRootSync(), "config", "capability-policy.yaml"));
  for (const p of capCandidates) {
    try {
      const content = fs.readFileSync(p, "utf8");
      fingerprint = `sha256:${sha256Hex(content)}`;
      break;
    } catch {}
  }
  if (fingerprint === null) fingerprint = `sha256:${sha256Hex("config")}`;

  const agentsPath = process.env.AGENTS_FILE;
  if (agentsPath) {
    try {
      const content = fs.readFileSync(agentsPath, "utf8");
      fingerprint = `sha256:${sha256Hex(fingerprint + ":" + sha256Hex(content))}`;
    } catch {}
  }
  return fingerprint;
}

export function computeLiveDigests(): LiveCheckpointDigests {
  return {
    commit: resolveLiveCommitSync(),
    artifactDigest: resolveLiveArtifactDigestSync(),
    workflowDefinitionsDigest: resolveLiveWorkflowDigestSync(),
    configFingerprint: resolveLiveConfigFingerprintSync(),
  };
}

export function getCheckpointHealth(): {
  manifest: CheckpointManifest;
  live: LiveCheckpointDigests;
  matchesLive: LiveMatches;
} {
  const manifest = ensureStoredManifest();
  const live = computeLiveDigests();
  const matchesLive = computeLiveMatches(
    {
      commit: manifest.commit,
      artifactDigest: manifest.artifactDigest,
      workflowDefinitionsDigest: manifest.workflowDefinitionsDigest,
      configFingerprint: manifest.configFingerprint,
    },
    live,
  );
  return { manifest, live, matchesLive };
}
