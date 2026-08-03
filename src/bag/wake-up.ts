/**
 * Wake-up signal delivery.
 *
 * Sends a thin "you have N pending tickets" message to an agent when the bag
 * has work for them and they're not in an active session. The agent then uses
 * `linear consider-work <ID>` (single ticket) or `linear queue --next` /
 * `linear queue` (multiple tickets) to fetch and process work in priority order.
 *
 * NOTE: The session key uses the ticket's `linear-<IDENTIFIER>` format (e.g.
 * `linear-ILL-148`) so that the wake-up session shares context with any
 * subsequent webhook events for the same ticket. For multi-ticket wake-ups,
 * the first ticket's identifier is used as the key.
 */

import path from "node:path";
import { deliverMessageToAgent, type DeliveryConfig, type DeliveryResult } from "../delivery/index.js";
import { buildWorkflowAwareDeliveryMessage } from "../delivery/build-message.js";
import { loadUniversalCanon, formatCanonBlock, getActiveCanonVersion, type CanonLoadResult } from "../policy/universal-canon.js";
import { normalizeSessionKey, stripRecoveryVersion } from "../session-key.js";
import { createLogger, componentLogger } from "../logger.js";
import { randomUUID } from "node:crypto";
import { COMPLETED_STATUS_ROTATION_REASON, TERMINAL_STOP_ROTATION_REASON, HUSK_ROTATION_REASON, type SessionSpawnIdempotencyStore, type SessionSpawnRuntime } from "../store/session-spawn-idempotency-store.js";
import { probeBoundSessionTerminal } from "./stale-session-forensics.js";

const log = componentLogger(createLogger(), "wakeup");

/**
 * AI-2008: minimal structural interface for the acknowledged-delivery front door
 * (DispatchDeliveryScheduler). Declared here rather than imported to keep
 * wake-up delivery free of a hard dependency on the scheduler module.
 */
export interface WakeDeliveryScheduler {
  dispatch(params: {
    agentId: string;
    ticketId: string;
    workflowState?: string;
    gateway?: string;
    dispatchId: string;
    deliver: (ctx: { attempt: number; dispatchId: string }) => Promise<DeliveryResult>;
    maxRetries?: number;
    backoffMs?: (attempt: number) => number;
  }): Promise<{ status: "delivered" | "delivered-pending-ack" | "undeliverable"; attempts: number; dispatchId: string }>;
}

export interface WakeUpConfig extends DeliveryConfig {
  /** Signal message template. {count} and {tickets} are replaced. */
  signalTemplate?: string;
  /**
   * Linear auth token for the agent receiving the wake-up.
   * When provided and ticketIds.length === 1, the wake-up message is replaced
   * with the same rich per-step workflow instruction block that event-driven
   * delegation produces — so agents get full context upfront instead of a thin
   * "run consider-work" prompt that is blocked on workflow tickets.
   */
  linearAuthToken?: string;
  /**
   * AI-2008: when present, the wake is delivered through the acknowledged
   * retry/loud-failure layer instead of a single fire-and-forget attempt.
   * Every dispatch then records a delivery outcome, retries on failure, and
   * emits a `dispatch-undeliverable` warning on exhaustion. Injected by the
   * production bootstrap (createApp); absent in isolated unit tests, which keep
   * the legacy single-attempt path.
   */
  deliveryScheduler?: WakeDeliveryScheduler;
  /** AI-2008: gateway/host the delegate runs on, named in the undeliverable warning. */
  gateway?: string;
  /** AI-2008: workflow state at dispatch time, recorded on delivery outcomes. */
  workflowState?: string;
  /** INF-879: durable task-key guard for pending-bag sessions_spawn wake paths. */
  sessionSpawnStore?: SessionSpawnIdempotencyStore;
  /** INF-879: explicit task key; falls back to workflowState, then agent id. */
  sessionSpawnTaskKey?: string;
}

