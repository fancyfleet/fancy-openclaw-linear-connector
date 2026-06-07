/**
 * GraphQL proxy — Phase 0B (transparent pass-through) + Phase 2 slice 1
 * (inbound command enforcement) + Phase 3 B1 (workflow-def-driven validation)
 * + Phase 3 B2 (atomic state-label transition application)
 * + Layer 2 raw mutation interception (AI-1387),
 * design.md §4.2, §4.6, §11, §13, §16.
 *
 * Enforcement order (defense in depth):
 *   1. Phase 2 escalation-gate — capability rule table (needs-human steward-only).
 *   2. Phase 3 B1 workflow-gate — full legal-move validation against dev-impl.yaml.
 *   3. Layer 2 raw mutation interception (AI-1387) — blocks direct status/assignee
 *      changes on workflow tickets that bypass the intent-header path.
 * All must pass for the request to be forwarded.
 *
 * After a successful forward, Phase 3 B2 applies the state:* label transition
 * atomically (single issueUpdate mutation). Seam: proxy-side, not CLI-side — the
 * state change is coupled to the validated forward so an agent cannot skip it.
 * Transition failures are fail-open: logged but never propagate to the response.
 */

import type { Request, Response } from "express";
import { componentLogger, createLogger } from "./logger.js";
import { checkEnforcementRules } from "./escalation-gate.js";
import { checkWorkflowRules, checkRawMutationInterception, applyStateTransition, buildStateTransitionReminder, type TransitionFeedback } from "./workflow-gate.js";
import type { ObservationStore, ReasonCode } from "./store/observation-store.js";

const log = componentLogger(createLogger(process.env.LOG_LEVEL ?? "info"), "proxy");
const LINEAR_API_URL = "https://api.linear.app/graphql";

interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function parseBody(req: Request): GraphQLRequestBody | null {
  try {
    if (Buffer.isBuffer(req.body)) {
      return JSON.parse(req.body.toString("utf8")) as GraphQLRequestBody;
    }
    if (typeof req.body === "object" && req.body !== null) {
      return req.body as GraphQLRequestBody;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Best-effort extraction of ticket identifier from GraphQL variables.
 * Returns the first non-empty string found in common ID variable names, or null.
 */
function extractIssueId(body: GraphQLRequestBody | null): string | null {
  if (!body?.variables) return null;
  const vars = body.variables;
  for (const key of ["id", "issueId", "identifier"]) {
    const v = vars[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Build the ticket context string for log lines (empty string when no ID found).
 */
function extractTicketContext(body: GraphQLRequestBody | null): string {
  const id = extractIssueId(body);
  return id ? ` ticket=${id}` : "";
}

/**
 * Best-effort extraction of comment body from GraphQL mutation variables.
 * Returns the first non-empty string found in common comment variable names, or null.
 */
function extractCommentBody(body: GraphQLRequestBody | null): string | null {
  if (!body?.variables) return null;
  const vars = body.variables as Record<string, unknown>;
  // commentCreate mutation sends { input: { body: "..." } } or { body: "..." }
  const input = vars.input;
  if (input && typeof input === "object" && input !== null) {
    const inputObj = input as Record<string, unknown>;
    if (typeof inputObj.body === "string" && inputObj.body.length > 0) return inputObj.body;
  }
  if (typeof vars.body === "string" && (vars.body as string).length > 0) return vars.body as string;
  return null;
}

export interface ProxyDeps {
  /** Optional observation store for recording feedback observations (P4-1). */
  observationStore?: ObservationStore;
}

export async function handleProxyRequest(req: Request, res: Response, deps?: ProxyDeps): Promise<void> {
  const authorization = req.headers["authorization"];
  if (!authorization) {
    res.status(401).json({ errors: [{ message: "Missing Authorization header" }] });
    return;
  }

  const agentId = (req.headers["x-openclaw-agent"] as string | undefined) ?? "unknown";
  const intent = (req.headers["x-openclaw-linear-intent"] as string | undefined) ?? null;
  const target = (req.headers["x-openclaw-linear-target"] as string | undefined) ?? null;
  const feedbackCategoryHeader = (req.headers["x-openclaw-feedback-category"] as string | undefined) ?? null;
  const body = parseBody(req);
  const opName = body?.operationName ?? "(unnamed)";
  const issueId = extractIssueId(body);
  const ticketCtx = issueId ? ` ticket=${issueId}` : "";

  log.info(`forward agent=${agentId} op=${opName}${ticketCtx}${intent ? ` intent=${intent}` : ""}`);

  // Phase 2 / slice 1 + Phase 3 B1: evaluate enforcement rules before forwarding.
  if (intent) {
    const p2rejection = await checkEnforcementRules(intent, issueId, authorization, agentId);
    if (p2rejection) {
      log.warn(`enforcement-block agent=${agentId} intent=${intent}${ticketCtx}: ${p2rejection}`);
      res.status(200).json({ errors: [{ message: p2rejection }] });
      return;
    }

    const p3rejection = await checkWorkflowRules(intent, issueId, authorization, agentId, target);
    if (p3rejection) {
      log.warn(`workflow-block agent=${agentId} intent=${intent}${ticketCtx}: ${p3rejection}`);
      res.status(200).json({ errors: [{ message: p3rejection }] });
      return;
    }
  } else {
    // Layer 2 (AI-1387): intercept raw status/assignee mutations on workflow tickets.
    // When no intent header is present but the mutation touches stateId or assigneeId,
    // the agent is bypassing workflow commands — reject with the legal verb set.
    const rawRejection = await checkRawMutationInterception(body, issueId, authorization);
    if (rawRejection) {
      log.warn(`raw-mutation-block agent=${agentId}${ticketCtx}: ${rawRejection}`);
      res.status(200).json({ errors: [{ message: rawRejection }] });
      return;
    }
  }

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`upstream request failed: ${msg}`);
    res
      .status(502)
      .json({ errors: [{ message: `Linear API unreachable: ${msg}` }] });
    return;
  }

  const responseText = await upstreamRes.text();
  log.info(`response agent=${agentId} op=${opName} status=${upstreamRes.status}`);

  // Phase 3 B2: apply state:* label transition after a successful forward.
  // Phase 4 / P4-1: record feedback observation for feedback transitions.
  // Only runs when the command was validated (intent present, no P2/P3 block).
  // Fail-open: errors are logged and never propagate to the agent's response.
  if (intent && upstreamRes.ok) {
    try {
      // Build feedback context for observation recording.
      let feedback: TransitionFeedback | undefined;
      if (feedbackCategoryHeader && (intent === "request-changes" || intent === "reject")) {
        const fromBodyHeader = (req.headers["x-openclaw-from-body"] as string | undefined) ?? null;
        feedback = {
          fromBody: fromBodyHeader,
          reasonCode: feedbackCategoryHeader as ReasonCode,
          freeText: extractCommentBody(body),
        };
      }
      await applyStateTransition(intent, issueId, authorization, {
        bodyId: agentId,
        observationStore: deps?.observationStore,
        feedback,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`state-transition failed agent=${agentId} intent=${intent}${ticketCtx}: ${msg}`);
    }

    // Layer 1 (AI-1387): proactive legal-verb re-injection at completion.
    // After a successful state transition, generate the legal commands for
    // the NEW state and include in the response body so the agent sees them
    // at the decision moment — not just at delegation time.
    // Injected into the response JSON as `_workflowReminder` since HTTP headers
    // cannot carry newlines.
    let workflowReminder: string | null = null;
    try {
      workflowReminder = await buildStateTransitionReminder(intent, issueId, authorization);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`reminder-build failed agent=${agentId} intent=${intent}${ticketCtx}: ${msg}`);
    }

    // If we have a reminder, inject it into the response body.
    if (workflowReminder) {
      try {
        const parsedResponse = JSON.parse(responseText);
        parsedResponse._workflowReminder = workflowReminder;
        res
          .status(upstreamRes.status)
          .set("Content-Type", "application/json")
          .send(JSON.stringify(parsedResponse));
        return;
      } catch {
        // If response isn't valid JSON, fall through to send as-is.
      }
    }
  }

  res
    .status(upstreamRes.status)
    .set("Content-Type", "application/json")
    .send(responseText);
}
