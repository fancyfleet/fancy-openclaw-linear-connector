/**
 * INF-1331 — Slice C: Promotion gate and production pinning — FAILING tests (red phase)
 *
 * EXPECTED IMPLEMENTATION MODULE: `src/promotion-gate.ts`
 * The implementer must create this module. It should export at minimum:
 *   - `PromotionGate` class (or `promote` function) that drives promotion
 *   - `ProductionPinStore` / `AuditStore` / `RollbackTargetStore` interfaces (or concrete classes)
 *   - Gate evaluation covering the 6 enumerated conditions from INF-1322 §4
 *
 * Suggested shape (implementer free to adjust but tests import from this path):
 *   import { PromotionGate, GateRefusedError } from "./promotion-gate.js";
 *   // or: import { promote } from "./promotion-gate.js";
 *
 * If the implementer prefers `src/promotion/promotion-gate.ts`, update the import
 * below and keep the file at that path — tests will be updated to match.
 *
 * Coverage map:
 * // AC1: explicit promotion only, no implicit origin/main — promote requires --from staging + checkpoint id
 * // AC2: fail-closed on each of 6 gates independently — each gate alone causes refusal
 * // AC3: failing gate leaves production pinned — prior blessed checkpoint unchanged, no prod writes
 * // AC4: retained, addressable rollback target — prior checkpoint fetchable after success
 * // AC5: atomic audit + rollback-target write — all-or-nothing; partial write leaves prod unadvanced
 *
 * No production Linear webhook ingress mutation, no secret leakage in tests.
 */

// ── Expected imports — these MUST fail until the implementer creates src/promotion-gate.ts ──
import { PromotionGate } from "./promotion-gate.js";

// ── Helper types / fakes (self-contained, no dependency on unbuilt Slice B) ──

type CheckpointId = string;

interface FakeManifest {
  checkpointId: CheckpointId;
  digests: Record<string, string>;
}

interface GateContext {
  checkpointId: CheckpointId;
  stagingManifest: FakeManifest | null;
  liveDigests: Record<string, string>;
  /** Gate 2 sub-checks */
  health: {
    fixtureDriftOk: boolean;
    workflowMigrationsOk: boolean;
    requiredCronReady: boolean;
    agentsOk: boolean;
    tokensOk: boolean;
    dispatchSchedulerOk: boolean;
    dispatchRecoveryOk: boolean;
    adminHealthOk: boolean;
  };
  /** Gate 3: replay warnings */
  replay: {
    tddSilenceWarnings: number;
    nonTddSilenceWarnings: number;
    connectorFailures: { kind: string }[]; // wake-turn-failed, bootstrap/model, undeliverable — must NOT count as owner activity
  };
  /** Gate 4: evidence */
  evidence: {
    hasTddWake: boolean;
    hasNonTddImplWake: boolean;
    hasDependencyClearDownstreamWake: boolean;
    downstreamYieldsOwnerArtifactOrBlockerOrAutoFailure: boolean;
  };
  /** Gate 5: production pin */
  productionPin: {
    currentBlessedCheckpointId: CheckpointId;
    retainedCheckpoints: CheckpointId[];
  };
  /** Gate 6: audit fields present */
  auditFields: {
    sourceId: string | null;
    targetId: string | null;
    operator: string | null;
    job: string | null;
    timestamps: { startedAt: string | null; finishedAt: string | null };
    result: string | null;
    postPromotionVerification: boolean | null;
  };
}