export const SINGLE_TICKET_TEMPLATE =
  "You have 1 pending ticket: {tickets}. Run `linear consider-work {tickets}` to begin.";

export const MULTI_TICKET_TEMPLATE =
  "You have {count} pending ticket(s) waiting: {tickets}. Run `linear queue --next` to pick up the highest-priority one, or `linear queue` to see all.";

// Used when the trigger is a mention/body-mention rather than a delegation.
// Agents should observe (not own) mention-triggered tickets.
export const MENTION_TICKET_TEMPLATE =
  "You have been @mentioned on ticket: {tickets}. Run `linear observe-issue {tickets}` to review.";

function ticketIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  const last = parts[parts.length - 1] ?? sessionKey;
  return last.startsWith("linear-") ? last.slice("linear-".length) : last;
}

function deliveryRuntime(config: WakeUpConfig): SessionSpawnRuntime {
  if (config.gatewayUrl && config.gatewayToken) return "openclaw-acp";
  if (config.hooksUrl && config.hooksToken) return "openclaw-acp";
  return "codex";
}

function defaultRuntimeStatePath(config: WakeUpConfig): string | null {
  if (config.runtimeStatePath) return config.runtimeStatePath;
  const home = process.env.HOME;
  return home ? path.join(home, ".openclaw", "sessions", "sessions.json") : null;
}

/**
 * Context from the prior delegate's handoff comment, bundled into the wake-up
 * message so the next agent sees it even if the comment hasn't landed in Linear
 * yet (fixes the same-second dispatch race documented in AI-1673).
 */
export interface HandoffContext {
  /** Display name of the agent who handed off the ticket. */
  delegateName: string;
  /** The handoff comment body. */
  comment: string;
  /** Age of the comment in milliseconds at dispatch time (0 = same-second race). */
  ageMs: number;
}

