/**
 * INF-1198 bootstrap/liveness coverage.
 *
 * AC map:
 * - Bootstrap addendum: boot the production entry point (dist/index.js) and
 *   assert stale-session recovery is registered/subscribed from server startup.
 * - Liveness addendum: /health must expose a ticket-specific signal showing the
 *   governed atomic recovery guard is active, without waiting for a stale
 *   session to occur.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const PORT = 4800 + (process.pid % 300);

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-inf-1198",
  openclawAgent: "igor",
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

describe("INF-1198: production bootstrap exposes governed stale recovery liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(`dist/index.js not found at ${DIST_ENTRY} - run npm run build before jest`);
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1198-bootstrap-"));
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
    "/health proves the stale-session recovery handler and governed atomic recovery guard are live",
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

      expect(body.staleSessionRecovery).toEqual(
        expect.objectContaining({
          driverRegistered: true,
          staleSessionHandlerSubscribed: true,
          governedAtomicRecoveryActive: true,
        }),
      );
    },
    60_000,
  );
});
