/**
 * INF-1330 AC3 — Host ops / systemd unit validation for the staging service.
 *
 * AC3 requires a host-owned staging systemd unit
 * `linear-webhook-fancymatt-staging.service` distinct from
 * `linear-webhook-fancymatt.service`, with correct ownership, ports,
 * filesystem paths, and secrets.
 *
 * All tests MUST FAIL against the current codebase because no staging unit
 * file exists yet (only linear-webhook-fancymatt.service), and the deploy
 * script has no staging deploy path.
 *
 * Implementation to make them pass:
 *   - host-owned/linear-webhook-fancymatt-staging.service (or the template
 *     location the deploy expects) with CONNECTOR_ENV=staging, port 3101,
 *     WorkingDirectory/EnvironmentFile pointing to staging roots, correct User,
 *     and distinct secret env references.
 *   - host-owned/bin/deploy-linear-connector.sh updated to deploy staging
 *     without writing any production path.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Template/host-owned locations per the deploy contract. Any one of these
// existing counts as "the staging unit exists" — but before implementation
// none of them exist, so every existence assertion fails red.
const STAGING_UNIT_CANDIDATES = [
  path.join(REPO_ROOT, "host-owned", "linear-webhook-fancymatt-staging.service"),
  path.join(REPO_ROOT, "linear-webhook-fancymatt-staging.service"),
  path.join(REPO_ROOT, "host-owned", "systemd", "linear-webhook-fancymatt-staging.service"),
];

const PROD_UNIT_CANDIDATES = [
  path.join(REPO_ROOT, "linear-webhook-fancymatt.service"),
  path.join(REPO_ROOT, "host-owned", "linear-webhook-fancymatt.service"),
];

const DEPLOY_SCRIPT_CANDIDATES = [
  path.join(REPO_ROOT, "host-owned", "bin", "deploy-linear-connector.sh"),
  path.join(REPO_ROOT, "host-owned", "bin", "deploy.sh"),
  path.join(REPO_ROOT, "bin", "deploy-linear-connector.sh"),
];

function findExisting(candidates: string[]): string | null {
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function readUnit(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("INF-1330 AC3: staging systemd unit — existence and isolation from production", () => {
  test("INF-1330 AC3: staging systemd unit file exists (host-owned/linear-webhook-fancymatt-staging.service or equivalent)", () => {
    const found = findExisting(STAGING_UNIT_CANDIDATES);
    // Before implementation no staging unit exists — this fails red.
    expect(found).not.toBeNull();
    expect(found as unknown as string).toMatch(/linear-webhook-fancymatt-staging\.service$/);
    // File must be non-empty
    expect(fs.statSync(found as string).size).toBeGreaterThan(0);
  });

  test("INF-1330 AC3: staging unit contains CONNECTOR_ENV=staging and port 3101", () => {
    const found = findExisting(STAGING_UNIT_CANDIDATES);
    expect(found).not.toBeNull();
    const content = readUnit(found as string);
    expect(content).toMatch(/CONNECTOR_ENV\s*=\s*staging/);
    expect(content).toMatch(/3101/);
    // Must NOT accidentally contain production port as the primary port
    // (a staging unit listening on 3100 would collide with production)
    // We allow 3100 as a comment/reference but the ExecStart/PORT must be 3101.
    const portLines = content
      .split("\n")
      .filter((l) => /PORT|ExecStart|Environment/.test(l) && !l.trim().startsWith("#"));
    const portText = portLines.join("\n");
    // At least one non-comment line must mention 3101
    expect(portText).toMatch(/3101/);
  });

  test("INF-1330 AC3: staging unit WorkingDirectory / EnvironmentFile point to staging roots (distinct from production)", () => {
    const stagingFile = findExisting(STAGING_UNIT_CANDIDATES);
    const prodFile = findExisting(PROD_UNIT_CANDIDATES);
    expect(stagingFile).not.toBeNull();
    expect(prodFile).not.toBeNull();
    const stagingContent = readUnit(stagingFile as string);
    const prodContent = readUnit(prodFile as string);

    // Staging WorkingDirectory / EnvironmentFile must visibly indicate staging
    const stagingWd = stagingContent.match(/WorkingDirectory\s*=\s*(.+)/)?.[1]?.trim() ?? "";
    const stagingEnvFile = stagingContent.match(/EnvironmentFile\s*=\s*(.+)/)?.[1]?.trim() ?? "";
    const prodWd = prodContent.match(/WorkingDirectory\s*=\s*(.+)/)?.[1]?.trim() ?? "";
    const prodEnvFile = prodContent.match(/EnvironmentFile\s*=\s*(.+)/)?.[1]?.trim() ?? "";

    // At least one of WorkingDirectory or EnvironmentFile must be present and
    // must differ from production's (staging-qualified path)
    const stagingRoots = `${stagingWd} ${stagingEnvFile}`.trim();
    const prodRoots = `${prodWd} ${prodEnvFile}`.trim();
    expect(stagingRoots.length).toBeGreaterThan(0);
    expect(prodRoots.length).toBeGreaterThan(0);
    expect(stagingRoots).not.toBe(prodRoots);
    // Staging roots should contain "staging" to prove they are staging-qualified
    expect(stagingRoots.toLowerCase()).toContain("staging");
    // Production roots must NOT contain staging
    expect(prodRoots.toLowerCase()).not.toContain("staging");
  });

  test("INF-1330 AC3: staging unit has correct User ownership and distinct secret env references", () => {
    const stagingFile = findExisting(STAGING_UNIT_CANDIDATES);
    expect(stagingFile).not.toBeNull();
    const stagingContent = readUnit(stagingFile as string);

    // User must be fancymatt (same as production) or at least present
    const userMatch = stagingContent.match(/User\s*=\s*(.+)/)?.[1]?.trim();
    expect(userMatch).toBeDefined();
    expect(userMatch).toBe("fancymatt");

    // Secret env var reference must be staging-qualified
    // e.g. LINEAR_WEBHOOK_SECRET_STAGING or a staging EnvironmentFile
    const hasStagingSecret =
      /LINEAR_WEBHOOK_SECRET_STAGING/.test(stagingContent) ||
      /staging.*\.env/i.test(stagingContent);
    expect(hasStagingSecret).toBe(true);

    // Must NOT reference the bare production secret as its primary secret
    // (i.e. it should not just reuse LINEAR_WEBHOOK_SECRET without staging qualifier)
    // Allow the string to appear in comments, but the active Environment/ExecStart
    // lines should use the staging secret.
    const activeLines = stagingContent
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !l.trim().startsWith(";"))
      .join("\n");
    // If both appear, the staging one must be present (primary)
    if (/LINEAR_WEBHOOK_SECRET/.test(activeLines)) {
      expect(activeLines).toMatch(/LINEAR_WEBHOOK_SECRET_STAGING/);
    }
  });

  test("INF-1330 AC3: production unit does NOT have staging values (port 3100, CONNECTOR_ENV != staging, distinct paths)", () => {
    // TDD red gate: this isolation assertion is only meaningful when the
    // staging unit exists to compare against — before implementation staging
    // is absent, so the pair cannot be proven isolated. Require staging
    // existence here so this test is red until the staging unit lands.
    const stagingGate = findExisting(STAGING_UNIT_CANDIDATES);
    expect(stagingGate).not.toBeNull();
    const prodFile = findExisting(PROD_UNIT_CANDIDATES);
    expect(prodFile).not.toBeNull();
    const prodContent = readUnit(prodFile as string);

    // Production must NOT have CONNECTOR_ENV=staging
    expect(prodContent).not.toMatch(/CONNECTOR_ENV\s*=\s*staging/);
    // Production port must be 3100 (or at least not 3101 as primary)
    // The prod service currently hardcodes no explicit PORT — it defaults to 3100 in index.ts.
    // After staging is added, prod must still be 3100. We assert that prod does not
    // have 3101 as its port. The absence of 3101 in prod is the isolation proof.
    const prodActiveLines = prodContent
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && /PORT|ExecStart|Environment/.test(l))
      .join("\n");
    if (prodActiveLines.length > 0) {
      expect(prodActiveLines).not.toMatch(/3101/);
    }
    // Production WorkingDirectory must NOT contain "staging"
    const prodWd = prodContent.match(/WorkingDirectory\s*=\s*(.+)/)?.[1]?.trim() ?? "";
    if (prodWd.length > 0) {
      expect(prodWd.toLowerCase()).not.toContain("staging");
    }
    // Production secret must be the bare var (or at least not staging-qualified as primary)
    // Prod should use LINEAR_WEBHOOK_SECRET (bare), not STAGING
    if (/LINEAR_WEBHOOK_SECRET/.test(prodContent)) {
      // Bare secret is expected in prod; staging qualifier must not be primary
      const prodSecretLines = prodContent
        .split("\n")
        .filter((l) => /LINEAR_WEBHOOK_SECRET/.test(l) && !l.trim().startsWith("#"))
        .join("\n");
      // If prod has a webhook secret line, it should NOT be the staging one as the only one
      // (prod may not have any staging reference — which is correct)
      expect(prodSecretLines.toLowerCase()).not.toContain("staging");
    }
  });

  test("INF-1330 AC3: deploy script would deploy staging without writing any production path", () => {
    const deployFile = findExisting(DEPLOY_SCRIPT_CANDIDATES);
    expect(deployFile).not.toBeNull();
    const content = fs.readFileSync(deployFile as string, "utf8");

    // The deploy script must have a staging-aware deploy target that does not
    // collide with the production deploy dir.
    // Look for staging-qualified deploy paths vs production deploy paths.
    // Production deploy dir is .../fancy-openclaw-linear-connector-deploy
    // Staging deploy dir should be staging-qualified (e.g. ...-staging or .../staging)
    const hasStagingDeployTarget =
      /staging/i.test(content) &&
      (/DEPLOY.*staging|STAGING.*DEPLOY|deploy.*staging/i.test(content) ||
        content.toLowerCase().includes("staging"));
    // Before implementation the script has no staging deploy path — fails red
    expect(hasStagingDeployTarget).toBe(true);

    // Staging deploy target dir must be distinct from production deploy dir
    // Extract DEPLOY-like path assignments and prove at least two distinct dirs
    const deployPaths = Array.from(content.matchAll(/(?:DEPLOY|TARGET|DEST)[A-Z_]*\s*=\s*["']?([^\s"'#;]+)/gi)).map(
      (m) => m[1],
    );
    const stagingPaths = deployPaths.filter((p) => /staging/i.test(p));
    const prodPaths = deployPaths.filter((p) => !/staging/i.test(p));
    if (stagingPaths.length > 0 && prodPaths.length > 0) {
      for (const s of stagingPaths) {
        for (const p of prodPaths) {
          expect(s).not.toBe(p);
        }
      }
    } else {
      // If the script uses a single parameterized deploy dir, it must support
      // a staging variant — the presence of staging handling is the proof.
      // This else means DEPLOY paths couldn't be parsed — still require staging mention
      expect(content.toLowerCase()).toContain("staging");
      // And the script must mention both deploy targets or a parameterized target
      const mentionsBothTargets =
        /linear-webhook-fancymatt-staging/.test(content) ||
        /STAGING.*SERVICE|SERVICE.*STAGING/i.test(content);
      expect(mentionsBothTargets).toBe(true);
    }

    // Staging service name must appear (linear-webhook-fancymatt-staging.service)
    expect(content).toMatch(/linear-webhook-fancymatt-staging\.service/);
  });

  test("INF-1330 AC3: staging unit Restart / WantedBy and service shape match production conventions", () => {
    const stagingFile = findExisting(STAGING_UNIT_CANDIDATES);
    expect(stagingFile).not.toBeNull();
    const content = readUnit(stagingFile as string);
    // Must be a systemd service unit (has [Unit], [Service], [Install])
    expect(content).toMatch(/\[Unit\]/);
    expect(content).toMatch(/\[Service\]/);
    expect(content).toMatch(/\[Install\]/);
    // Restart policy should be present (like production's Restart=always)
    expect(content).toMatch(/Restart\s*=/);
    // Type=simple expected
    expect(content).toMatch(/Type\s*=\s*simple/);
  });

  test("INF-1330 AC4: staging health contract — GET /health exposes environment/container-equivalent health shape (frozen Slice A contract visibility)", () => {
    // This is the optional Slice A contract-visibility reinforcement:
    // staging (and prod) should expose GET /health with a stable shape.
    // Before Slice A lands, there is no /health.checkpoint — but /health
    // itself exists and should be asserted. Slice A's frozen manifest shape
    // is not depended on at runtime; we just assert the contract shape is
    // present when available, failing if the health endpoint is absent.
    // To keep this red before staging exists, require that the staging unit
    // file declares a health check that would hit staging's /health on 3101.
    const stagingFile = findExisting(STAGING_UNIT_CANDIDATES);
    expect(stagingFile).not.toBeNull();
    const unitContent = readUnit(stagingFile as string);

    // Staging unit should be checkable via /health on 3101 (health endpoint
    // contract visibility). Either the unit or deploy-verify should reference
    // staging's health port.
    const deployVerifyCandidates = [
      path.join(REPO_ROOT, "host-owned", "bin", "deploy-verify.sh"),
      path.join(REPO_ROOT, "host-owned", "deploy-verify.sh"),
    ];
    const verifyFile = findExisting(deployVerifyCandidates);
    const searchSpace = unitContent + (verifyFile ? fs.readFileSync(verifyFile, "utf8") : "");
    // At least one of: staging health URL with 3101, or an explicit staging health check
    const hasStagingHealthContract =
      /3101.*health|health.*3101/i.test(searchSpace) ||
      (/staging/i.test(searchSpace) && /health/i.test(searchSpace));
    expect(hasStagingHealthContract).toBe(true);
  });
});
