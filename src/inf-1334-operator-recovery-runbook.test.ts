/**
 * INF-1334 — Slice F: Operator recovery runbook + freeze checklist
 *
 * Failing tests (RED) — runbook does not yet exist.
 * Covers all AC verbatim; each describe/it maps 1:1 to an AC.
 *
 * AC1 — runbook + freeze checklist authored against EXISTING health/admin/deploy
 *       surfaces, no UI dependency.
 * AC2 — checklist answers all five operator questions.
 * AC3 — runbook references frozen contracts A/C/D/E by contract terms.
 * AC4 — declared-standalone: e2e proof carried by INF-1335–INF-1338, not here.
 * NEG — does not invent a new UI surface as a required dependency.
 */

import fs from "node:fs";
import path from "node:path";

// ── Runbook location candidates ───────────────────────────────────────────
// Primary: docs/operator-recovery-runbook.md
// Acceptable alternates (checked as fallback, but primary preferred):
//   docs/runbook.md, docs/recovery-runbook.md, docs/operator-runbook.md

const REPO_ROOT = process.cwd();

const CANDIDATE_PATHS = [
  path.join(REPO_ROOT, "docs/operator-recovery-runbook.md"),
  path.join(REPO_ROOT, "docs/runbook.md"),
  path.join(REPO_ROOT, "docs/recovery-runbook.md"),
  path.join(REPO_ROOT, "docs/operator-runbook.md"),
] as const;

const PRIMARY_PATH = CANDIDATE_PATHS[0];

/** Return the first existing candidate, or the primary path if none exist (so existence check fails clearly). */
function resolveRunbookPath(): string {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return PRIMARY_PATH;
}

