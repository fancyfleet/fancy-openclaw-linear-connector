/**
 * INF-1333 Slice E — Bootstrap (AI-1808) + promotion-gate join regressions.
 *
 * TDD-first failing regressions. These MUST be RED against origin/main because
 * the acknowledged-silence lane is not yet wired at bootstrap and the promotion
 * gate does not yet observe stall/silence warnings.
 *
 * AC mapping:
 *   AC bootstrap (AI-1808) — acknowledged-silence components for BOTH lanes
 *     are registered at the production entry point (dist/index.js), observable
 *     at /health without waiting for a stall (mirrors
 *     src/stall-detection-bootstrap-wiring.test.ts, which would PASS for the
 *     generic stall component alone — this test must prove the non-TDD lane
 *     is ALSO wired).
 *   AC gate — stall detection joins the promotion gate; promotion refuses a
 *     bad candidate when acknowledged-silence warnings are present, observable
 *     at /health (or via a helper).
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const PORT_INF1333 = 4817 + (process.pid % 200);

const sampleAgentIGOR = {
  name: "igor",
  linearUserId: "user-igor-inf1333-gate",
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC: Bootstrap registration (AI-1808) — BOTH lanes observable at /health
// ─────────────────────────────────────────────────────────────────────────────

describe("INF-1333 Slice E — AC bootstrap + promotion gate wiring (AI-1808)", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let childStderr = "";

  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` before jest`,
      );
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1333-gate-bootstrap-"));
    const agentsFile = path.join(dir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: [sampleAgentIGOR] }), "utf8");

    child = spawn(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: {
        ...process.env,
        AGENTS_FILE: agentsFile,
        DATA_DIR: path.join(dir, "data"),
        PORT: String(PORT_INF1333),
        LOG_LEVEL: "error",
        LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET ?? "test-secret",
        LINEAR_OAUTH_TOKEN: "test-linear-oauth-token",
        OPENCLAW_HOOKS_URL: `http://127.0.0.1:${PORT_INF1333}/nonexistent-hooks`,
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
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // AC: Bootstrap — acknowledged-silence components for BOTH lanes are registered at production entry point (AI-1808 mandatory)
  it(
    "bootstrap: /health.stallDetection reports active AND both lane detectors are observable (idle-lease + acknowledged-silent) — MUST be RED until non-TDD lane is wired",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT_INF1333}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\nchild stderr:\n${childStderr}`,
        );
      }

      // Generic stallDetection liveness already exists (INF-314) — this alone would PASS without INF-1333.
      expect(body.stallDetection).toBeDefined();
      const sd = body.stallDetection as Record<string, unknown>;
      expect(sd.active).toBe(true);

      // ── RED assertion: both lanes must be observable ──
      // On origin/main, stallDetection has no lane breakdown — only ackTimeoutMs/progressTimeoutMs.
      // Igor must expose the acknowledged-silence lane distinctly so promotion can
      // gate per-lane (per spec §6E). We accept any of these future shapes:
      //   stallDetection.lanes: ["idle-lease", "acknowledged-silence"] (canonical)
      //   stallDetection.acknowledgedSilence: { active: true, ... }
      //   stallDetection.nonTddLane: { active: true }
      //   health.acknowledgedSilence / health.silenceDetection
      const sdLanes = sd.lanes as unknown;
      const sdAckSilence = sd.acknowledgedSilence as unknown;
      const sdAckSilentAlt = (sd as Record<string, unknown>).acknowledgedSilenceActive;
      const sdNonTdd = (sd as Record<string, unknown>).nonTddLane as unknown;
      const topAck = (body as Record<string, unknown>).acknowledgedSilence as unknown;
      const topSilence = (body as Record<string, unknown>).silenceDetection as unknown;

      const hasLaneArray =
        Array.isArray(sdLanes) &&
        sdLanes.length >= 2 &&
        sdLanes.some((v) => String(v).includes("idle") || String(v).includes("1305")) &&
        sdLanes.some(
          (v) =>
            String(v).includes("acknowledged") ||
            String(v).includes("silent") ||
            String(v).includes("1307"),
        );

      const hasAckSilenceBlock =
        !!sdAckSilence &&
        typeof sdAckSilence === "object" &&
        (sdAckSilence as Record<string, unknown>).active === true;

      const hasAltFlag = sdAckSilentAlt === true;
      const hasNonTddLane =
        !!sdNonTdd && typeof sdNonTdd === "object" && (sdNonTdd as Record<string, unknown>).active === true;
      const hasTopLevel =
        (!!topAck && typeof topAck === "object" && (topAck as Record<string, unknown>).active === true) ||
        (!!topSilence && typeof topSilence === "object" && (topSilence as Record<string, unknown>).active === true);

      // At least one lane-distinct signal must be present. On origin/main none are → RED.
      expect(hasLaneArray || hasAckSilenceBlock || hasAltFlag || hasNonTddLane || hasTopLevel).toBe(true);

      // Also assert the cron that drives acknowledged-silence detection is registered.
      // The generic stall-liveness-sweep cron exists, but a lane-distinct cron or
      // lane annotation must also appear. We accept either:
      //   crons includes an acknowledged-silence cron, OR
      //   stallDetection.lanes proves the sweep handles both lanes.
      const crons = body.crons as Array<{ id?: string; name?: string }> | undefined;
      const hasStallCron = Array.isArray(crons) && crons.some((c) => String(c.id ?? c.name ?? "").includes("stall"));
      expect(hasStallCron).toBe(true); // generic gate — passes today

      const hasDistinctCron =
        Array.isArray(crons) &&
        crons.some(
          (c) =>
            String(c.id ?? c.name ?? "").includes("acknowledged") ||
            String(c.id ?? c.name ?? "").includes("silence"),
        );
      // Either a distinct cron exists, or stallDetection.lanes proves the sweep is lane-aware.
      expect(hasDistinctCron || hasLaneArray || hasAckSilenceBlock).toBe(true);
    },
    60_000,
  );

  // AC: Promotion gate join — stall/silence warnings block promotion, observable at /health
  it(
    "promotion gate: /health exposes a checkpoint/promotion gate that observes acknowledged-silence stall and would block a bad candidate — MUST be RED until gate reads stallDetection",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await pollHealth(`http://127.0.0.1:${PORT_INF1333}/health`, 30_000);
      } catch (err) {
        throw new Error(
          `entry point never responded on /health: ${err instanceof Error ? err.message : String(err)}\nchild stderr:\n${childStderr}`,
        );
      }

      // The promotion gate must be observable at /health without waiting for a real stall.
      // Future shape (any one suffices):
      //   health.promotionGate: { blockedByStall: boolean, stalledCount: number, ... }
      //   health.checkpoint: { stallBlocked: boolean, ... }
      //   health.promotion: { blocked: boolean, reason: "stall" }
      // On origin/main, no such field exists → RED.
      const promotionGate = (body as Record<string, unknown>).promotionGate as unknown;
      const checkpoint = (body as Record<string, unknown>).checkpoint as unknown;
      const promotion = (body as Record<string, unknown>).promotion as unknown;
      const gate = promotionGate ?? checkpoint ?? promotion;

      expect(gate).toBeDefined();
      if (gate && typeof gate === "object") {
        const g = gate as Record<string, unknown>;
        // Must surface that stall/silence can block promotion.
        const exposesStall =
          "blockedByStall" in g ||
          "stallBlocked" in g ||
          "blocked" in g ||
          "stalledCount" in g ||
          "silenceBlocked" in g ||
          "acknowledgedSilenceBlocked" in g;
        expect(exposesStall).toBe(true);
      }
    },
    60_000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AC: Promotion gate helper — unit-level (also RED, does not require subprocess)
// ─────────────────────────────────────────────────────────────────────────────

describe("INF-1333 Slice E — AC promotion gate helper (unit-level, also RED)", () => {
  // AC: Joins the promotion gate; blocks INF-1338 — helper like isPromotionBlockedByStall / getPromotionGateHealth must exist
  it("exposes a helper that reports promotion blocked when acknowledged-silence stalledCount > 0 (MUST be RED until Igor wires it)", async () => {
    let helper: unknown = undefined;
    let helperName: string | undefined;
    try {
      const sdStateMod = (await import("./stall-detection-state.js")) as Record<string, unknown>;
      helper =
        sdStateMod.isPromotionBlockedByStall ??
        sdStateMod.getPromotionGateHealth ??
        sdStateMod.getStallPromotionGateHealth ??
        undefined;
      if (helper) helperName = "stall-detection-state";
    } catch {
      helper = undefined;
    }
    if (!helper) {
      try {
        const stallMod = (await import("./stall-detection.js")) as Record<string, unknown>;
        helper =
          stallMod.isPromotionBlockedByStall ??
          stallMod.getPromotionGateHealth ??
          stallMod.isStallBlockingPromotion ??
          undefined;
        if (helper) helperName = "stall-detection";
      } catch {
        helper = undefined;
      }
    }
    if (!helper) {
      try {
        const idxMod = (await import("./index.js")) as Record<string, unknown>;
        helper =
          idxMod.isPromotionBlockedByStall ??
          idxMod.getPromotionGateHealth ??
          undefined;
        if (helper) helperName = "index";
      } catch {
        helper = undefined;
      }
    }

    // Helper must exist — on origin/main it does not → RED.
    expect(helper).toBeDefined();
    expect(typeof helper).toBe("function");
    void helperName;

    // If it exists, it must report blocked when stalledCount > 0.
    if (typeof helper === "function") {
      const blocked = (helper as (arg?: unknown) => unknown)({ stalledCount: 1, stalledTickets: ["linear-INF-1333-X"] });
      const isBlocked =
        blocked === true ||
        (blocked !== null &&
          typeof blocked === "object" &&
          ((blocked as Record<string, unknown>).blocked === true ||
            (blocked as Record<string, unknown>).blockedByStall === true ||
            (blocked as Record<string, unknown>).stallBlocked === true));
      expect(isBlocked).toBe(true);

      const notBlocked = (helper as (arg?: unknown) => unknown)({ stalledCount: 0, stalledTickets: [] });
      const isNotBlocked =
        notBlocked === false ||
        (notBlocked !== null &&
          typeof notBlocked === "object" &&
          ((notBlocked as Record<string, unknown>).blocked === false ||
            (notBlocked as Record<string, unknown>).blockedByStall === false));
      // When nothing is stalled, promotion must NOT be blocked.
      expect(isNotBlocked).toBe(true);
    }
  });
});