function formatHandoffAge(ageMs: number): string {
  if (ageMs < 1000) return "just now";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Build the wake-up message text for a set of pending ticket IDs.
 * Exported for unit testing; delivery callers use sendWakeUpSignal.
 *
 * When handoffCtx is provided, the prior delegate's comment is prepended so
 * the next agent has full context even if the comment hasn't landed in Linear.
 */
/** Strip the `linear-` session-key prefix so the CLI gets plain identifiers (e.g. FCY-502). */
const STRIP_LINEAR_PREFIX = /^linear-/i;

export function buildWakeUpMessage(
  ticketIds: string[],
  signalTemplate?: string,
  handoffCtx?: HandoffContext | null,
): string {
  const count = ticketIds.length;
  // Ticket IDs stored in the pending bag are in session-key format (linear-FCY-502).
  // The CLI expects plain identifiers (FCY-502), so strip the prefix.
  const plainIds = ticketIds.map(id => id.replace(STRIP_LINEAR_PREFIX, ""));
  const tickets = plainIds.join(", ");
  const defaultTemplate = count === 1 ? SINGLE_TICKET_TEMPLATE : MULTI_TICKET_TEMPLATE;
  const base = (signalTemplate ?? defaultTemplate)
    .replace(/\{count\}/g, String(count))
    .replace(/\{tickets\}/g, tickets);

  if (!handoffCtx) return base;

  const age = formatHandoffAge(handoffCtx.ageMs);
  const preamble = `Latest from previous delegate (${handoffCtx.delegateName}, ${age}): "${handoffCtx.comment}"`;
  return `${preamble}\n\n${base}`;
}

/**
 * Send a wake-up signal to an agent.
 *
 * For single-ticket workflow dispatches where a linearAuthToken is available,
 * the message is upgraded to the same rich per-step instruction block that
 * event-driven delegation produces. For multi-ticket dispatches or ad-hoc tickets,
 * falls back to the thin template.
 */
export async function sendWakeUpSignal(
  agentId: string,
  ticketIds: string[],
  config: WakeUpConfig,
): Promise<{ runId?: string; canonVersion?: string } | void> {
  let message: string;
  let canonVersion: string | null = null;

  if (ticketIds.length === 1 && config.linearAuthToken) {
    // INF-982: strip recovery version suffix before building the workflow-aware
    // message, so the Linear query uses the clean ticket identifier.
    const rawTicketId = ticketIds[0].replace(/:r\d+$/i, "");
    const plainId = rawTicketId.replace(/^linear-/i, "");
    const rich = await buildWorkflowAwareDeliveryMessage(plainId, config.linearAuthToken, agentId);
    if (rich) {
      // buildWorkflowAwareDeliveryMessage already injects the canon via withCanonBlock.
      message = rich;
      canonVersion = getActiveCanonVersion();
      log.info(`Rich workflow delivery for ${agentId} [${plainId}]`);
    } else {
      message = buildWakeUpMessage(ticketIds, config.signalTemplate);
    }
  } else {
    message = buildWakeUpMessage(ticketIds, config.signalTemplate);
  }

  // AI-1848 fix: inject canon into thin-template wake messages (multi-ticket,
  // ad-hoc, mention). buildWorkflowAwareDeliveryMessage already handles canon
  // for the rich workflow path above.
  if (!canonVersion) {
    const canon = await loadUniversalCanon();
    if (canon) {
      const block = formatCanonBlock(canon.text, canon.version);
      if (block) {
        message = message + block;
        canonVersion = canon.version;
      }
    }
  }

  // Normalize to strip any legacy prefixes and enforce uppercase.
  // Result is always exactly `linear-<TEAM>-<NUMBER>`.
  const baseKey = ticketIds[0];
  // INF-982: when a stale-recovery fresh key (linear-INF-982:rN) is passed in,
  // use it DIRECTLY as the gateway session label so OpenClaw creates a new session
  // that doesn't match old stale sessions. The normalized key is used for internal
  // tracking (idempotency, bag, ackTracker) via stripRecoveryVersion.
  const sessionKey = baseKey.includes(":r")
    ? baseKey
    : normalizeSessionKey(baseKey);
  const normalizedKey = normalizeSessionKey(baseKey);
  const taskKey = config.sessionSpawnTaskKey ?? config.workflowState ?? agentId;
  const idempotency = config.sessionSpawnStore?.beginOrGetExisting({
    ticketId: ticketIdFromSessionKey(normalizedKey),
    taskKey,
    runtime: deliveryRuntime(config),
    agentId,
    sessionKey: normalizedKey,
  });
  // INF-1003 / INF-1074: re-dispatch rotation guard on the pending-bag path.
  // Mirrors deliverToAgent exactly — a bound session that produces no new turn on
  // wake is not replayed (that is the LIF-338 / ENG-5 C3 loop); we fall through
  // to mint a fresh session and record the old→new rotation below. Two "dead"
  // signals fire it: the INF-1003 terminal transcript tail (`stopReason: end_turn`)
  // and the INF-1074 lifecycle status (`status: "completed"` in the session index,
  // regardless of tail). In-flight bindings hit neither and still replay.
  let rotation: { fromSessionId: string | null; reason: string } | undefined;
  if (idempotency?.action === "return-existing") {
    const hasConcreteLiveBinding = idempotency.record.state === "live" && !!idempotency.record.session_id;
    if (!hasConcreteLiveBinding) {
      log.info(
        `sessions_spawn idempotent replay: wake ${sessionKey}/${taskKey} already has ` +
        `state=${idempotency.record.state} run=${idempotency.record.run_id ?? "pending"}`,
      );
      return { runId: idempotency.record.run_id ?? undefined, canonVersion: canonVersion ?? undefined };
    }
    const probe = probeBoundSessionTerminal(agentId, sessionKey, config.openclawHome);
    const boundSessionMatches =
      !idempotency.record.session_id || !probe.sessionId || probe.sessionId === idempotency.record.session_id;
    // INF-1101: also rotate on a husk (0 assistant turns past the age floor) —
    // the timed-out variant that fires neither statusCompleted nor terminal.
    const shouldRotate = boundSessionMatches && (probe.statusCompleted || probe.terminal || probe.husk);
    if (!shouldRotate) {
      log.info(
        `sessions_spawn idempotent replay: wake ${sessionKey}/${taskKey} already has ` +
        `state=${idempotency.record.state} run=${idempotency.record.run_id ?? "pending"}`,
      );
      return { runId: idempotency.record.run_id ?? undefined, canonVersion: canonVersion ?? undefined };
    }
    const reason = probe.statusCompleted
      ? COMPLETED_STATUS_ROTATION_REASON
      : probe.terminal
        ? TERMINAL_STOP_ROTATION_REASON
        : HUSK_ROTATION_REASON;
    rotation = {
      fromSessionId: probe.sessionId ?? idempotency.record.session_id,
      reason,
    };
    log.info(
      `${probe.statusCompleted ? "INF-1074 completed-status" : probe.terminal ? "INF-1003 terminal-session" : "INF-1101 husk-timeout"} rotation: ` +
      `wake ${sessionKey}/${taskKey} bound session ` +
      `${probe.sessionId ?? idempotency.record.session_id ?? "?"} is dead ` +
      `(status=${probe.statusCompleted ? "completed" : "n/a"}, stopReason=${probe.stopReason}, husk=${probe.husk}) — ` +
      `minting a fresh session instead of replaying the dead transcript`,
    );
  }

  log.info(`Sending wake-up signal to ${agentId}: ${ticketIds.length} ticket(s) [${ticketIds.join(", ")}]`);

  try {
    const deliverOnce = (): Promise<DeliveryResult> =>
      deliverMessageToAgent(agentId, sessionKey, message, config);

    // AI-2008: on the production path a scheduler is injected, so the wake goes
    // through the acknowledged retry/loud-failure layer — no fire-and-forget.
    if (config.deliveryScheduler) {
      const outcome = await config.deliveryScheduler.dispatch({
        agentId,
        ticketId: sessionKey,
        workflowState: config.workflowState,
        gateway: config.gateway,
        dispatchId: `wake-${sessionKey}-${randomUUID()}`,
        deliver: deliverOnce,
        // Honor the delivery config's retry bound so the test env (maxRetries: 0)
        // keeps single-attempt semantics; production leaves it undefined so the
        // scheduler applies its bounded backoff default.
        maxRetries: config.maxRetries,
      });
      if (outcome.status === "undeliverable") {
        throw new Error(
          `wake-up delivery undeliverable after ${outcome.attempts} attempt(s)`,
        );
      }
      if (idempotency?.record) {
        config.sessionSpawnStore!.markSpawned(idempotency.record.id, {
          runId: `${deliveryRuntime(config)}:${agentId}:${sessionKey}:${taskKey}`,
          sessionId: sessionKey,
          state: "live",
          runtimeStatePath: defaultRuntimeStatePath(config),
          rotationFromSessionId: rotation?.fromSessionId,
          rotationReason: rotation?.reason,
        });
      }
      return { canonVersion: canonVersion ?? undefined };
    }

    const result: DeliveryResult = await deliverOnce();
    if (!result.dispatched) {
      throw new Error(result.hookErrorSummary ?? "wake-up delivery was not accepted");
    }
    if (idempotency?.record) {
      config.sessionSpawnStore!.markSpawned(idempotency.record.id, {
        runId: result.runId ?? `${deliveryRuntime(config)}:${agentId}:${sessionKey}:${taskKey}`,
        sessionId: sessionKey,
        state: "live",
        runtimeStatePath: defaultRuntimeStatePath(config),
        rotationFromSessionId: rotation?.fromSessionId,
        rotationReason: rotation?.reason,
      });
    }
    return { runId: result.runId, canonVersion: canonVersion ?? undefined };
  } catch (err) {
    log.error(
      `Wake-up signal failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
    );
    throw err;
  }
}
