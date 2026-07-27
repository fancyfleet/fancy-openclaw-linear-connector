/**
 * INF-774 — boot-time workflow registry reconciliation.
 *
 * AC mapping:
 *   AC1/AC4: production entrypoint must await in-process reconcile before any
 *     loadWorkflowRegistry cache fill and before listener bind when
 *     WORKFLOW_DEFS_DIR is configured.
 *   AC2: boot reconcile copies bundled canonical registered defs into WDD and
 *     removes stale repo-owned target defs, correcting stale-forward/live-ahead
 *     drift before the registry is served.
 *   AC3: unreadable canonical source, unreadable WDD, or unwritable WDD is a
 *     non-zero boot failure rather than serving fake green.
 *   AC4: runtime Docker image includes canonical registered defs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resetConfigHealth } from "./config-health.js";
import { loadWorkflowRegistry, resetWorkflowCache } from "./workflow-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const REGISTERED_DEFS_DIR = path.join(REPO_ROOT, "src", "registered-defs");

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-12345678",
  openclawAgent: "igor",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

function writeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");
  return agentsFile;
}

function staleForwardDevImplYaml(): string {
  const canonical = yaml.load(fs.readFileSync(path.join(REGISTERED_DEFS_DIR, "dev-impl.yaml"), "utf8")) as Record<string, any>;
  canonical.version = 1;
  canonical.states = [
    {
      id: "intake",
      owner_role: "steward",
      native_state: "thinking",
      transitions: [{ command: "accept", to: "done" }],
    },
    { id: "done", kind: "terminal", native_state: "done" },
  ];
  return yaml.dump(canonical);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function pollHealth(port: number, timeoutMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const json = (await res.json()) as Record<string, any>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

function spawnEntrypoint(
  dir: string,
  wdd: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
): { child: ChildProcess; stderr: () => string } {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(`dist/index.js not found at ${DIST_ENTRY}; run npm run build before jest`);
  }

  let childStderr = "";
  const child = spawn(process.execPath, [DIST_ENTRY], {
    cwd: dir,
    env: {
      ...process.env,
      AGENTS_FILE: writeAgentsFile(dir),
      DATA_DIR: path.join(dir, "data"),
      PORT: String(port),
      LOG_LEVEL: "error",
      LINEAR_WEBHOOK_SECRET: "test-secret",
      LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
      OPENCLAW_HOOKS_URL: `http://127.0.0.1:${port}/nonexistent-hooks`,
      OPENCLAW_HOOKS_TOKEN: "test-token",
      WORKFLOW_DEFS_DIR: wdd,
      ...extraEnv,
      WORKFLOW_DEF_STATE_SNAPSHOT_PATH: path.join(dir, "def-state-snapshot.json"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString("utf8");
  });
  return { child, stderr: () => childStderr };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

describe("INF-774 boot reconcile before registry cache/listener", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  const port = 5100 + (process.pid % 300);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-774-"));
  });

  afterEach(async () => {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(
    "AC1/AC2/AC4: production entrypoint serves canonical registry only after reconciling stale WDD before first load",
    async () => {
      const wdd = path.join(dir, "workflows");
      fs.mkdirSync(wdd, { recursive: true });
      fs.writeFileSync(path.join(wdd, "dev-impl.yaml"), staleForwardDevImplYaml(), "utf8");
      fs.writeFileSync(
        path.join(wdd, "repo-owned-retired.yaml"),
        "id: repo-owned-retired\nversion: 1\nentry_state: done\nstates:\n  - id: done\n    kind: terminal\n    native_state: done\n",
        "utf8",
      );

      const spawned = spawnEntrypoint(dir, wdd, port);
      child = spawned.child;

      let body: Record<string, any>;
      try {
        body = await pollHealth(port, 30_000);
      } catch (err) {
        throw new Error(
          `entrypoint never served /health after boot reconcile: ${err instanceof Error ? err.message : String(err)}\n` +
            `stderr:\n${spawned.stderr()}`,
        );
      }

      const shippedIds = fs
        .readdirSync(REGISTERED_DEFS_DIR)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => path.basename(f, ".yaml"))
        .sort();
      const servedIds = Object.keys(body.workflowRegistry ?? {}).sort();

      expect(servedIds).toEqual(shippedIds);
      expect(servedIds).not.toContain("repo-owned-retired");
      expect(body.workflowRegistry["dev-impl"].version).toBeGreaterThan(1);
      expect(fs.existsSync(path.join(wdd, "repo-owned-retired.yaml"))).toBe(false);
      expect(fs.readFileSync(path.join(wdd, "dev-impl.yaml"), "utf8")).toEqual(
        fs.readFileSync(path.join(REGISTERED_DEFS_DIR, "dev-impl.yaml"), "utf8"),
      );
    },
    60_000,
  );

  test(
    "AC3: canonical registered-def source unreadable is a non-zero boot failure",
    async () => {
      const wdd = path.join(dir, "workflows");
      fs.mkdirSync(wdd, { recursive: true });
      const unusableCanonicalSource = path.join(dir, "canonical-source-file");
      fs.writeFileSync(unusableCanonicalSource, "not a directory", "utf8");

      const spawned = spawnEntrypoint(dir, wdd, port + 3, {
        WORKFLOW_CANONICAL_DEFS_DIR: unusableCanonicalSource,
      });
      child = spawned.child;
      const exitCode = await waitForExit(child, 5_000);

      expect(exitCode).not.toBeNull();
      expect(exitCode).not.toBe(0);
      await expect(pollHealth(port + 3, 750)).rejects.toBeTruthy();
    },
    15_000,
  );

  test(
    "AC3: WDD unreadable/unusable is a non-zero boot failure before listener bind",
    async () => {
      const notDirectory = path.join(dir, "workflow-defs-file");
      fs.writeFileSync(notDirectory, "not a directory", "utf8");

      const spawned = spawnEntrypoint(dir, notDirectory, port + 1);
      child = spawned.child;
      const exitCode = await waitForExit(child, 5_000);

      expect(exitCode).not.toBeNull();
      expect(exitCode).not.toBe(0);
      await expect(pollHealth(port + 1, 750)).rejects.toBeTruthy();
    },
    15_000,
  );

  test(
    "AC3: WDD unwritable is a non-zero boot failure instead of serving fake green",
    async () => {
      const wdd = path.join(dir, "readonly-workflows");
      fs.mkdirSync(wdd, { recursive: true, mode: 0o555 });
      fs.chmodSync(wdd, 0o555);

      const spawned = spawnEntrypoint(dir, wdd, port + 2);
      child = spawned.child;
      const exitCode = await waitForExit(child, 5_000);

      expect(exitCode).not.toBeNull();
      expect(exitCode).not.toBe(0);
      await expect(pollHealth(port + 2, 750)).rejects.toBeTruthy();
    },
    15_000,
  );
});

describe("INF-774 canonical registered-def admission", () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]): void {
    for (const key of keys) savedEnv[key] = process.env[key];
  }

  beforeEach(() => {
    saveEnv("WORKFLOW_DEFS_DIR", "WORKFLOW_DEF_PATH", "WORKFLOW_DEF_STATE_SNAPSHOT_PATH");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-774-admission-"));
    resetWorkflowCache();
    resetConfigHealth();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(savedEnv)) delete savedEnv[key];
    resetWorkflowCache();
    resetConfigHealth();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("canonical registered defs load when prior live snapshot still includes removed escape states", async () => {
    const snapshotPath = path.join(dir, "def-state-snapshot.json");
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        sprint: ["intake", "ux-shaping", "spawning", "managing", "validating", "done", "escape"],
        "sprint-arm-scope": ["doing", "review", "done", "escape"],
      }),
      "utf8",
    );

    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    process.env.WORKFLOW_DEF_STATE_SNAPSHOT_PATH = snapshotPath;
    delete process.env.WORKFLOW_DEF_PATH;

    const registry = await loadWorkflowRegistry();

    expect(registry.has("sprint")).toBe(true);
    expect(registry.has("sprint-arm-scope")).toBe(true);
    const shippedCount = fs.readdirSync(REGISTERED_DEFS_DIR).filter((f) => f.endsWith(".yaml")).length;
    expect(registry.size).toBe(shippedCount);
  });
});

describe("INF-774 runtime packaging", () => {
  test("AC4: Docker runtime stage includes bundled canonical registered defs", () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/COPY\s+--from=builder\s+\/app\/src\/registered-defs\/?\s+dist\/registered-defs\/?/);
  });
});
