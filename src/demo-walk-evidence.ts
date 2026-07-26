/**
 * LIF-263 — Live demonstration-walk evidence gate.
 *
 * Background: the dev-impl `deploy → ac-validate` edge is the final outcome
 * gate. INF-359 added a `requires_demonstration_walk` check, but it only
 * inspects the ticket *description* for a self-attested marker
 * (`<!-- demonstration-walk: passed -->`). That is not evidence — anyone can
 * type "passed". The ac-validate steward (Astrid) runs container-isolated and
 * cannot reach the loopback-only LifeOS app (`127.0.0.1:8100`), so it
 * structurally cannot produce a live walk itself.
 *
 * Option 1 (agreed on LIF-263): the deploy role — which runs on the host with
 * loopback + gen.fcy.sh reachability — executes the walk via the `run_demo_walk`
 * wrapper (LIF-264) and attaches the captured bundle to the ticket. This module
 * is the connector's *checker*: it verifies that a real, passing, recent
 * demonstration-walk artifact is attached before the ticket may leave `deploy`.
 * The gate checks finished evidence; it never generates it (that is exactly the
 * Option-2 inversion — a validator with a host-exec bridge — we rejected).
 *
 * Evidence contract (produced by run_demo_walk.sh, LIF-264):
 *   A JSON bundle attached to the ticket via `linear upload --comment`, whose
 *   body carries the uploads.linear.app asset URL. The bundle contains at least:
 *     { artifact_kind: "demonstration-walk", exit_code: <int>, passed: <bool>,
 *       sha: <string>, base_url: <string>, timestamp: <iso> }
 *   exit_code 0 (and passed !== false) is a pass. Anything else fails loudly.
 *
 * Freshness: strict image-SHA pinning is deferred to LIF-266 (the lifeos-app
 * image carries no baked SHA today). Until then we bound obvious staleness with
 * a recency window (default 24h = the ac-validate SLA) so a passing walk from a
 * prior implementation cycle cannot silently re-satisfy the gate. This residual
 * window is documented, not silent.
 */

import { componentLogger, createLogger } from "./logger.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "demo-walk-evidence");

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Cap on how large an attached asset we will download+parse as a bundle. */
const MAX_BUNDLE_BYTES = 512 * 1024;

/** Default recency window for a passing walk to count as fresh. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UPLOADS_URL_RE = /https:\/\/uploads\.linear\.app\/[^\s)"'<>]+/gi;

export interface DemoWalkMarker {
  /** True when this ticket opts into the live-walk gate. */
  required: boolean;
  /** Repo-relative walk script path from `Demo-walk-script:`, if present. */
  scriptPath?: string;
  /** True when `Demo-walk-required: true` explicitly mandates a walk. */
  explicitRequire: boolean;
}

/**
 * Parse the opt-in markers from a ticket description.
 *
 * The gate is per-ticket opt-in: not every dev-impl ticket needs a live walk
 * (library bumps, pure-logic fixes). A ticket whose ACs require a walk names its
 * script with `Demo-walk-script: <repo-relative-path>`. `Demo-walk-required:
 * true` forces the gate even when no script is named — which then fails loudly,
 * implementing the contract's "ACs require a walk but no marker → never a silent
 * pass" clause deterministically (no fuzzy AC parsing).
 */
export function parseDemoWalkMarker(description: string | null | undefined): DemoWalkMarker {
  if (!description) return { required: false, explicitRequire: false };
  const scriptMatch = /^\s*Demo-walk-script:\s*(\S+)\s*$/im.exec(description);
  const explicitRequire = /^\s*Demo-walk-required:\s*true\s*$/im.test(description);
  const scriptPath = scriptMatch?.[1];
  return {
    required: Boolean(scriptPath) || explicitRequire,
    scriptPath,
    explicitRequire,
  };
}