function readRunbook(): string {
  const p = resolveRunbookPath();
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

function runbookExists(): boolean {
  return CANDIDATE_PATHS.some((p) => fs.existsSync(p));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("INF-1334: Slice F — Operator recovery runbook", () => {
  // ── AC1 ────────────────────────────────────────────────────────────────
  describe("AC1: runbook + freeze checklist authored against existing surfaces, no UI dependency", () => {
    it("INF-1334 AC1 — runbook file exists at canonical path (docs/operator-recovery-runbook.md preferred)", () => {
      const exists = runbookExists();
      expect(exists).toBe(true);
      if (!fs.existsSync(PRIMARY_PATH)) {
        expect(fs.existsSync(PRIMARY_PATH)).toBe(true);
      }
    });

    it("INF-1334 AC1 — runbook has non-trivial length (not stub/empty)", () => {
      const content = readRunbook();
      expect(content.length).toBeGreaterThan(800);
      expect(content.split("\n").length).toBeGreaterThan(30);
    });

    it("INF-1334 AC1 — references existing health surface: GET /health", () => {
      const content = readRunbook();
      expect(content).toMatch(/GET\s+\/health\b/i);
    });

    it("INF-1334 AC1 — references existing manifest surface: checkpoint-manifest or GET /health.checkpoint", () => {
      const content = readRunbook();
      const hasManifest =
        /checkpoint-manifest/i.test(content) || /\/health\.checkpoint/i.test(content);
      expect(hasManifest).toBe(true);
    });

    it("INF-1334 AC1 — references existing admin surface", () => {
      const content = readRunbook();
      expect(content).toMatch(/admin/i);
    });

    it("INF-1334 AC1 — references existing deploy surface (promote/rollback/deploy scripts)", () => {
      const content = readRunbook();
      const hasDeploySurface =
        /scripts\/promote/i.test(content) ||
        /scripts\/rollback/i.test(content) ||
        /\bpromote\b/i.test(content) ||
        /\brollback\b/i.test(content) ||
        /\bdeploy\b/i.test(content);
      expect(hasDeploySurface).toBe(true);
    });

    it("INF-1334 AC1 — explicitly states no UI dependency / no custom UI required", () => {
      const content = readRunbook();
      const declaresNoUI =
        /no\s+(custom\s+)?UI\s+(dependency|required)/i.test(content) ||
        /no\s+UI\s+dependency/i.test(content) ||
        /without\s+(a\s+)?(custom\s+)?UI/i.test(content) ||
        /existing\s+(health|admin|deploy)\s+surfaces/i.test(content);
      expect(declaresNoUI).toBe(true);
    });
  });

  // ── AC2 ────────────────────────────────────────────────────────────────
  describe("AC2: checklist answers all five operator questions", () => {
    it("INF-1334 AC2 Q1 — checklist answers: what production runs", () => {
      const content = readRunbook();
      expect(content).toMatch(/what production runs|what\s+is\s+running\s+in\s+production|production\s+runs/i);
    });

    it("INF-1334 AC2 Q2 — checklist answers: what staging runs", () => {
      const content = readRunbook();
      expect(content).toMatch(/what staging runs|what\s+is\s+running\s+in\s+staging|staging\s+runs/i);
    });

    it("INF-1334 AC2 Q3 — checklist answers: what is blessed", () => {
      const content = readRunbook();
      expect(content).toMatch(/what is blessed|blessed\s+(checkpoint|manifest|build)/i);
    });

    it("INF-1334 AC2 Q4 — checklist answers: whether rollback is available", () => {
      const content = readRunbook();
      expect(content).toMatch(/whether rollback is available|rollback.*available|rollback\s+available/i);
    });

    it("INF-1334 AC2 Q5 — checklist answers: whether dispatch/wake health has recovered", () => {
      const content = readRunbook();
      expect(content).toMatch(/whether dispatch\/wake health has recovered|dispatch.*wake.*health|wake.*health.*recover/i);
    });

    it("INF-1334 AC2 — checklist contains all five answers distinctly (aggregate guard)", () => {
      const content = readRunbook();
      const patterns: RegExp[] = [
        /what production runs|production\s+runs/i,
        /what staging runs|staging\s+runs/i,
        /what is blessed|blessed/i,
        /whether rollback is available|rollback.*available/i,
        /dispatch\/wake|dispatch.*wake|wake.*health/i,
      ];
      const hits = patterns.filter((re) => re.test(content)).length;
      expect(hits).toBe(5);
    });
  });

  // ── AC3 ────────────────────────────────────────────────────────────────
  describe("AC3: runbook references frozen deliverable contracts A/C/D/E", () => {
    it("INF-1334 AC3 Slice A — references manifest contract: checkpoint-manifest.json + matchesLive / GET /health.checkpoint", () => {
      const content = readRunbook();
      const hasCheckpointFile = /checkpoint-manifest\.json/i.test(content);
      const hasMatchesLive = /matchesLive/i.test(content);
      const hasHealthCheckpoint = /GET\s+\/health\.checkpoint|\/health\.checkpoint/i.test(content);
      expect(hasCheckpointFile).toBe(true);
      expect(hasMatchesLive || hasHealthCheckpoint).toBe(true);
    });

    it("INF-1334 AC3 Slice C — references promotion gate contract: promote --from staging --checkpoint <id> + fail-closed gate", () => {
      const content = readRunbook();
      const hasPromoteCmd =
        /promote\s+--from\s+staging\s+--checkpoint/i.test(content) ||
        /promote\s+--from\s+staging/i.test(content);
      expect(hasPromoteCmd).toBe(true);
      const hasFailClosed =
        /fail-closed/i.test(content) || /promotion gate/i.test(content) || /gate.*refus/i.test(content);
      expect(hasFailClosed).toBe(true);
    });

    it("INF-1334 AC3 Slice D — references named rollback contract: rollback --checkpoint <id> + retained checkpoint / restore artifact + defs", () => {
      const content = readRunbook();
      const hasRollbackCmd = /rollback\s+--checkpoint/i.test(content);
      expect(hasRollbackCmd).toBe(true);
      const hasRollbackDetail =
        /retained checkpoint/i.test(content) ||
        /restore.*artifact/i.test(content) ||
        /workflow definitions/i.test(content) ||
        /verify.*identity|exact live identity/i.test(content);
      expect(hasRollbackDetail).toBe(true);
    });

    it("INF-1334 AC3 Slice E — references acknowledged-silence detection contract (both TDD and non-TDD lanes)", () => {
      const content = readRunbook();
      const hasSilence =
        /acknowledged-silence/i.test(content) || /acknowledged silence/i.test(content) || /silence detection/i.test(content);
      expect(hasSilence).toBe(true);
      const hasBothLanes =
        (/TDD/i.test(content) && /non-TDD/i.test(content)) ||
        (/INF-1305/i.test(content) && /INF-1307/i.test(content));
      expect(hasBothLanes).toBe(true);
    });

    it("INF-1334 AC3 Slice E — notes C6/bootstrap/model/delivery failures do not count as owner activity", () => {
      const content = readRunbook();
      const hasExclusion =
        /C6/i.test(content) ||
        /bootstrap.*not.*owner activity/i.test(content) ||
        /(model|delivery).*not.*owner activity/i.test(content) ||
        /never count as.*owner activity/i.test(content) ||
        /do not count as.*productive owner activity/i.test(content);
      // Accept any explicit mention of the negative guard; at minimum require C6 or the exclusion phrasing
      expect(hasExclusion).toBe(true);
    });

    it("INF-1334 AC3 — references all four frozen contracts distinctly (aggregate guard)", () => {
      const content = readRunbook();
      const hasA = /checkpoint-manifest/i.test(content) || /health\.checkpoint/i.test(content);
      const hasC = /promote\s+--from\s+staging/i.test(content);
      const hasD = /rollback\s+--checkpoint/i.test(content);
      const hasE = /acknowledged.silence/i.test(content);
      const hits = [hasA, hasC, hasD, hasE].filter(Boolean).length;
      expect(hits).toBe(4);
    });
  });

  // ── AC4 ────────────────────────────────────────────────────────────────
  describe("AC4: declared-standalone — e2e proof carried by integration-verify children, not this slice", () => {
    it("INF-1334 AC4 — runbook declares standalone classification or states e2e proof is not owned here", () => {
      const content = readRunbook();
      const hasStandalone =
        /declared-standalone/i.test(content) ||
        /standalone/i.test(content) ||
        /not.*owned here/i.test(content) ||
        /not by this slice/i.test(content);
      expect(hasStandalone).toBe(true);
    });

    it("INF-1334 AC4 — runbook references integration-verify children INF-1335–INF-1338 as owners of e2e proof", () => {
      const content = readRunbook();
      const hasChildren =
        /INF-1335/i.test(content) ||
        /INF-1336/i.test(content) ||
        /INF-1337/i.test(content) ||
        /INF-1338/i.test(content) ||
        /integration-verify/i.test(content);
      expect(hasChildren).toBe(true);
    });

    it("INF-1334 AC4 — runbook does not claim to be the end-to-end release-evidence proof itself", () => {
      const content = readRunbook();
      // If it claims standalone correctly, it should not present itself as the e2e proof.
      // We assert that the file contains a caveat that e2e proof is elsewhere, not that this doc proves release evidence end-to-end.
      const hasCaveat =
        /integration-verify/i.test(content) ||
        /declared-standalone/i.test(content) ||
        /per-capability integration/i.test(content) ||
        /not.*end-to-end/i.test(content);
      expect(hasCaveat).toBe(true);
    });
  });

  // ── NEG ────────────────────────────────────────────────────────────────
  describe("NEG: does not invent a new UI surface as a required dependency", () => {
    it("INF-1334 NEG — runbook does not require a custom Helm UI / new dashboard as a prerequisite", () => {
      const content = readRunbook();
      // Should not claim a new UI is required. If it mentions UI, it must be in a "no UI" context.
      const requiresCustomUI =
        /requires.*custom.*UI/i.test(content) ||
        /must.*deploy.*UI/i.test(content) ||
        /Helm control-center UI.*required/i.test(content) ||
        /new dashboard.*required/i.test(content);
      expect(requiresCustomUI).toBe(false);
      // And it should positively state surfaces are existing
      const affirmsExisting =
        /existing.*surfaces/i.test(content) ||
        /no.*UI\s+dependency/i.test(content) ||
        /no custom UI/i.test(content);
      expect(affirmsExisting).toBe(true);
    });
  });
});
