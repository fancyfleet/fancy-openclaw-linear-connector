/**
 * INF-1330 AC1 + AC4 — CONNECTOR_ENV isolation (staging vs production).
 *
 * Slice B requires CONNECTOR_ENV=staging to resolve wholly separate runtime
 * roots, ports, webhook ingress secrets, and a dry-run delivery adapter.
 * No shared state, ingress, or delivery path with production.
 *
 * All tests in this file MUST FAIL against the current codebase because no
 * CONNECTOR_ENV-aware config exists yet (no staging-config module, no
 * CONNECTOR_ENV branching in bootstrap-env/state-dir/index, port hardcoded
 * to 3100, DATA_DIR not env-partitioned, webhook secret var not partitioned,
 * delivery adapter not dry-run aware).
 *
 * Implementation to make them pass (not in this commit):
 *   - src/staging-config.ts or src/connector-env.ts exporting
 *     resolveConnectorConfig(env) / getStagingConfig() helpers
 *   - bootstrap-env.ts / state-dir.ts branching on CONNECTOR_ENV
 *   - src/index.ts PORT default 3101 when CONNECTOR_ENV=staging
 *   - webhook secret env var LINEAR_WEBHOOK_SECRET_STAGING for staging
 *   - delivery adapter dryRun:true when CONNECTOR_ENV=staging, reflected at /health
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname);
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

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

describe("INF-1330 AC1: CONNECTOR_ENV=staging isolated roots, port, secrets, delivery", () => {
  test("INF-1330 AC1: staging config module exists and exports CONNECTOR_ENV-aware resolver", async () => {
    // Expected: src/connector-env.ts or src/staging-config.ts exists and
    // exports a resolver that partitions config by CONNECTOR_ENV.
    // No such file exists yet — this must fail red before implementation.
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const found = candidates.filter((p) => fs.existsSync(p));
    expect(found.length).toBeGreaterThan(0);

    // If a candidate exists, prove it actually partitions config.
    const mod: any = await import(candidates[0].replace(/\.ts$/, ".js"));
    const resolver =
      mod.resolveConnectorConfig ??
      mod.resolveStagingConfig ??
      mod.getConnectorEnvConfig ??
      mod.getStagingConfig ??
      null;
    expect(resolver).toBeDefined();
    expect(typeof resolver).toBe("function");

    const prod = resolver({ CONNECTOR_ENV: "production", PORT: undefined } as any);
    const staging = resolver({ CONNECTOR_ENV: "staging", PORT: undefined } as any);
    // Port must be distinct
    expect(staging.port).toBe(3101);
    expect(prod.port).toBe(3100);
    expect(staging.port).not.toBe(prod.port);
    // DATA_DIR / state roots must be distinct
    expect(staging.dataDir).not.toBe(prod.dataDir);
    expect(staging.stateDir ?? staging.dataDir).not.toBe(prod.stateDir ?? prod.dataDir);
    // Webhook secret env var source must be distinct
    expect(staging.webhookSecretEnvVar).not.toBe(prod.webhookSecretEnvVar);
    // Delivery adapter must be dry-run in staging, not in production
    expect(staging.deliveryDryRun).toBe(true);
    expect(prod.deliveryDryRun).toBe(false);
  });

  test("INF-1330 AC1: CONNECTOR_ENV=staging resolves port 3101 distinct from production port 3100", async () => {
    // Pure resolver check — fails because no resolver exists yet.
    // Implementation would expose resolveConnectorConfig or env-aware PORT default.
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file).toBeDefined();
    const mod: any = await import((file as string).replace(/\.ts$/, ".js"));
    const fn = mod.resolveConnectorConfig ?? mod.getStagingConfig ?? mod.getConnectorEnvConfig;
    expect(fn).toBeDefined();
    const staging = fn({ CONNECTOR_ENV: "staging" } as any);
    const prod = fn({ CONNECTOR_ENV: "production" } as any);
    expect(staging.port).toBe(3101);
    expect(prod.port).toBe(3100);
  });

  test("INF-1330 AC1: CONNECTOR_ENV=staging resolves distinct DATA_DIR / state roots from production", async () => {
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file).toBeDefined();
    const mod: any = await import((file as string).replace(/\.ts$/, ".js"));
    const fn = mod.resolveConnectorConfig ?? mod.getStagingConfig ?? mod.getConnectorEnvConfig;
    expect(fn).toBeDefined();
    const staging = fn({ CONNECTOR_ENV: "staging", OPENCLAW_LINEAR_CONNECTOR_STATE: "/tmp/staging-state" } as any);
    const prod = fn({ CONNECTOR_ENV: "production", OPENCLAW_LINEAR_CONNECTOR_STATE: "/tmp/prod-state" } as any);
    // Even with same base, staging vs prod roots must differ; or at minimum dataDir differs
    const sDir = staging.dataDir ?? staging.stateDir ?? "";
    const pDir = prod.dataDir ?? prod.stateDir ?? "";
    expect(sDir).not.toBe(pDir);
    expect(sDir.length).toBeGreaterThan(0);
    expect(pDir.length).toBeGreaterThan(0);
  });

  test("INF-1330 AC1: CONNECTOR_ENV=staging uses distinct webhook ingress secret env var", async () => {
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file).toBeDefined();
    const mod: any = await import((file as string).replace(/\.ts$/, ".js"));
    const fn = mod.resolveConnectorConfig ?? mod.getStagingConfig ?? mod.getConnectorEnvConfig;
    expect(fn).toBeDefined();
    const staging = fn({ CONNECTOR_ENV: "staging" } as any);
    const prod = fn({ CONNECTOR_ENV: "production" } as any);
    // e.g. LINEAR_WEBHOOK_SECRET_STAGING vs LINEAR_WEBHOOK_SECRET
    expect(staging.webhookSecretEnvVar).toBeDefined();
    expect(prod.webhookSecretEnvVar).toBeDefined();
    expect(staging.webhookSecretEnvVar).not.toBe(prod.webhookSecretEnvVar);
    expect(staging.webhookSecretEnvVar.toLowerCase()).toContain("staging");
  });

  test("INF-1330 AC1: CONNECTOR_ENV=staging delivery adapter is dry-run, production is not", async () => {
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file).toBeDefined();
    const mod: any = await import((file as string).replace(/\.ts$/, ".js"));
    const fn = mod.resolveConnectorConfig ?? mod.getStagingConfig ?? mod.getConnectorEnvConfig;
    expect(fn).toBeDefined();
    const staging = fn({ CONNECTOR_ENV: "staging" } as any);
    const prod = fn({ CONNECTOR_ENV: "production" } as any);
    expect(staging.deliveryDryRun).toBe(true);
    expect(prod.deliveryDryRun).toBe(false);
  });

  test("INF-1330 AC1: no shared state path between staging and production resolved roots", async () => {
    const candidates = [
      path.resolve(SRC_DIR, "connector-env.ts"),
      path.resolve(SRC_DIR, "staging-config.ts"),
      path.resolve(SRC_DIR, "staging-env.ts"),
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    expect(file).toBeDefined();
    const mod: any = await import((file as string).replace(/\.ts$/, ".js"));
    const fn = mod.resolveConnectorConfig ?? mod.getStagingConfig ?? mod.getConnectorEnvConfig;
    expect(fn).toBeDefined();
    const staging = fn({ CONNECTOR_ENV: "staging", DATA_DIR: "/tmp/data-staging" } as any);
    const prod = fn({ CONNECTOR_ENV: "production", DATA_DIR: "/tmp/data-prod" } as any);
    const sData = staging.dataDir ?? "";
    const pData = prod.dataDir ?? "";
    expect(sData).not.toBe(pData);
    // Neither should be empty; both should be absolute or rooted
    expect(sData.length).toBeGreaterThan(0);
    expect(pData.length).toBeGreaterThan(0);
  });
});

describe("INF-1330 AC1: staging health endpoint reports environment=staging and port 3101 distinct from production", () => {
  // Integration-level check: booting dist/index.js with CONNECTOR_ENV=staging
  // should report health.environment === "staging" and port 3101, while
  // production reports environment !== staging and port 3100.
  // Currently src/index.ts hardcodes PORT default 3100 and has no
  // environment field, so this must fail red.
  const PROD_PORT = 4610 + (process.pid % 300);
  const STAGING_PORT = 4710 + (process.pid % 300);

  let prodDir: string;
  let stagingDir: string;
  let prodChild: ChildProcess | undefined;
  let stagingChild: ChildProcess | undefined;
  let prodStderr = "";
  let stagingStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`dist/index.js not found at ${DIST_ENTRY} — run npm run build before jest`);
    }
    prodDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1330-prod-env-"));
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1330-staging-env-"));
    const prodAgents = path.join(prodDir, "agents.json");
    const stagingAgents = path.join(stagingDir, "agents.json");
    fs.writeFileSync(prodAgents, JSON.stringify({ agents: [makeAgent("igor")] }), "utf8");
    fs.writeFileSync(stagingAgents, JSON.stringify({ agents: [makeAgent("igor")] }), "utf8");

    prodChild = spawn(process.execPath, [DIST_ENTRY], {
      cwd: prodDir,
      env: {
        ...process.env,
        AGENTS_FILE: prodAgents,
        DATA_DIR: path.join(prodDir, "data"),
        PORT: String(PROD_PORT),
        // CONNECTOR_ENV unset => production
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: "prod-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PROD_PORT}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    prodChild.stderr?.on("data", (c: Buffer) => {
      prodStderr += c.toString("utf8");
    });

    stagingChild = spawn(process.execPath, [DIST_ENTRY], {
      cwd: stagingDir,
      env: {
        ...process.env,
        AGENTS_FILE: stagingAgents,
        DATA_DIR: path.join(stagingDir, "data"),
        PORT: String(STAGING_PORT),
        CONNECTOR_ENV: "staging",
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET_STAGING: "staging-secret",
        LINEAR_WEBHOOK_SECRET: "prod-secret-should-not-be-used-by-staging",
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${STAGING_PORT}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-token",
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
          }, 2000);
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
    "INF-1330 AC1: staging /health reports environment=staging, port 3101, dryRun:true — distinct from production",
    async () => {
      let prodHealth: Record<string, any>;
      let stagingHealth: Record<string, any>;
      try {
        prodHealth = await pollHealth(`http://127.0.0.1:${PROD_PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `production never responded on /health: ${String(err)}\nprod stderr:\n${prodStderr}`,
        );
      }
      try {
        stagingHealth = await pollHealth(`http://127.0.0.1:${STAGING_PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `staging never responded on /health: ${String(err)}\nstaging stderr:\n${stagingStderr}`,
        );
      }

      // Staging must self-identify as staging
      expect(stagingHealth.environment).toBe("staging");
      // Production must NOT be staging
      expect(prodHealth.environment).not.toBe("staging");

      // Staging port must be 3101-equivalent (here STAGING_PORT, but the
      // contract is that when PORT is not overridden, default is 3101; when
      // explicitly set, health reflects that port). So at minimum they differ.
      // We assert the logical default: stagingHealth.port === 3101 when
      // CONNECTOR_ENV=staging and PORT not set. With explicit PORT, we assert
      // distinctness and that staging exposes environment.
      // The load-bearing assertion: ports are distinct and staging is staging.
      const prodPort = prodHealth.port ?? prodHealth.listenPort ?? PROD_PORT;
      const stagingPort = stagingHealth.port ?? stagingHealth.listenPort ?? STAGING_PORT;
      expect(stagingPort).not.toBe(prodPort);

      // Delivery dry-run: staging must be dryRun:true, prod dryRun:false/undefined
      // Either at top-level delivery or dispatchDelivery
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

      // State roots distinct as reported by health
      const prodRoot = prodHealth.dataDir ?? prodHealth.stateDir ?? prodHealth.roots?.dataDir ?? null;
      const stagingRoot =
        stagingHealth.dataDir ?? stagingHealth.stateDir ?? stagingHealth.roots?.dataDir ?? null;
      if (prodRoot !== null && stagingRoot !== null) {
        expect(stagingRoot).not.toBe(prodRoot);
      } else {
        // If health doesn't expose roots, the spawn used distinct DATA_DIRs;
        // the existence of this branch failing still proves red — require roots
        // to be exposed for proper isolation visibility.
        expect(prodRoot).not.toBeNull();
        expect(stagingRoot).not.toBeNull();
      }
    },
    60_000,
  );
});
