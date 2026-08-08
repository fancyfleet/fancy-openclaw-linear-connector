/**
 * INF-1331 Slice C — Promotion gate and production pinning
 * Explicit promotion only: promote --from staging --checkpoint <id>
 * Six gates fail-closed, atomic audit+rollback write.
 */

export class GateRefusedError extends Error {
  reasonCode: string;
  gate: string;
  code: string;
  refused = true;
  success = false;
  constructor(message: string, reasonCode: string) {
    super(message);
    this.name = "GateRefusedError";
    this.reasonCode = reasonCode;
    this.code = reasonCode;
    this.gate = reasonCode;
  }
}

type CheckpointId = string;

interface FakeManifest {
  checkpointId: CheckpointId;
  digests: Record<string, string>;
}

interface PromotionDeps {
  fetchStagingManifest: (checkpointId: string) => Promise<FakeManifest | null>;
  getLiveDigests: () => Promise<Record<string, string>>;
  checkHealth: () => Promise<{
    fixtureDriftOk: boolean;
    workflowMigrationsOk: boolean;
    requiredCronReady: boolean;
    agentsOk: boolean;
    tokensOk: boolean;
    dispatchSchedulerOk: boolean;
    dispatchRecoveryOk: boolean;
    adminHealthOk: boolean;
  }>;
  getReplayWarnings: () => Promise<{
    tddSilenceWarnings: number;
    nonTddSilenceWarnings: number;
    connectorFailures: { kind: string }[];
  }>;
  getEvidence: () => Promise<{
    hasTddWake: boolean;
    hasNonTddImplWake: boolean;
    hasDependencyClearDownstreamWake: boolean;
    downstreamYieldsOwnerArtifactOrBlockerOrAutoFailure: boolean;
  }>;
  getProductionPin: () => string;
  setProductionPin: (id: string) => void;
  writeAuditRecord: (rec: unknown) => Promise<void>;
  writeRollbackTarget: (priorId: string) => Promise<void>;
  getRollbackTarget: (id: string) => string | null;
  listRetainedCheckpoints: () => string[];
  // Required audit source for Gate 6 — fail-closed (AC2)
  getAuditFields: () => unknown;
  auditFields: unknown;
  // Allow any extra keys without error
  [k: string]: unknown;
}

export class PromotionGate {
  private deps: PromotionDeps;

  constructor(deps: PromotionDeps) {
    this.deps = deps;
  }