export interface DemoWalkBundle {
  artifact_kind?: string;
  exit_code?: number;
  passed?: boolean;
  sha?: string;
  base_url?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/** A candidate artifact: a parsed bundle plus when it was attached. */
export interface DemoWalkCandidate {
  bundle: DemoWalkBundle;
  /** ISO timestamp the evidence was attached (comment createdAt). */
  attachedAt: string;
  url: string;
}

export interface DemoWalkEvidenceResult {
  ok: boolean;
  reason?: string;
  exitCode?: number;
  sha?: string;
  attachedAt?: string;
  artifactUrl?: string;
}

/** Is a parsed bundle a *passing* demonstration-walk artifact? */
export function isPassingDemoWalkBundle(bundle: DemoWalkBundle | null | undefined): boolean {
  if (!bundle) return false;
  if (bundle.artifact_kind !== "demonstration-walk") return false;
  // A pass requires exit 0 AND not an explicit passed:false (defensive: a walk
  // may exit 0 yet self-report failure).
  return bundle.exit_code === 0 && bundle.passed !== false;
}

/**
 * Pure selection: given candidate artifacts, choose the newest *passing* one and
 * decide whether it is fresh enough. `nowMs`/`maxAgeMs` are injected for testing.
 */
export function selectDemoWalkEvidence(
  candidates: DemoWalkCandidate[],
  nowMs: number,
  maxAgeMs: number,
): DemoWalkEvidenceResult {
  const passing = candidates
    .filter((c) => isPassingDemoWalkBundle(c.bundle))
    .sort((a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt));

  if (passing.length === 0) {
    // Distinguish "a walk ran and FAILED" from "no walk artifact at all" — the
    // former is a loud failure the deploy role must act on; the latter means the
    // walk was never run.
    const anyDemoWalk = candidates.some((c) => c.bundle.artifact_kind === "demonstration-walk");
    if (anyDemoWalk) {
      const newest = candidates
        .filter((c) => c.bundle.artifact_kind === "demonstration-walk")
        .sort((a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt))[0];
      return {
        ok: false,
        reason: `the latest demonstration-walk artifact FAILED (exit_code=${newest.bundle.exit_code ?? "?"}, passed=${String(newest.bundle.passed)}). Fix the implementation and re-run the walk`,
        exitCode: newest.bundle.exit_code,
        sha: newest.bundle.sha,
        attachedAt: newest.attachedAt,
        artifactUrl: newest.url,
      };
    }
    return {
      ok: false,
      reason: "no demonstration-walk artifact is attached. The deploy role must run `run_demo_walk <ticket> <script>` on the host (against 127.0.0.1:8100) and attach the passing bundle before advancing",
    };
  }

  const newest = passing[0];
  const ageMs = nowMs - Date.parse(newest.attachedAt);
  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: `the newest passing demonstration-walk artifact is stale (attached ${Math.round(ageMs / 3_600_000)}h ago, older than the ${Math.round(maxAgeMs / 3_600_000)}h freshness window). Re-run the walk against the current deploy`,
      exitCode: newest.bundle.exit_code,
      sha: newest.bundle.sha,
      attachedAt: newest.attachedAt,
      artifactUrl: newest.url,
    };
  }

  return {
    ok: true,
    exitCode: newest.bundle.exit_code,
    sha: newest.bundle.sha,
    attachedAt: newest.attachedAt,
    artifactUrl: newest.url,
  };
}

/** Injectable asset fetcher (real impl downloads from uploads.linear.app). */
export type AssetFetcher = (url: string, authToken: string) => Promise<DemoWalkBundle | null>;

/** Default asset fetcher: download the uploads.linear.app JSON with the real token. */
export const fetchAssetBundle: AssetFetcher = async (url, authToken) => {
  try {
    const res = await fetch(url, {
      headers: { Authorization: authToken },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn(`demo-walk-evidence: asset fetch returned ${res.status} for ${url}`);
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BUNDLE_BYTES) {
      return null; // not a small JSON bundle — skip (likely an image/PDF)
    }
    // Only attempt JSON; the wrapper attaches a .json bundle.
    if (contentType && !/json|text\/plain|octet-stream/i.test(contentType)) {
      return null;
    }
    const text = await res.text();
    if (text.length > MAX_BUNDLE_BYTES) return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return null;
    return JSON.parse(trimmed) as DemoWalkBundle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`demo-walk-evidence: asset fetch/parse failed for ${url}: ${msg}`);
    return null;
  }
};

