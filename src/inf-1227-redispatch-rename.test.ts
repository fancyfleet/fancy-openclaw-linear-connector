/**
 * INF-1227: Rename steward-state-redispatch.ts — contains no redispatch logic.
 *
 * `steward-state-redispatch.ts` is pure bootstrap liveness registration
 * (`registerStewardStateRedispatch`/`getStewardStateRedispatchLiveness`) with
 * zero redispatch logic. The name misled an incident responder once (INF-1147
 * trail). Scope: rename/relocate the module (or fold its two exports into
 * managing-poller.ts) without changing observable /health behavior.
 *
 * AC mapping:
 *   AC1: No file named `*-redispatch.ts` exists with zero redispatch logic in it.
 *   AC2: /health's liveness surface for this component is unchanged in
 *        shape/behavior — naming/location fix only, not a behavior change.
 *   AC3: Existing tests referencing the old module path/name are updated, not
 *        deleted. Enforced by test-author discipline, not a runtime assertion:
 *        src/inf-1077-stale-steward-review-state.test.ts is left intact — it
 *        exercises the /health surface via HTTP, not the module import path,
 *        so it needs no edits under AC2's unchanged-shape contract.
 *   AC4: The liveness registration is invoked at server bootstrap (reachable
 *        from the production entry point, index.ts), proven by an integration
 *        test that boots the entry point and asserts registration.
 *   AC5: Liveness is observable at ac-validate without waiting for a trigger —
 *        the existing /health entry for this component remains present
 *        immediately after boot, under the new name/location.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetCronRegistryForTest } from "./cron/registry.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = __dirname;

const SECRET = "inf-1227-webhook-secret";
const ADMIN_SECRET = "inf-1227-admin-secret";

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inf-1227-"));
}

function writeAgentsFile(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: "inf-1227-astrid-linear-id",
          openclawAgent: "astrid",
          clientId: "astrid-client",
          clientSecret: "astrid-secret",
          accessToken: "",
          refreshToken: "",
          host: "local",
        },
      ],
    }),
    "utf8",
  );
  return file;
}

function closeApp(app: ReturnType<typeof createApp> | undefined): void {
  app?.bag?.close();
  app?.sessionTracker?.close();
  app?.agentQueue?.close();
  app?.operationalEventStore?.close();
}

describe("INF-1227 AC1 — no *-redispatch.ts file with zero redispatch logic", () => {
  it("has no source file named *-redispatch.ts under src/", () => {
    const offenders = listTsFilesRecursive(SRC_ROOT)
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => /-redispatch\.ts$/.test(path.basename(f)));
    expect(offenders).toEqual([]);
  });

  it("index.ts no longer references the retired steward-state-redispatch module", () => {
    const indexSrc = fs.readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8");
    expect(indexSrc).not.toMatch(/steward-state-redispatch/);
  });
});

describe("INF-1227 AC2/AC4/AC5 — renamed liveness registration still boots and is observable at /health", () => {
  const originalEnv = process.env;
  let dir: string;
  let app: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    dir = tempDir();
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    reloadAgents();
    resetConfigHealth();
    resetCronRegistryForTest();
    resetWorkflowCache();
    app = createApp({
      bagDbPath: path.join(dir, "pending-bag.db"),
      agentQueueDbPath: path.join(dir, "agent-queue.db"),
      operationalEventsDbPath: path.join(dir, "operational-events.db"),
      enrolledTicketsDbPath: path.join(dir, "enrolled-tickets.db"),
      idempotencyDbPath: path.join(dir, "dispatch-idempotency.db"),
    });
  });

  afterEach(() => {
    closeApp(app);
    app = undefined;
    delete process.env.AGENTS_FILE;
    resetWorkflowCache();
    resetConfigHealth();
    resetCronRegistryForTest();
    reloadAgents();
    process.env = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("AC4/AC5: production app boot invokes the renamed registration and exposes it on /health immediately, unchanged shape", async () => {
    const res = await request(app!.app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("stewardStateRedispatch");

    const liveness = res.body.stewardStateRedispatch as Record<string, unknown>;
    // AC2: shape/behavior unchanged — same registered/active/evidence contract
    // as before the rename (see inf-1077-stale-steward-review-state.test.ts).
    expect(liveness).toMatchObject({
      registered: true,
      active: true,
    });
    // AC5: observable immediately after boot — no HTTP request or trigger
    // condition fired yet other than the /health check itself, so a
    // "startup" evidence entry proves registration happened at bootstrap,
    // not lazily on first access.
    expect(liveness.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "startup",
          message: expect.stringContaining("registered at server bootstrap"),
        }),
      ]),
    );
  });
});
