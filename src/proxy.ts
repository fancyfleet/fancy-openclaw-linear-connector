/**
 * GraphQL pass-through proxy — Phase 0B, design.md §4.6.
 *
 * Sits between the Linear CLI and api.linear.app. v0 is transparent:
 * every request is forwarded unchanged so the proxy can be validated as
 * load-bearing before any enforcement logic is added.
 *
 * Future phases add outbound instruction injection (§4.6 outbound) and
 * inbound command validation (§4.6 inbound) scoped to workflow tickets.
 */

import type { Request, Response } from "express";
import { componentLogger, createLogger } from "./logger.js";

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
 * Best-effort extraction of ticket identifier(s) from a GraphQL request.
 * Looks for common variable names that carry Linear issue identifiers.
 */
function extractTicketContext(body: GraphQLRequestBody | null): string {
  if (!body?.variables) return "";
  const vars = body.variables;
  for (const key of ["id", "issueId", "identifier"]) {
    const v = vars[key];
    if (typeof v === "string" && v.length > 0) return ` ticket=${v}`;
  }
  return "";
}

export async function handleProxyRequest(req: Request, res: Response): Promise<void> {
  const authorization = req.headers["authorization"];
  if (!authorization) {
    res.status(401).json({ errors: [{ message: "Missing Authorization header" }] });
    return;
  }

  const agentId = req.headers["x-openclaw-agent"] ?? "unknown";
  const body = parseBody(req);
  const opName = body?.operationName ?? "(unnamed)";
  const ticketCtx = extractTicketContext(body);

  log.info(`forward agent=${agentId} op=${opName}${ticketCtx}`);

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

  res
    .status(upstreamRes.status)
    .set("Content-Type", "application/json")
    .send(responseText);
}