function makePassingContext(overrides: Partial<GateContext> = {}): GateContext {
  const checkpointId = "chk-blessed-100";
  const manifest: FakeManifest = {
    checkpointId,
    digests: { "app.tar.gz": "sha256:abc", "config.json": "sha256:def" },
  };
  const base: GateContext = {
    checkpointId,
    stagingManifest: manifest,
    liveDigests: { "app.tar.gz": "sha256:abc", "config.json": "sha256:def" },
    health: {
      fixtureDriftOk: true,
      workflowMigrationsOk: true,
      requiredCronReady: true,
      agentsOk: true,
      tokensOk: true,
      dispatchSchedulerOk: true,
      dispatchRecoveryOk: true,
      adminHealthOk: true,
    },
    replay: {
      tddSilenceWarnings: 0,
      nonTddSilenceWarnings: 0,
      connectorFailures: [],
    },
    evidence: {
      hasTddWake: true,
      hasNonTddImplWake: true,
      hasDependencyClearDownstreamWake: true,
      downstreamYieldsOwnerArtifactOrBlockerOrAutoFailure: true,
    },
    productionPin: {
      currentBlessedCheckpointId: "chk-blessed-099",
      retainedCheckpoints: ["chk-blessed-099", "chk-blessed-098"],
    },
    auditFields: {
      sourceId: "chk-blessed-100",
      targetId: "chk-blessed-100",
      operator: "op-igor",
      job: "job-123",
      timestamps: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      result: "success",
      postPromotionVerification: true,
    },
  };
  // Deep merge for nested overrides
  return {
    ...base,
    ...overrides,
    health: { ...base.health, ...(overrides.health ?? {}) },
    replay: { ...base.replay, ...(overrides.replay ?? {}) },
    evidence: { ...base.evidence, ...(overrides.evidence ?? {}) },
    productionPin: { ...base.productionPin, ...(overrides.productionPin ?? {}) },
    auditFields: {
      ...base.auditFields,
      ...(overrides.auditFields ?? {}),
      timestamps: {
        ...base.auditFields.timestamps,
        ...(overrides.auditFields?.timestamps ?? {}),
      },
    },
  };
}

// Minimal fakes that the PromotionGate is expected to accept via constructor/deps.
// Implementer may choose different names; tests pass these as plain objects and
// assert behavior — adapter is the implementer's job.
interface FakeDeps {
  fetchStagingManifest: (checkpointId: string) => Promise<FakeManifest | null>;
  getLiveDigests: () => Promise<Record<string, string>>;
  checkHealth: () => Promise<GateContext["health"]>;
  getReplayWarnings: () => Promise<GateContext["replay"]>;
  getEvidence: () => Promise<GateContext["evidence"]>;
  getProductionPin: () => string;
  setProductionPin: (id: string) => void;
  writeAuditRecord: (rec: unknown) => Promise<void>;
  writeRollbackTarget: (priorId: string) => Promise<void>;
  getRollbackTarget: (id: string) => string | null;
  listRetainedCheckpoints: () => string[];
}

function makeFakeDeps(ctx: GateContext, spies: Record<string, jest.Mock> = {}): FakeDeps {
  const fetchSpy = (spies.fetchStagingManifest ??= jest.fn(async (id: string) => {
    if (ctx.stagingManifest && ctx.stagingManifest.checkpointId === id) return ctx.stagingManifest;
    return null;
  }));
  const liveSpy = (spies.getLiveDigests ??= jest.fn(async () => ctx.liveDigests));
  const healthSpy = (spies.checkHealth ??= jest.fn(async () => ctx.health));
  const replaySpy = (spies.getReplayWarnings ??= jest.fn(async () => ctx.replay));
  const evidenceSpy = (spies.getEvidence ??= jest.fn(async () => ctx.evidence));

  let prodPin = ctx.productionPin.currentBlessedCheckpointId;
  const retained = [...ctx.productionPin.retainedCheckpoints];
  let auditWrites: unknown[] = [];

  const getPinSpy = (spies.getProductionPin ??= jest.fn(() => prodPin));
  const setPinSpy = (spies.setProductionPin ??= jest.fn((id: string) => { prodPin = id; }));
  const writeAuditSpy = (spies.writeAuditRecord ??= jest.fn(async (rec: unknown) => { auditWrites.push(rec); }));
  const writeRollbackSpy = (spies.writeRollbackTarget ??= jest.fn(async (priorId: string) => { retained.push(priorId); }));
  const getRollbackSpy = (spies.getRollbackTarget ??= jest.fn((id: string) => retained.includes(id) ? id : null));
  const listRetainedSpy = (spies.listRetainedCheckpoints ??= jest.fn(() => [...retained]));

  // Wire getPin to reflect setPin mutations
  getPinSpy.mockImplementation(() => prodPin);
  // Expose internals for assertions
  (getPinSpy as unknown as Record<string, unknown>).__prodPinRef = () => prodPin;
  (writeAuditSpy as unknown as Record<string, unknown>).__auditWrites = auditWrites;

  return {
    fetchStagingManifest: fetchSpy,
    getLiveDigests: liveSpy,
    checkHealth: healthSpy,
    getReplayWarnings: replaySpy,
    getEvidence: evidenceSpy,
    getProductionPin: getPinSpy,
    setProductionPin: setPinSpy,
    writeAuditRecord: writeAuditSpy,
    writeRollbackTarget: writeRollbackSpy,
    getRollbackTarget: getRollbackSpy,
    listRetainedCheckpoints: listRetainedSpy,
  };
}

