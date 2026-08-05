/**
 * INF-1242 AC3 — `label-sync-divergence` operational events surface at
 * /health.warnings, mirroring the exact existing dispatch-undeliverable
 * pattern (AI-2008, src/index.ts ~line 524-543): query the
 * operationalEventStore for the outcome, project each event into the
 * warnings array.
 *
 * Mirrors src/ai-2008-health-admin-surface.test.ts's pattern (real
 * Express app via createApp() + supertest).
 */
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./index.js";

function tmpDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `inf-1242-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

describe("INF-1242 AC3 — /health surfaces label-sync-divergence warnings", () => {
  let app: ReturnType<typeof createApp>;
  let eventsDbPath: string;

  beforeEach(() => {
    eventsDbPath = tmpDbPath("events");
    app = createApp({
      operationalEventsDbPath: eventsDbPath,
    });
  });

  afterEach(() => {
    (app.operationalEventStore as unknown as { close?: () => void }).close?.();
    fs.rmSync(path.dirname(eventsDbPath), { recursive: true, force: true });
  });

  it("a proxy-vs-label divergence event surfaces in /health warnings", async () => {
    app.operationalEventStore.append({
      outcome: "label-sync-divergence",
      key: "INF-9300",
      sessionKey: "INF-9300",
      detail: {
        ticket: "INF-9300",
        divergenceKind: "proxy-vs-label",
        proxyState: "implementation",
        linearState: "code-review",
        linearStateLabel: "state:code-review",
      },
    });

    const res = await request(app.app).get("/health");
    const warnings: Array<Record<string, unknown>> = res.body.warnings ?? [];
    const found = warnings.find((w) => w.kind === "label-sync-divergence" && w.ticket === "INF-9300");
    expect(found).toBeDefined();
    expect(found?.divergenceKind).toBe("proxy-vs-label");
  });

  it("a label-vs-native divergence event (the INF-1197 shape) surfaces in /health warnings", async () => {
    app.operationalEventStore.append({
      outcome: "label-sync-divergence",
      key: "INF-1197",
      sessionKey: "INF-1197",
      detail: {
        ticket: "INF-1197",
        divergenceKind: "label-native-desync",
        workflowId: "dev-impl",
        stateLabel: "state:intake",
        expectedNativeState: "todo",
        actualNativeStateName: "Doing",
      },
    });

    const res = await request(app.app).get("/health");
    const warnings: Array<Record<string, unknown>> = res.body.warnings ?? [];
    const found = warnings.find((w) => w.kind === "label-sync-divergence" && w.ticket === "INF-1197");
    expect(found).toBeDefined();
    expect(found?.divergenceKind).toBe("label-native-desync");
    const blob = JSON.stringify(found);
    expect(blob).toContain("state:intake");
    expect(blob).toContain("Doing");
  });
});
