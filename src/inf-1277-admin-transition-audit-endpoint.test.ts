/**
 * INF-1277 AC2 — GET /admin/api/transition-audit query endpoint.
 *
 * "Query endpoint — e.g. GET /admin/api/transition-audit?ticket=INF-1263&
 * status=failed&since=… returning recent records, filterable by ticket /
 * status / code / time."
 *
 * Router-level tests (createAdminRouter directly, deps stubbed) mirroring the
 * established pattern for isolated admin-endpoint coverage (see
 * "GET /admin/api/dispatch-acks (AI-2140)" in src/admin.test.ts). The store
 * itself (src/store/transition-audit-store.ts) is covered by
 * src/store/transition-audit-store.test.ts — this file proves the route is
 * wired to it correctly, not the store's storage semantics.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createAdminRouter } from "./admin.js";
import { TransitionAuditStore } from "./store/transition-audit-store.js";

const ADMIN_SECRET = "inf-1277-admin-secret";

describe("GET /admin/api/transition-audit (INF-1277 AC2)", () => {
  let dir: string;
  let store: TransitionAuditStore;
  let app: express.Express;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1277-admin-"));
    store = new TransitionAuditStore(path.join(dir, "transition-audit.db"));

    store.record({
      ticket: "INF-1263", intent: "continue-workflow", fromState: "implementation",
      toState: "code-review", agent: "charles", status: "failed",
      code: "atomic-mutation-failed", detail: "write failed",
      gateResults: [], labelMismatch: false, ts: "2026-08-01T00:00:00.000Z",
    });
    store.record({
      ticket: "INF-1263", intent: "submit", fromState: "implementation",
      toState: "code-review", agent: "charles", status: "applied",
      code: "ok", detail: null,
      gateResults: [], labelMismatch: false, ts: "2026-08-02T00:00:00.000Z",
    });
    store.record({
      ticket: "INF-1264", intent: "accept", fromState: "intake",
      toState: "implementation", agent: "sage", status: "blocked",
      code: "release-gate", detail: "release gate closed",
      gateResults: [], labelMismatch: null, ts: "2026-08-03T00:00:00.000Z",
    });

    app = express();
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    app.use("/admin", createAdminRouter({ transitionAuditStore: store } as any));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_SECRET;
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/admin/api/transition-audit");
    expect(res.status).toBe(401);
  });

  it("returns recent records when no filter is given", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records.length).toBeGreaterThanOrEqual(3);
  });

  it("filters by ticket", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .query({ ticket: "INF-1264" })
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].ticket).toBe("INF-1264");
  });

  it("filters by ticket AND status together (compound filter from the AC's own example)", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .query({ ticket: "INF-1263", status: "failed" })
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].code).toBe("atomic-mutation-failed");
  });

  it("filters by code", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .query({ code: "release-gate" })
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].ticket).toBe("INF-1264");
  });

  it("filters by since/until time range", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .query({ since: "2026-08-01T12:00:00.000Z", until: "2026-08-02T12:00:00.000Z" })
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].intent).toBe("submit");
  });

  it("each returned record includes status, code, and detail as distinct fields", async () => {
    const res = await request(app)
      .get("/admin/api/transition-audit")
      .query({ ticket: "INF-1264" })
      .set("x-admin-secret", ADMIN_SECRET);
    const [record] = res.body.records;
    expect(record.status).toBe("blocked");
    expect(record.code).toBe("release-gate");
    expect(record.detail).toBe("release gate closed");
  });

  it("does not error when the transition-audit store is unavailable — returns an empty list", async () => {
    const bareApp = express();
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    bareApp.use("/admin", createAdminRouter({} as any));
    const res = await request(bareApp)
      .get("/admin/api/transition-audit")
      .set("x-admin-secret", ADMIN_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });
});