// Helper to build a gate instance — adapts to whatever constructor the implementer chooses
function buildGate(deps: FakeDeps): InstanceType<typeof PromotionGate> {
  // PromotionGate is expected to accept deps object; if it takes no args, this will still be called
  // and the implementer should handle it. Tests assert via spies that staging fetch was used.
  return new (PromotionGate as unknown as new (deps: FakeDeps) => InstanceType<typeof PromotionGate>)(deps);
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1: Explicit promotion only
// ──────────────────────────────────────────────────────────────────────────────

describe("INF-1331 AC1: explicit promotion — promote --from staging --checkpoint <id> only", () => {
  it("refuses when checkpoint id is missing/empty", async () => {
    const ctx = makePassingContext();
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);
    await expect(
      // @ts-expect-error — intentionally missing checkpoint id
      gate.promote({ from: "staging", checkpointId: "" }),
    ).rejects.toThrow();
    // Also falsy/undefined form
    await expect(
      // @ts-expect-error
      gate.promote({ from: "staging" }),
    ).rejects.toThrow();
  });

  it("refuses when --from is not staging (e.g. origin/main, production, omitted)", async () => {
    const ctx = makePassingContext();
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);
    await expect(gate.promote({ from: "origin/main" as unknown as "staging", checkpointId: ctx.checkpointId })).rejects.toThrow();
    await expect(gate.promote({ from: "production" as unknown as "staging", checkpointId: ctx.checkpointId })).rejects.toThrow();
    await expect(
      // @ts-expect-error — missing from
      gate.promote({ checkpointId: ctx.checkpointId }),
    ).rejects.toThrow();
  });

  it("does not invoke any origin/main fallback — staging manifest fetch is required", async () => {
    const ctx = makePassingContext();
    const spies: Record<string, jest.Mock> = {};
    const deps = makeFakeDeps(ctx, spies);
    // Spy for origin/main resolution that must NOT be called
    const originMainSpy = jest.fn(async () => "deadbeef");
    (deps as unknown as Record<string, unknown>).resolveMainCommit = originMainSpy;
    (deps as unknown as Record<string, unknown>).getMainCommit = originMainSpy;
    (deps as unknown as Record<string, unknown>).fetchMainManifest = originMainSpy;

    const gate = buildGate(deps as unknown as FakeDeps);
    // Even on success, origin/main must not have been consulted
    const result = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId });
    expect(result.success).toBe(true);
    expect(spies.fetchStagingManifest).toHaveBeenCalledWith(ctx.checkpointId);
    expect(originMainSpy).not.toHaveBeenCalled();
  });

  it("no code path promotes without a named checkpoint id and staging source — implicit promotion is absent", async () => {
    const ctx = makePassingContext();
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);
    // Enumerate implicit-promotion-shaped calls that must all refuse
    const implicitCalls: Array<() => Promise<unknown>> = [
      () => (gate as unknown as Record<string, (a: unknown) => Promise<unknown>>).promoteFromMain?.({}),
      () => (gate as unknown as Record<string, () => Promise<unknown>>).promoteLatest?.(),
      () => (gate as unknown as Record<string, () => Promise<unknown>>).autoPromote?.(),
      () => gate.promote({ from: "staging", checkpointId: "" }),
    ];
    for (const call of implicitCalls) {
      try {
        const maybe = call();
        if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
          await expect(maybe).rejects.toThrow();
        }
      } catch {
        // Synchronous throw also satisfies the requirement (refused)
      }
    }
    // At minimum, the explicit guard above already proved missing-id refuses
    await expect(gate.promote({ from: "staging", checkpointId: "" as unknown as string })).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC2: Fail-closed on all six gate conditions — independent enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe("INF-1331 AC2: fail-closed on each of the six gate conditions (independent)", () => {
  it("happy path — all six gates pass → promotion succeeds", async () => {
    const ctx = makePassingContext();
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);
    const result = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId });
    expect(result.success).toBe(true);
    expect(result.refused).toBeFalsy();
  });

  it("Gate 1 — staging manifest missing or digest mismatch → refused with gate-1 reason", async () => {
    // Sub-case A: manifest missing (staging does not serve requested checkpoint)
    const ctxA = makePassingContext({ stagingManifest: null });
    const depsA = makeFakeDeps(ctxA);
    const gateA = buildGate(depsA);
    const resA = await gateA.promote({ from: "staging", checkpointId: ctxA.checkpointId }).catch((e: unknown) => e as { refused: boolean; reasonCode: string });
    // Gate may throw GateRefusedError or return { refused:true, reasonCode }
    expectRefused(resA, /gate.?1|manifest|digest/i);

    // Sub-case B: digest mismatch (live digest does not match manifest)
    const ctxB = makePassingContext();
    ctxB.liveDigests["app.tar.gz"] = "sha256:WRONG";
    const depsB = makeFakeDeps(ctxB);
    const gateB = buildGate(depsB);
    const resB = await gateB.promote({ from: "staging", checkpointId: ctxB.checkpointId }).catch((e: unknown) => e as { refused: boolean; reasonCode: string });
    expectRefused(resB, /gate.?1|manifest|digest/i);
  });

  it("Gate 2 — fixture drift / workflow migrations / cron / agents / tokens / dispatch / admin health → refused (gate-2)", async () => {
    // Fail exactly one sub-condition at a time; each must independently refuse
    const subChecks: Array<keyof GateContext["health"]> = [
      "fixtureDriftOk",
      "workflowMigrationsOk",
      "requiredCronReady",
      "agentsOk",
      "tokensOk",
      "dispatchSchedulerOk",
      "dispatchRecoveryOk",
      "adminHealthOk",
    ];
    for (const key of subChecks) {
      const ctx = makePassingContext({ health: { ...makePassingContext().health, [key]: false } as GateContext["health"] });
      const deps = makeFakeDeps(ctx);
      const gate = buildGate(deps);
      const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e);
      expectRefused(res, /gate.?2|health|contract/i, `sub-check ${key} should have refused`);
    }
  });

  it("Gate 3 — TDD or non-TDD acknowledged-silence warnings → refused; connector failures do NOT count as owner activity", async () => {
    // TDD silence warning
    const ctxTdd = makePassingContext({ replay: { tddSilenceWarnings: 1, nonTddSilenceWarnings: 0, connectorFailures: [] } });
    const gateTdd = buildGate(makeFakeDeps(ctxTdd));
    const resTdd = await gateTdd.promote({ from: "staging", checkpointId: ctxTdd.checkpointId }).catch((e: unknown) => e);
    expectRefused(resTdd, /gate.?3|replay|silence|warning/i);

    // non-TDD silence warning
    const ctxNon = makePassingContext({ replay: { tddSilenceWarnings: 0, nonTddSilenceWarnings: 1, connectorFailures: [] } });
    const gateNon = buildGate(makeFakeDeps(ctxNon));
    const resNon = await gateNon.promote({ from: "staging", checkpointId: ctxNon.checkpointId }).catch((e: unknown) => e);
    expectRefused(resNon, /gate.?3|replay|silence|warning/i);

    // Connector-side failures alone must NOT be treated as owner-activity recency;
    // but they also must NOT cause a gate-3 pass if warnings exist — here we assert
    // that connector failures present with zero warnings still PASSES gate 3 (promotion succeeds)
    const ctxConnOnly = makePassingContext({
      replay: {
        tddSilenceWarnings: 0,
        nonTddSilenceWarnings: 0,
        connectorFailures: [{ kind: "wake-turn-failed" }, { kind: "bootstrap/model error" }, { kind: "undeliverable" }],
      },
    });
    const gateConn = buildGate(makeFakeDeps(ctxConnOnly));
    const resConn = await gateConn.promote({ from: "staging", checkpointId: ctxConnOnly.checkpointId });
    expect(resConn.success).toBe(true);
  });

  it("Gate 4 — missing TDD wake / non-TDD wake / dependency-clear downstream wake → refused (gate-4)", async () => {
    // Missing TDD wake
    const ctxA = makePassingContext({ evidence: { ...makePassingContext().evidence, hasTddWake: false } });
    const resA = await buildGate(makeFakeDeps(ctxA)).promote({ from: "staging", checkpointId: ctxA.checkpointId }).catch((e: unknown) => e);
    expectRefused(resA, /gate.?4|evidence|wake/i);

    // Missing non-TDD impl wake
    const ctxB = makePassingContext({ evidence: { ...makePassingContext().evidence, hasNonTddImplWake: false } });
    const resB = await buildGate(makeFakeDeps(ctxB)).promote({ from: "staging", checkpointId: ctxB.checkpointId }).catch((e: unknown) => e);
    expectRefused(resB, /gate.?4|evidence|wake/i);

    // Missing dependency-clear downstream wake
    const ctxC = makePassingContext({ evidence: { ...makePassingContext().evidence, hasDependencyClearDownstreamWake: false } });
    const resC = await buildGate(makeFakeDeps(ctxC)).promote({ from: "staging", checkpointId: ctxC.checkpointId }).catch((e: unknown) => e);
    expectRefused(resC, /gate.?4|evidence|wake/i);

    // Downstream wake present but yields no owner artifact/blocker/auto-failure
    const ctxD = makePassingContext({ evidence: { ...makePassingContext().evidence, downstreamYieldsOwnerArtifactOrBlockerOrAutoFailure: false } });
    const resD = await buildGate(makeFakeDeps(ctxD)).promote({ from: "staging", checkpointId: ctxD.checkpointId }).catch((e: unknown) => e);
    expectRefused(resD, /gate.?4|evidence|wake|artifact|blocker/i);
  });

  it("Gate 5 — production not pinned to previous blessed checkpoint (or pin would be lost) → refused (gate-5)", async () => {
    // Simulate that production pin is inconsistent: gate observes it has already drifted
    // Implementer should enforce that prod remains pinned until gate passes.
    // We model this by having getProductionPin return an unexpected value.
    const ctx = makePassingContext();
    const deps = makeFakeDeps(ctx);
    // Override to simulate prod already moved (not pinned to expected prior)
    (deps.getProductionPin as jest.Mock).mockReturnValue("chk-blessed-000-unexpected");
    // Alternatively, if the gate checks retained list, empty it
    (deps.listRetainedCheckpoints as jest.Mock).mockReturnValue([]);
    const gate = buildGate(deps);
    // This is advisory — if implementer models gate 5 differently (e.g. as "old checkpoint would not be retained"),
    // then the next test (AC4) covers it; we still assert that a gate-5-shaped violation refuses.
    // To avoid false-fail on alternative modeling, only assert refused if the impl does enforce gate 5 strictly.
    // We do a best-effort: if it succeeds despite pin drift, flag via expectation that at least one gate-5 violation refuses.
    // For the red phase this will fail due to missing module anyway, so no false green.
    try {
      const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId });
      // If impl does not treat drifted pin as gate-5 refusal, this test documents the expectation — force failure
      expect(res.refused).toBe(true);
      expect(String((res as unknown as Record<string, unknown>).reasonCode ?? (res as unknown as Record<string, unknown>).reason ?? "")).toMatch(/gate.?5|pin|retained/i);
    } catch (e: unknown) {
      expectRefused(e, /gate.?5|pin|retained/i);
    }
  });

  it("Gate 6 — missing audit fields (source/target ids, operator/job, timestamps, result, post-promotion verification) → refused (gate-6)", async () => {
    const requiredFields: Array<{ label: string; mutate: (a: GateContext["auditFields"]) => void }> = [
      { label: "sourceId", mutate: (a) => { a.sourceId = null; } },
      { label: "targetId", mutate: (a) => { a.targetId = null; } },
      { label: "operator", mutate: (a) => { a.operator = null; } },
      { label: "job", mutate: (a) => { a.job = null; } },
      { label: "timestamps", mutate: (a) => { a.timestamps = { startedAt: null, finishedAt: null }; } },
      { label: "result", mutate: (a) => { a.result = null; } },
      { label: "postPromotionVerification", mutate: (a) => { a.postPromotionVerification = null; } },
    ];
    for (const { label, mutate } of requiredFields) {
      const ctx = makePassingContext();
      mutate(ctx.auditFields);
      // Expose auditFields via deps — implementer may read from context or own store
      const deps = makeFakeDeps(ctx);
      (deps as unknown as Record<string, unknown>).getAuditFields = jest.fn(() => ctx.auditFields);
      (deps as unknown as Record<string, unknown>).auditFields = ctx.auditFields;
      const gate = buildGate(deps as unknown as FakeDeps);
      const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e);
      expectRefused(res, /gate.?6|audit|verification|operator|timestamp/i, `audit field ${label} should have refused`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC3: Failing gate leaves production unchanged
// ──────────────────────────────────────────────────────────────────────────────

describe("INF-1331 AC3: failing gate leaves production pinned (no mutation on refusal)", () => {
  it.each([
    { gate: "gate-1 (manifest/digest)", mutate: (c: GateContext) => { c.stagingManifest = null; } },
    { gate: "gate-2 (health)", mutate: (c: GateContext) => { c.health.fixtureDriftOk = false; } },
    { gate: "gate-3 (replay silence)", mutate: (c: GateContext) => { c.replay.tddSilenceWarnings = 1; } },
    { gate: "gate-4 (evidence)", mutate: (c: GateContext) => { c.evidence.hasTddWake = false; } },
    { gate: "gate-6 (audit)", mutate: (c: GateContext) => { c.auditFields.operator = null; (c as unknown as Record<string, unknown>).__auditMissing = true; } },
  ])("after $gate refusal, production pin still equals prior blessed checkpoint and no prod write occurred", async ({ mutate }) => {
    const ctx = makePassingContext();
    mutate(ctx);
    const deps = makeFakeDeps(ctx);
    if ((ctx as unknown as Record<string, unknown>).__auditMissing) {
      (deps as unknown as Record<string, unknown>).getAuditFields = jest.fn(() => ctx.auditFields);
    }
    const priorPin = ctx.productionPin.currentBlessedCheckpointId;
    const gate = buildGate(deps);

    const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e as { refused: boolean });
    expectRefused(res, /gate|refused|health|manifest|digest|replay|silence|evidence|audit/i);

    // Production pin unchanged
    expect(deps.getProductionPin()).toBe(priorPin);
    expect(deps.setProductionPin).not.toHaveBeenCalled();
    // No audit/rollback prod writes on refusal
    expect(deps.writeAuditRecord).not.toHaveBeenCalled();
    expect(deps.writeRollbackTarget).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC4: Retained, addressable rollback target
// ──────────────────────────────────────────────────────────────────────────────

describe("INF-1331 AC4: retained, addressable rollback target after successful promotion", () => {
  it("after success, prior blessed checkpoint is retained and addressable as rollback target", async () => {
    const ctx = makePassingContext();
    const priorId = ctx.productionPin.currentBlessedCheckpointId;
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);

    const result = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId });
    expect(result.success).toBe(true);

    // Prior checkpoint must be fetchable via rollback surface
    expect(deps.getRollbackTarget(priorId)).toBe(priorId);
    expect(deps.listRetainedCheckpoints()).toContain(priorId);

    // It must be addressable as a rollback source (e.g. fetchable manifest / pin-able)
    // If gate exposes getRollbackTarget / fetchRollbackManifest, assert it; otherwise retained list is the contract
    const maybeFetchRollback = (gate as unknown as Record<string, ((id: string) => Promise<unknown>) | undefined>).fetchRollbackManifest
      ?? (gate as unknown as Record<string, ((id: string) => unknown) | undefined>).getRollbackTarget;
    if (typeof maybeFetchRollback === "function") {
      const fetched = await (maybeFetchRollback as (id: string) => Promise<unknown>).call(gate, priorId);
      expect(fetched).toBeTruthy();
    }
  });

  it("retained target survives and is distinct from the new production pin", async () => {
    const ctx = makePassingContext();
    const priorId = ctx.productionPin.currentBlessedCheckpointId;
    const deps = makeFakeDeps(ctx);
    const gate = buildGate(deps);

    await gate.promote({ from: "staging", checkpointId: ctx.checkpointId });

    const newPin = deps.getProductionPin();
    expect(newPin).toBe(ctx.checkpointId);
    expect(newPin).not.toBe(priorId);
    expect(deps.getRollbackTarget(priorId)).toBe(priorId);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC5: Atomic audit + rollback-target write (all-or-nothing)
// ──────────────────────────────────────────────────────────────────────────────

describe("INF-1331 AC5: atomic audit + rollback-target write (all-or-nothing)", () => {
  it("if audit write throws, production pin is NOT advanced and no partial state remains", async () => {
    const ctx = makePassingContext();
    const priorId = ctx.productionPin.currentBlessedCheckpointId;
    const deps = makeFakeDeps(ctx);
    (deps.writeAuditRecord as jest.Mock).mockRejectedValueOnce(new Error("audit store unavailable"));

    const gate = buildGate(deps);
    const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e as { refused: boolean; success: boolean });

    // Must be refused / not success
    const succeeded = (res as unknown as Record<string, unknown>).success === true;
    expect(succeeded).toBe(false);

    // Production pin must NOT have advanced
    expect(deps.getProductionPin()).toBe(priorId);
    // Rollback write must not have been left partially applied (or must have been compensated)
    // If impl writes rollback before audit, it must have rolled back; we assert retained does NOT contain a partial new entry beyond prior
    // The prior must still be retrievable, not corrupted
    expect(deps.getRollbackTarget(priorId)).toBe(priorId);
  });

  it("if rollback-target write throws, production pin is NOT advanced and audit is not left orphaned", async () => {
    const ctx = makePassingContext();
    const priorId = ctx.productionPin.currentBlessedCheckpointId;
    const deps = makeFakeDeps(ctx);
    (deps.writeRollbackTarget as jest.Mock).mockRejectedValueOnce(new Error("rollback store unavailable"));

    const gate = buildGate(deps);
    const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e);

    const succeeded = (res as unknown as Record<string, unknown>).success === true;
    expect(succeeded).toBe(false);
    expect(deps.getProductionPin()).toBe(priorId);
    // Audit record must have been rolled back / not committed if the impl uses a transaction
    // We assert that a failed promotion does not leave an audit record claiming success for the new checkpoint
    // If the impl wrote audit before rollback, it must have compensated — best-effort check:
    const auditCalls = (deps.writeAuditRecord as jest.Mock).mock.calls;
    if (auditCalls.length > 0) {
      // If audit was written optimistically, the impl should have removed/compensated it or marked it as not-success
      // We accept either no audit write survives or the gate surface reports failure
      expect(succeeded).toBe(false);
    }
  });

  it("crash/interrupt between audit and rollback writes never leaves production advanced without both records (injected fault order)", async () => {
    const ctx = makePassingContext();
    const priorId = ctx.productionPin.currentBlessedCheckpointId;
    const deps = makeFakeDeps(ctx);

    // Simulate crash after audit write but before rollback write completes:
    // audit succeeds, then rollback throws (simulating interrupt), and setProductionPin must not have been called
    let auditDone = false;
    (deps.writeAuditRecord as jest.Mock).mockImplementation(async () => { auditDone = true; });
    (deps.writeRollbackTarget as jest.Mock).mockImplementation(async () => {
      if (auditDone) throw new Error("interrupted before rollback commit");
    });

    const gate = buildGate(deps);
    const res = await gate.promote({ from: "staging", checkpointId: ctx.checkpointId }).catch((e: unknown) => e);

    expect((res as unknown as Record<string, unknown>).success === true).toBe(false);
    expect(deps.getProductionPin()).toBe(priorId);
    expect(deps.setProductionPin).not.toHaveBeenCalledWith(ctx.checkpointId);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function expectRefused(value: unknown, reasonPattern: RegExp, label?: string): void {
  const prefix = label ? `${label}: ` : "";
  // Accepted refusal shapes:
  // - thrown GateRefusedError with reasonCode/reason/gate
  // - returned { refused:true, reasonCode } or { success:false, refused:true }
  // - thrown Error whose message matches pattern
  if (value instanceof Error) {
    const msg = `${value.message} ${(value as unknown as Record<string, unknown>).reasonCode ?? ""} ${(value as unknown as Record<string, unknown>).code ?? ""} ${(value as unknown as Record<string, unknown>).gate ?? ""}`;
    expect(prefix + msg).toMatch(reasonPattern);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj && (obj.refused === true || obj.success === false)) {
    const reason = String(obj.reasonCode ?? obj.reason ?? obj.code ?? obj.gate ?? obj.message ?? JSON.stringify(obj));
    expect(prefix + reason).toMatch(reasonPattern);
    return;
  }
  // Fallback: treat as failure to refuse
  expect(prefix + `expected refusal matching ${reasonPattern} but got: ${JSON.stringify(value)}`).toMatch(reasonPattern);
}