interface CommentNode {
  body?: string | null;
  createdAt?: string | null;
}

/** Fetch ticket comments, extract uploads.linear.app URLs and download bundles. */
async function fetchDemoWalkCandidates(
  issueId: string,
  authToken: string,
  assetFetcher: AssetFetcher,
): Promise<{ candidates: DemoWalkCandidate[]; fetchFailed: boolean }> {
  const query = `
    query DemoWalkComments($id: String!) {
      issue(id: $id) {
        comments(first: 50) { nodes { body createdAt } }
      }
    }
  `;
  let comments: CommentNode[];
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify({ query, variables: { id: issueId } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      data?: { issue?: { comments?: { nodes: CommentNode[] } } };
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      log.warn(`demo-walk-evidence: comment query errors for ${issueId}: ${data.errors.map((e) => e.message).join("; ")}`);
      return { candidates: [], fetchFailed: true };
    }
    comments = data.data?.issue?.comments?.nodes ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`demo-walk-evidence: comment fetch failed for ${issueId}: ${msg}`);
    return { candidates: [], fetchFailed: true };
  }

  // Collect (url, attachedAt) pairs; a comment body may contain multiple URLs.
  const refs: Array<{ url: string; attachedAt: string }> = [];
  for (const c of comments) {
    if (!c.body || !c.createdAt) continue;
    const matches = c.body.match(UPLOADS_URL_RE);
    if (!matches) continue;
    for (const url of matches) refs.push({ url, attachedAt: c.createdAt });
  }

  const candidates: DemoWalkCandidate[] = [];
  // Newest comments first — most likely to hold the current evidence.
  refs.sort((a, b) => Date.parse(b.attachedAt) - Date.parse(a.attachedAt));
  for (const ref of refs) {
    const bundle = await assetFetcher(ref.url, authToken);
    if (bundle && bundle.artifact_kind === "demonstration-walk") {
      candidates.push({ bundle, attachedAt: ref.attachedAt, url: ref.url });
    }
  }
  return { candidates, fetchFailed: false };
}

export interface VerifyDemoWalkOptions {
  issueId: string;
  authToken: string;
  /** Injectable for tests; defaults to real Linear comment + asset fetch. */
  fetchCandidates?: (
    issueId: string,
    authToken: string,
  ) => Promise<{ candidates: DemoWalkCandidate[]; fetchFailed: boolean }>;
  nowMs?: number;
  maxAgeMs?: number;
}

/**
 * Verify a passing, fresh demonstration-walk artifact is attached to the ticket.
 * Read-failure fails CLOSED — an unreadable evidence set is not "no evidence"
 * and must not silently pass a deploy gate (consistent with the other v8 gates).
 */
export async function verifyDemoWalkEvidence(opts: VerifyDemoWalkOptions): Promise<DemoWalkEvidenceResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs =
    opts.maxAgeMs ??
    (process.env.DEMO_WALK_MAX_AGE_MS ? parseInt(process.env.DEMO_WALK_MAX_AGE_MS, 10) : DEFAULT_MAX_AGE_MS);

  const fetchImpl =
    opts.fetchCandidates ?? ((id: string, token: string) => fetchDemoWalkCandidates(id, token, fetchAssetBundle));

  const { candidates, fetchFailed } = await fetchImpl(opts.issueId, opts.authToken);
  if (fetchFailed) {
    return {
      ok: false,
      reason: "unable to read the ticket's comments to verify demonstration-walk evidence. Retry once Linear is readable, or use break-glass if a steward intentionally needs to override",
    };
  }
  return selectDemoWalkEvidence(candidates, nowMs, maxAgeMs);
}