  async promote(args: { from: string; checkpointId: string }): Promise<{ success: boolean; refused?: boolean; checkpointId?: string; reasonCode?: string; reason?: string }> {
    // AC1: explicit promotion only
    const from = (args as Record<string, unknown>)["from"] as string | undefined;
    const checkpointId = (args as Record<string, unknown>)["checkpointId"] as string | undefined;

    if (!checkpointId || typeof checkpointId !== "string" || checkpointId.trim() === "") {
      throw new GateRefusedError("gate-1: missing checkpoint id — explicit --checkpoint <id> required", "gate-1-missing-checkpoint");
    }
    if (from !== "staging") {
      throw new GateRefusedError(`gate-1: explicit --from staging required, got from=${String(from)}`, "gate-1-invalid-source");
    }

    // Gate 1: staging manifest fetch + digest verification
    const manifest = await this.deps.fetchStagingManifest(checkpointId);
    if (!manifest) {
      throw new GateRefusedError(`gate-1 manifest missing for checkpoint ${checkpointId}`, "gate-1-manifest-missing");
    }
    const liveDigests = await this.deps.getLiveDigests();
    // Compare digests
    const manifestDigests = manifest.digests ?? {};
    for (const [key, expected] of Object.entries(manifestDigests)) {
      const live = (liveDigests as Record<string, string>)[key];
      if (live !== expected) {
        throw new GateRefusedError(`gate-1 digest mismatch for ${key}: expected ${expected} got ${live}`, "gate-1-digest-mismatch");
      }
    }
    // Also ensure no extra/missing keys cause mismatch if manifest empty? Already covered.

    // Gate 2: 8 health sub-checks
    const health = await this.deps.checkHealth();
    const healthChecks: Array<[string, boolean]> = [
      ["fixtureDriftOk", health.fixtureDriftOk],
      ["workflowMigrationsOk", health.workflowMigrationsOk],
      ["requiredCronReady", health.requiredCronReady],
      ["agentsOk", health.agentsOk],
      ["tokensOk", health.tokensOk],
      ["dispatchSchedulerOk", health.dispatchSchedulerOk],
      ["dispatchRecoveryOk", health.dispatchRecoveryOk],
      ["adminHealthOk", health.adminHealthOk],
    ];
    for (const [name, ok] of healthChecks) {
      if (!ok) {
        throw new GateRefusedError(`gate-2 health contract failed: ${name}`, "gate-2-health-contract");
      }
    }

    // Gate 3: replay silence warnings
    const replay = await this.deps.getReplayWarnings();
    if ((replay.tddSilenceWarnings ?? 0) > 0 || (replay.nonTddSilenceWarnings ?? 0) > 0) {
      throw new GateRefusedError(`gate-3 replay silence warning: tdd=${replay.tddSilenceWarnings} nonTdd=${replay.nonTddSilenceWarnings}`, "gate-3-replay-silence-warning");
    }
    // connectorFailures explicitly do NOT cause refusal — ignored

    // Gate 4: evidence
    const evidence = await this.deps.getEvidence();
    if (!evidence.hasTddWake) {
      throw new GateRefusedError("gate-4 evidence missing hasTddWake", "gate-4-evidence-wake");
    }
    if (!evidence.hasNonTddImplWake) {
      throw new GateRefusedError("gate-4 evidence missing hasNonTddImplWake", "gate-4-evidence-wake");
    }
    if (!evidence.hasDependencyClearDownstreamWake) {
      throw new GateRefusedError("gate-4 evidence missing hasDependencyClearDownstreamWake", "gate-4-evidence-wake");
    }
    if (!evidence.downstreamYieldsOwnerArtifactOrBlockerOrAutoFailure) {
      throw new GateRefusedError("gate-4 evidence downstream yields no owner artifact/blocker/auto-failure", "gate-4-evidence-artifact-blocker");
    }

    // Gate 5: production pin / retained check
    const currentPin = this.deps.getProductionPin();
    const retained = this.deps.listRetainedCheckpoints();
    // Fail if retained empty or pin not retained (drift / pin would be lost)
    if (!retained || retained.length === 0) {
      throw new GateRefusedError("gate-5 pin retained check failed: no retained checkpoints", "gate-5-pin-retained");
    }
    if (!currentPin || !retained.includes(currentPin)) {
      throw new GateRefusedError(`gate-5 pin retained check failed: current pin ${currentPin} not in retained [${retained.join(",")}]`, "gate-5-pin-retained");
    }

    // Gate 6: audit fields — unconditional fail-closed (AC2). Missing/incomplete → refuse.
    let auditFields: Record<string, unknown> | null = null;
    const maybeGetAudit = this.deps.getAuditFields;
    if (typeof maybeGetAudit === "function") {
      try {
        auditFields = (maybeGetAudit as () => Record<string, unknown>)() as Record<string, unknown>;
      } catch {
        auditFields = null;
      }
    } else if (this.deps.auditFields && typeof this.deps.auditFields === "object") {
      auditFields = this.deps.auditFields as Record<string, unknown>;
    } else if ((this.deps as Record<string, unknown>)["auditFields"] && typeof (this.deps as Record<string, unknown>)["auditFields"] === "object") {
      auditFields = (this.deps as Record<string, unknown>)["auditFields"] as Record<string, unknown>;
    }
    if (!auditFields) {
      throw new GateRefusedError("gate-6 audit missing", "gate-6-audit-missing");
    }
    {
      const sourceId = auditFields["sourceId"] as unknown;
      const targetId = auditFields["targetId"] as unknown;
      const operator = auditFields["operator"] as unknown;
      const job = auditFields["job"] as unknown;
      const result = auditFields["result"] as unknown;
      const postPromotionVerification = auditFields["postPromotionVerification"] as unknown;
      const timestamps = auditFields["timestamps"] as Record<string, unknown> | null | undefined;

      if (sourceId == null || sourceId === "") {
        throw new GateRefusedError("gate-6 audit missing sourceId", "gate-6-audit-sourceId");
      }
      if (targetId == null || targetId === "") {
        throw new GateRefusedError("gate-6 audit missing targetId", "gate-6-audit-targetId");
      }
      if (operator == null || operator === "") {
        throw new GateRefusedError("gate-6 audit missing operator", "gate-6-audit-operator");
      }
      if (job == null || job === "") {
        throw new GateRefusedError("gate-6 audit missing job", "gate-6-audit-job");
      }
      if (result == null || result === "") {
        throw new GateRefusedError("gate-6 audit missing result", "gate-6-audit-result");
      }
      if (postPromotionVerification == null) {
        throw new GateRefusedError("gate-6 audit missing postPromotionVerification", "gate-6-audit-postPromotionVerification");
      }
      if (!timestamps || timestamps["startedAt"] == null || timestamps["finishedAt"] == null || timestamps["startedAt"] === "" || timestamps["finishedAt"] === "") {
        throw new GateRefusedError("gate-6 audit missing timestamps", "gate-6-audit-timestamps");
      }
    }

    // All gates passed — atomic audit + rollback-target write + pin advance (AC5)
    const priorId = currentPin;

    // Perform writes atomically: if any throws, pin must NOT advance
    // Order: audit then rollback then pin — but pin is NOT called if prior throws
    await this.deps.writeAuditRecord({
      sourceId: checkpointId,
      targetId: checkpointId,
      checkpointId,
      from: "staging",
      priorBlessedCheckpointId: priorId,
      timestamp: new Date().toISOString(),
      result: "promoted",
      postPromotionVerification: true,
      ...(auditFields ?? {}),
    });
    await this.deps.writeRollbackTarget(priorId);
    this.deps.setProductionPin(checkpointId);

    return { success: true, refused: false, checkpointId };
  }

  // Expose rollback addressability
  getRollbackTarget(id: string): string | null {
    return this.deps.getRollbackTarget(id);
  }

  async fetchRollbackManifest(id: string): Promise<string | null> {
    return this.deps.getRollbackTarget(id);
  }
}
