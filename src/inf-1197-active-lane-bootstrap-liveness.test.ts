/**
 * INF-1197 — active-lane auto-enroll bootstrap/liveness proof.
 *
 * AC mapping:
 *   AC6: the active-lane auto-enroll component is registered at server
 *        bootstrap, proven by booting the production entry point (`dist/index.js`).
 *   AC7: liveness is observable at ac-validate without waiting for an Issue
 *        webhook/delegation trigger; `/health.autoEnroll` must show the
 *        plain-delegation active-lane subscription is armed.
 *
 * A module-level unit test is intentionally insufficient here: this covers the
 * AI-1808 dead-code-in-prod class by starting the same built entry point the
 * deployed connector runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const PORT = 4900 + (process.pid % 500);

const sampleAgent = {
  name: "igor",
  linearUserId: "user-igor-inf1197",
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

describe("INF-1197 AC6/AC7: production bootstrap exposes active-lane auto-enroll liveness", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest (CI does this before test)`,
      );
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1197-bootstrap-"));
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
    "AC6/AC7: /health proves plain-delegation active-lane auto-enroll is subscribed at bootstrap",
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

      expect(body.autoEnroll).toBeDefined();
      expect(typeof body.autoEnroll).toBe("object");

      const autoEnroll = body.autoEnroll as Record<string, unknown>;
      expect(autoEnroll.active).toBe(true);

      // INF-1197 is specifically about the plain-delegation active-lane path.
      // Generic autoEnrollByTeam liveness is not enough for AC6/AC7.
      expect(autoEnroll.plainDelegationActiveLane).toEqual(
        expect.objectContaining({
          subscribed: true,
          deprecatedTaskFallback: false,
        }),
      );

      const activeLane = autoEnroll.plainDelegationActiveLane as Record<string, unknown>;
      expect(activeLane.classifiesTo).toEqual(expect.arrayContaining(["wf:chore", "wf:dev-impl"]));
    },
    60_000,
  );
});
