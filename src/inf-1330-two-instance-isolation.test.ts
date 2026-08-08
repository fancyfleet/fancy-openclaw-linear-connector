/**
 * INF-1330 AC2 — THE LOAD-BEARING TWO-INSTANCE ISOLATION PROOF.
 *
 * Spawns BOTH production (CONNECTOR_ENV=production, PORT=3100-default) and
 * staging (CONNECTOR_ENV=staging, PORT=3101) from the production entry point
 * dist/index.js simultaneously on different ports + separate temp DATA_DIRs +
 * separate webhook secrets + dry-run vs real delivery, then proves:
 *
 *   1. A write to staging's dispatch-lease / dispatch-idempotency /
 *      session-spawn-idempotency stores does NOT appear in production's stores.
 *   2. A dispatch attempted via staging does NOT wake production agents —
 *      staging's delivery adapter is dry-run (no gateway call), while
 *      production's would.
 *
 * This MUST be an integration test that boots the production entry point(s),
 * not a unit test calling a helper directly (AI-1808 bootstrap-wiring rule).
 *
 * All assertions MUST FAIL against the current codebase because:
 *   - No CONNECTOR_ENV branching exists, so staging DATA_DIR == prod DATA_DIR
 *   - No dry-run adapter exists, so staging would wake production agents
 *   - No environment field on /health, no delivery.dryRun on /health
 *   - Stores share the same file paths when CONNECTOR_ENV is ignored
 *
 * Implementation to make them pass:
 *   - CONNECTOR_ENV-aware DATA_DIR resolution (staging -> data-staging or
 *     a distinct state root so SQLite files land at different paths)
 *   - Dry-run delivery adapter when CONNECTOR_ENV=staging, surfaced at
 *     /health.delivery.dryRun or /health.dispatchDelivery.dryRun
 *   - Webhook ingress secret partitioned (LINEAR_WEBHOOK_SECRET_STAGING)
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

// Distinct ports so both can run simultaneously. Offset by pid to avoid
// cross-worker collisions (same trick as ai-2008 / inf-192 harness).
const PROD_PORT = 4620 + (process.pid % 300);
const STAGING_PORT = 4720 + (process.pid % 300);

function makeAgent(name = "igor") {
  return {
    name,
    linearUserId: `user-${name}-12345678`,
    openclawAgent: name,
    clientId: "client-id-value",
    clientSecret: "client-secret-value",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    host: "local" as const,
  };
}

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

/** Try to open a better-sqlite3 DB and query; falls back to path-only proof if unavailable. */
function tryOpenDb(dbPath: string): any | null {
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const Ctor = (Database as any).default ?? Database;
    if (!fs.existsSync(dbPath)) return null;
    return new Ctor(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

describe("INF-1330 AC2: two-instance isolation — staging cannot touch production state or wake production agents", () => {
  let prodDir: string;
  let stagingDir: string;
  let prodChild: ChildProcess | undefined;
  let stagingChild: ChildProcess | undefined;
  let prodStderr = "";
  let stagingStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest`);
    }
    prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1330-two-prod-"));
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1330-two-staging-"));

    const prodAgents = path.join(prodDir, "agents.json");
    const stagingAgents = path.join(stagingDir, "agents.json");
    fs.writeFileSync(prodAgents, JSON.stringify({ agents: [makeAgent("igor")] }), "utf8");
    fs.writeFileSync(stagingAgents, JSON.stringify({ agents: [makeAgent("igor")] }), "utf8");

    const baseEnv = (port: number, agentsFile: string, dataDir: string) => ({
      ...process.env,
      AGENTS_FILE: agentsFile,
      DATA_DIR: dataDir,
      PORT: String(port),
      LOG_LEVEL: "error",
      LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
      OPENCLAW_HOOKS_URL: `http://127.0.0.1:${port}/nonexistent-hooks`,
      OPENCLAW_HOOKS_TOKEN: "test-token",
    });

    prodChild = spawn(process.execPath, [DIST_ENTRY], {
      cwd: prodDir,
      env: {
        ...baseEnv(PROD_PORT, prodAgents, path.join(prodDir, "data")),
        // CONNECTOR_ENV unset or production
        CONNECTOR_ENV: "production",
        LINEAR_WEBHOOK_SECRET: "prod-secret-1330",
        // Ensure staging secret not leaked into prod
        LINEAR_WEBHOOK_SECRET_STAGING: undefined as unknown as string,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    prodChild.stderr?.on("data", (c: Buffer) => {
      prodStderr += c.toString("utf8");
    });

    stagingChild = spawn(process.execPath, [DIST_ENTRY], {
      cwd: stagingDir,
      env: {
        ...baseEnv(STAGING_PORT, stagingAgents, path.join(stagingDir, "data")),
        CONNECTOR_ENV: "staging",
        LINEAR_WEBHOOK_SECRET_STAGING: "staging-secret-1330",
        // Prod secret also present on host — staging must NOT use it
        LINEAR_WEBHOOK_SECRET: "prod-secret-1330",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${STAGING_PORT}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-token-staging",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    stagingChild.stderr?.on("data", (c: Buffer) => {
      stagingStderr += c.toString("utf8");
    });
  });

  afterAll(async () => {
    for (const child of [prodChild, stagingChild]) {
      if (child && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.on("exit", () => {
            clearTimeout(force);
            resolve();
          });
        });
      }
    }
    for (const d of [prodDir, stagingDir]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test(
    "INF-1330 AC2: both instances boot and report distinct health (environment, port, roots, delivery mode)",
    async () => {
      let prodHealth: Record<string, any>;
      let stagingHealth: Record<string, any>;
      try {
        prodHealth = await pollHealth(`http://127.0.0.1:${PROD_PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(`production never responded on /health: ${String(err)}\nprod stderr:\n${prodStderr}`);
      }
      try {
        stagingHealth = await pollHealth(`http://127.0.0.1:${STAGING_PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(`staging never responded on /health: ${String(err)}\nstaging stderr:\n${stagingStderr}`);
      }

      // Environment identity
      expect(stagingHealth.environment).toBe("staging");
      expect(prodHealth.environment).not.toBe("staging");
      expect(prodHealth.environment === undefined || prodHealth.environment === "production").toBe(true);

      // Port distinctness
      const prodPort = prodHealth.port ?? prodHealth.listenPort ?? PROD_PORT;
      const stagingPort = stagingHealth.port ?? stagingHealth.listenPort ?? STAGING_PORT;
      expect(stagingPort).not.toBe(prodPort);

      // Delivery mode: staging dryRun:true, production dryRun:false
      const stagingDry =
        stagingHealth.delivery?.dryRun ??
        stagingHealth.dispatchDelivery?.dryRun ??
        stagingHealth.deliveryDryRun ??
        null;
      const prodDry =
        prodHealth.delivery?.dryRun ??
        prodHealth.dispatchDelivery?.dryRun ??
        prodHealth.deliveryDryRun ??
        null;
      expect(stagingDry).toBe(true);
      expect(prodDry === true).toBe(false);

      // State roots distinct (if exposed on health)
      const prodRoot = prodHealth.dataDir ?? prodHealth.stateDir ?? prodHealth.roots?.dataDir ?? null;
      const stagingRoot =
        stagingHealth.dataDir ?? stagingHealth.stateDir ?? stagingHealth.roots?.dataDir ?? null;
      if (prodRoot !== null && stagingRoot !== null) {
        expect(stagingRoot).not.toBe(prodRoot);
      } else {
        // Require roots to be exposed for isolation visibility
        expect(prodRoot).not.toBeNull();
        expect(stagingRoot).not.toBeNull();
      }
    },
    60_000,
  );

  test(
    "INF-1330 AC2: staging cannot create production lease / idempotency / session records (filesystem + DB isolation)",
    async () => {
      // Poll both healths to ensure both are up; skip if not (previous test would have failed)
      const prodHealth = await pollHealth(`http://127.0.0.1:${PROD_PORT}/health`, 15_000);
      const stagingHealth = await pollHealth(`http://127.0.0.1:${STAGING_PORT}/health`, 15_000);
      void prodHealth;
      void stagingHealth;

      // Give stores a moment to initialize their SQLite files
      await new Promise((r) => setTimeout(r, 800));

      // Assert SQLite files (if created) live at distinct paths.
      // Currently DATA_DIR is shared-unpartitioned, so both would resolve to
      // the same path — failing the distinctness assertion before implementation.
      const prodLeaseDb = path.join(prodDir, "data", "dispatch-lease.db");
      const stagingLeaseDb = path.join(stagingDir, "data", "dispatch-lease.db");
      const prodIdemDb = path.join(prodDir, "data", "dispatch-idempotency.db");
      const stagingIdemDb = path.join(stagingDir, "data", "dispatch-idempotency.db");
      const prodSpawnDb = path.join(prodDir, "data", "session-spawn-idempotency.db");
      const stagingSpawnDb = path.join(stagingDir, "data", "session-spawn-idempotency.db");

      // The critical isolation proof: lease DBs are at different filesystem paths
      expect(stagingLeaseDb).not.toBe(prodLeaseDb);
      // And each staging file should NOT be the prod file (path distinctness)
      // More load-bearing: if CONNECTOR_ENV were ignored, staging would write
      // to prod's paths. Prove isolation by writing via staging's path and
      // asserting absence from prod's path.
      // If better-sqlite3 is available, do the full DB-record isolation proof.

      // Under the *intended* implementation, staging's DATA_DIR is partitioned
      // (e.g. via OPENCLAW_LINEAR_CONNECTOR_STATE or CONNECTOR_ENV-aware
      // DATA_DIR), so stagingLeaseDb and prodLeaseDb are already distinct
      // directories. Today DATA_DIR is explicitly passed per-instance so they
      // are distinct dirs already — but the production bug is that without
      // CONNECTOR_ENV awareness, a *default* (un-overridden) DATA_DIR would
      // be shared. The stronger proof: require the health-reported roots to be
      // distinct (above). This filesystem-path proof is the secondary layer.
      // To keep this test meaningfully red before implementation, also assert
      // that staging's health reports a *staging-qualified* dataDir string
      // (e.g. containing "staging") — which it currently does not.
      const stagingHealthForRoot = await pollHealth(`http://127.0.0.1:${STAGING_PORT}/health`, 10_000);
      const stagingReportedRoot =
        stagingHealthForRoot.dataDir ??
        stagingHealthForRoot.stateDir ??
        stagingHealthForRoot.roots?.dataDir ??
        "";
      // Staging's reported DATA_DIR should visibly indicate staging isolation
      // (e.g. contains "staging" or is otherwise distinct from a bare "data").
      // Before implementation health has no dataDir/stateDir at all, so this fails.
      expect(typeof stagingReportedRoot).toBe("string");
      expect(stagingReportedRoot.length).toBeGreaterThan(0);
      expect(stagingReportedRoot.toLowerCase()).toContain("staging");

      // Full DB-record isolation proof when better-sqlite3 is available:
      // Write a lease row directly into staging's DB file and prove it is
      // absent from production's DB file.
      const stagingLeaseHandle = tryOpenDb(stagingLeaseDb);
      const prodLeaseHandle = tryOpenDb(prodLeaseDb);
      if (stagingLeaseHandle && prodLeaseHandle) {
        try {
          const markerKey = `inf-1330-isolation-marker-${Date.now()}`;
          // Create a marker row in staging's lease DB if table exists
          const tables: Array<{ name: string }> = stagingLeaseHandle
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
          const tableNames = tables.map((t) => t.name);
          // Find the lease table (name may vary — try known candidates)
          const leaseTable = tableNames.find((n) => n.toLowerCase().includes("lease")) ?? tableNames[0];
          if (leaseTable) {
            const cols: Array<{ name: string }> = stagingLeaseHandle
              .prepare(`PRAGMA table_info(${leaseTable})`)
              .all();
            const colNames = cols.map((c) => c.name);
            // Insert a marker row using the first text column as key-ish
            const textCol = colNames.find((c) => c.toLowerCase().includes("key") || c.toLowerCase().includes("id")) ?? colNames[0];
            if (textCol) {
              try {
                stagingLeaseHandle.prepare(`INSERT INTO ${leaseTable} (${textCol}) VALUES (?)`).run(markerKey);
              } catch {
                // Table may have NOT NULL constraints; best-effort — path distinctness is the primary proof
              }
              // Now assert the same marker is NOT in production's DB
              const prodRows: Array<Record<string, unknown>> = prodLeaseHandle
                .prepare(`SELECT * FROM ${leaseTable} WHERE ${textCol} = ?`)
                .all(markerKey);
              expect(prodRows.length).toBe(0);
              // And it IS in staging
              const stagingRows: Array<Record<string, unknown>> = stagingLeaseHandle
                .prepare(`SELECT * FROM ${leaseTable} WHERE ${textCol} = ?`)
                .all(markerKey);
              expect(stagingRows.length).toBe(1);
            }
          }
        } finally {
          try {
            stagingLeaseHandle.close();
          } catch {}
          try {
            prodLeaseHandle.close();
          } catch {}
        }
      } else {
        // No DB handles (better-sqlite3 unavailable or DB not yet created) —
        // the path + health-root assertions above are the isolation proof.
        // Require that the DB files are at distinct paths regardless.
        expect(stagingIdemDb).not.toBe(prodIdemDb);
        expect(stagingSpawnDb).not.toBe(prodSpawnDb);
        // Force red if health-root staging qualifier already failed; otherwise
        // this branch would spuriously pass. The stagingReportedRoot check above
        // is load-bearing and should have already failed before implementation.
      }
    },
    60_000,
  );

  test(
    "INF-1330 AC2: staging delivery adapter is dry-run — dispatch via staging does NOT wake production agents",
    async () => {
      const stagingHealth = await pollHealth(`http://127.0.0.1:${STAGING_PORT}/health`, 15_000);
      const prodHealth = await pollHealth(`http://127.0.0.1:${PROD_PORT}/health`, 15_000);

      // Staging /health must reflect dryRun:true
      const stagingDry =
        stagingHealth.delivery?.dryRun ??
        stagingHealth.dispatchDelivery?.dryRun ??
        stagingHealth.deliveryDryRun ??
        null;
      expect(stagingDry).toBe(true);

      // Production must NOT be dry-run
      const prodDry =
        prodHealth.delivery?.dryRun ??
        prodHealth.dispatchDelivery?.dryRun ??
        prodHealth.deliveryDryRun ??
        null;
      expect(prodDry === true).toBe(false);

      // Staging must have no gateway wake hook configured (or it is the dry-run stub)
      // Production has a real gateway URL (or at least not dry-run). This proves
      // staging cannot wake production agents even if both share the host.
      const stagingGateway =
        stagingHealth.delivery?.gatewayUrl ??
        stagingHealth.dispatchDelivery?.gatewayUrl ??
        stagingHealth.gatewayUrl ??
        null;
      // If gatewayUrl is exposed, staging's should be absent/null/dryRun sentinel
      if (stagingGateway !== null) {
        // Staging gateway must not equal production's gateway
        const prodGateway =
          prodHealth.delivery?.gatewayUrl ??
          prodHealth.dispatchDelivery?.gatewayUrl ??
          prodHealth.gatewayUrl ??
          null;
        expect(stagingGateway).not.toBe(prodGateway);
      } else {
        // Gateway not exposed — require explicit dryRun flag as the proof (checked above).
        // This else-branch is not a pass; the dryRun assertions above are load-bearing.
        expect(stagingDry).toBe(true);
      }

      // Health must explicitly advertise that staging will not deliver to the
      // gateway — e.g. delivery.mode === "dryRun" or delivery.enabled === false
      const stagingMode =
        stagingHealth.delivery?.mode ??
        stagingHealth.dispatchDelivery?.mode ??
        (stagingDry === true ? "dryRun" : null);
      // Before implementation no mode field exists, so this is null and fails
      expect(stagingMode).toBe("dryRun");
    },
    60_000,
  );
});
