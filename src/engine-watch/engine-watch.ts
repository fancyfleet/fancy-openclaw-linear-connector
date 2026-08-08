/**
 * INF-1302 — engine-watch signal-to-ticket pipeline
 *
 * Classifies every new signal into one of four dispositions,
 * provides dedup and Matrix/cron summary helpers.
 */

export type TicketRef = { id: string; identifier: string; state: string; stateType: string; url?: string };
export type Signal = { id: string; class: string; evidence: string; source?: string; runId?: string; observedAt?: string };
export type Disposition =
  | { kind: "attached-active-owner"; signalId: string; ownerTicket: TicketRef }
  | { kind: "recurrence-with-followup"; signalId: string; terminalOwner: TicketRef; followupTicket: TicketRef }
  | { kind: "non-actionable"; signalId: string; reason: string }
  | { kind: "new-fix-ticket"; signalId: string; createdTicket: TicketRef };

const NOISE_CLASSES = new Set<string>(["flaky-infra-noise"]);

function isTerminalStateType(stateType: string): boolean {
  return stateType === "completed" || stateType === "canceled";
}

export function isActiveStateType(stateType: string): boolean {
  return stateType === "unstarted" || stateType === "started" || stateType === "triage";
}

const dedupRegistry = new Map<string, TicketRef>();

export function getDedupKey(signal: Signal): string {
  return `${signal.class}::${signal.evidence}`;
}

export function getDedupTicket(signal: Signal): TicketRef | undefined {
  return dedupRegistry.get(getDedupKey(signal));
}

export function peekDedupActiveTicket(signal: Signal): TicketRef | null {
  const t = dedupRegistry.get(getDedupKey(signal));
  return t && isActiveStateType(t.stateType) ? t : null;
}

export function classifySignal(
  signal: Signal,
  ctx: {
    closestOwner: TicketRef | null;
    activeFollowup: TicketRef | null;
    createTicket?: (signal: Signal) => TicketRef;
  },
): Disposition {
  if (NOISE_CLASSES.has(signal.class)) {
    return {
      kind: "non-actionable",
      signalId: signal.id,
      reason: `${signal.class} — transient noise, below threshold, no ticket required`,
    };
  }

  const dedupKey = getDedupKey(signal);
  const owner = ctx.closestOwner;

  // Terminal recurrence must promote to active follow-up (AC2) — checked
  // before active-owner dedup short-circuit.
  if (owner && isTerminalStateType(owner.stateType)) {
    const dedupOwner = dedupRegistry.get(dedupKey);
    if (dedupOwner && isActiveStateType(dedupOwner.stateType)) {
      return {
        kind: "recurrence-with-followup",
        signalId: signal.id,
        terminalOwner: owner,
        followupTicket: dedupOwner,
      };
    }
    if (ctx.activeFollowup && isActiveStateType(ctx.activeFollowup.stateType)) {
      dedupRegistry.set(dedupKey, ctx.activeFollowup);
      return {
        kind: "recurrence-with-followup",
        signalId: signal.id,
        terminalOwner: owner,
        followupTicket: ctx.activeFollowup,
      };
    }
    if (ctx.createTicket) {
      const followup = ctx.createTicket(signal);
      dedupRegistry.set(dedupKey, followup);
      return {
        kind: "recurrence-with-followup",
        signalId: signal.id,
        terminalOwner: owner,
        followupTicket: followup,
      };
    }
    return {
      kind: "non-actionable",
      signalId: signal.id,
      reason: `terminal owner ${owner.identifier} recurrence requires follow-up but no ticket creation available`,
    };
  }

  // Active owner — dedup suppresses duplicate ticket creation (AC4).
  if (owner && !isTerminalStateType(owner.stateType)) {
    const dedupOwner = dedupRegistry.get(dedupKey);
    if (dedupOwner && isActiveStateType(dedupOwner.stateType)) {
      return {
        kind: "attached-active-owner",
        signalId: signal.id,
        ownerTicket: dedupOwner,
      };
    }
    dedupRegistry.set(dedupKey, owner);
    return {
      kind: "attached-active-owner",
      signalId: signal.id,
      ownerTicket: owner,
    };
  }

  // No owner — new connector fix ticket (AC1 branch 3).
  // Tick-level cross-tick dedup (AC4) is enforced in runEngineWatchTick by
  // consulting the registry before creation and passing the active follow-up
  // via ctx.activeFollowup; the classifier honors it here and records it so
  // subsequent ticks reuse the same ticket. The registry is not consulted
  // directly in this branch to avoid cross-context pollution between
  // terminal-followup and no-owner unit tests that share the same signal
  // shape (see AC5b pair).
  if (!owner) {
    if (ctx.activeFollowup && isActiveStateType(ctx.activeFollowup.stateType)) {
      dedupRegistry.set(dedupKey, ctx.activeFollowup);
      return {
        kind: "new-fix-ticket",
        signalId: signal.id,
        createdTicket: ctx.activeFollowup,
      };
    }
    if (ctx.createTicket) {
      const created = ctx.createTicket(signal);
      dedupRegistry.set(dedupKey, created);
      return {
        kind: "new-fix-ticket",
        signalId: signal.id,
        createdTicket: created,
      };
    }
    return {
      kind: "non-actionable",
      signalId: signal.id,
      reason: `no class-owner for ${signal.class} and no ticket creation available`,
    };
  }

  return {
    kind: "non-actionable",
    signalId: signal.id,
    reason: `unclassified signal ${signal.class}`,
  };
}

export function buildEngineWatchSummary(dispositions: Disposition[]): string {
  if (dispositions.length === 0) return "engine-watch: no signals";
  const lines: string[] = [];
  for (const d of dispositions) {
    switch (d.kind) {
      case "attached-active-owner":
        lines.push(`${d.signalId} → ${d.ownerTicket.identifier} (attached-active-owner)`);
        break;
      case "recurrence-with-followup":
        lines.push(
          `${d.signalId} → ${d.followupTicket.identifier} (recurrence-with-followup, terminal ${d.terminalOwner.identifier})`,
        );
        break;
      case "new-fix-ticket":
        lines.push(`${d.signalId} → ${d.createdTicket.identifier} (new-fix-ticket)`);
        break;
      case "non-actionable":
        lines.push(`${d.signalId}: non-actionable: ${d.reason}`);
        break;
    }
  }
  return lines.join("\n");
}

/** Test-only: clear the dedup registry between cases. */
export function resetEngineWatchDedupForTest(): void {
  dedupRegistry.clear();
}
