/**
 * INF-1277 AC5 — Bootstrap wiring proof (AI-1808, mandatory).
 *
 * The transition-audit persistence write must be reachable from the literal
 * production entry point (`node dist/index.js`), and the query endpoint must
 * be mounted on the production admin router — not merely importable-but-
 * unregistered (the AI-1773/AI-1775 dead-code-in-prod failure mode).
 *
 * This spawns the actual built entry point as a subprocess (same technique as
 * src/ai-2624-bootstrap-wiring.test.ts) and asserts /health reports the
 * transition-audit store as initialized and the admin route as registered —
 * observable without waiting for any transition to occur, per AC5's liveness
 * bullet. The companion file src/inf-1277-transition-audit-integration.test.ts
 * drives real governed transitions through createApp() (the exact function
 * this entry point calls) and proves persistence + query-endpoint retrieval.
 *
 * Requires a fresh `npm run build` before running (CI builds first).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");

const PORT = 4800 + (process.pid % 200);
const ADMIN_SECRET = "inf-1277-bootstrap-secret";

const sampleAgent = {
  name: "astrid",
  linearUserId: "user-astrid-12345678",
  openclawAgent: "astrid",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

async function pollHealth(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error("never attempted");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const json = (await res.json()) as Record<string, unknown>;
      if (json && typeof json === "object") return json;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

describe("INF-1277 AC5: transition-audit store bootstrap wiring + /health liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1277-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgent] }), "utf8");

    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: agentsFile,
        DATA_DIR: path.join(dir, "data"),
        PORT: String(PORT),
        LOG_LEVEL: "error",
        ADMIN_SECRET,
        LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PORT}/nonexistent-hooks`,
        OPENCLAW_HOOKS_TOKEN: "test-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });
  });

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 2000);
        child?.on("exit", () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(
    "the transition-audit store is armed and the query route is registered at the production entry point",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
          `child stderr:\n${childStderr}`,
        );
      }

      // Dead-code guard (AI-1808): if this field is missing, the store/route
      // were never wired at the literal entry point despite passing unit tests.
      //
      // Expected shape (implementer adds this):
      //   transitionAudit: { storeInitialized: true, queryRouteRegistered: true }
      expect(body.transitionAudit).toBeDefined();
      expect(typeof body.transitionAudit).toBe("object");
      const ta = body.transitionAudit as Record<string, unknown>;
      expect(ta.storeInitialized).toBe(true);
      expect(ta.queryRouteRegistered).toBe(true);
    },
    60_000,
  );

  test(
    "GET /admin/api/transition-audit is live and reachable on the production admin router",
    async () => {
      await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);

      const res = await fetch(`http://127.0.0.1:${PORT}/admin/api/transition-audit`, {
        headers: { "x-admin-secret": ADMIN_SECRET },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Array.isArray(body.records)).toBe(true);
    },
    35_000,
  );
});
