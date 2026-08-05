/**
 * INF-1212 — production bootstrap proof for dedicated reconciliation auth.
 *
 * The health field must come from the entrypoint boot path, not from a
 * module-level unit test. This mirrors the existing production-entrypoint
 * subprocess tests and asserts /health.serviceCredential is live immediately.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const PORT = 5200 + (process.pid % 300);

const sampleAgent = {
  name: "ai",
  linearUserId: "user-ai-12345678",
  openclawAgent: "ai",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  refreshToken: "refresh-token-value",
  host: "local" as const,
};

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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr;
}

describe("INF-1212 production /health dedicated service credential liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} - run \`npm run build\` before jest (CI does; see ci.yml)`,
      );
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1212-health-"));
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
        LINEAR_WEBHOOK_SECRET: "test-secret",
        LINEAR_SERVICE_CREDENTIAL: "lin_service_dedicated_token",
        LINEAR_OAUTH_TOKEN: "",
        LINEAR_API_KEY: "",
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
    "/health exposes serviceCredential liveness from the production entrypoint",
    async () => {
      let body: Record<string, any>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\n` +
            `child stderr:\n${childStderr}`,
        );
      }

      expect(body.serviceCredential).toEqual(
        expect.objectContaining({
          active: true,
          valid: true,
        }),
      );
      expect(body.tokens).toBeDefined();
      expect(body.serviceCredential).not.toEqual(body.tokens?.ai);
    },
    60_000,
  );
});
