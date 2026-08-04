/**
 * INF-1176 — stale `cra` code-review resolver purge.
 *
 * AC coverage:
 * - AC-verify `code` resolves from live capability/agent config, not hardcoded `cra`.
 * - rescue-sweep resolves code-review from live config, not `cra`.
 * - resolver guard: unregistered agent ids are never returned as live delegates.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import { resolveVerifyOwner, type VerifyConfig } from "./ac-verify-resolver.js";
import { runRescueSweep } from "./rescue-sweep.js";

const CHARLES_UUID = "11111111-1111-4111-8111-111111111111";
const ASTRID_UUID = "22222222-2222-4222-8222-222222222222";

const DEV_IMPL_WITH_CODE_REVIEW = {
  id: "dev-impl",
  entry_state: "intake",
  states: [
    { id: "intake", owner_role: "steward" },
    { id: "code-review", owner_role: "code-review" },
    { id: "done" },
  ],
};

function writeAgentsFile(dir: string): string {
  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify(
      {
        agents: [
          {
            name: "charles",
            linearUserId: CHARLES_UUID,
            clientId: "client-charles",
            clientSecret: "secret-charles",
            accessToken: "token-charles",
            refreshToken: "refresh-charles",
            openclawAgent: "charles",
            host: "local",
          },
          {
            name: "astrid",
            linearUserId: ASTRID_UUID,
            clientId: "client-astrid",
            clientSecret: "secret-astrid",
            accessToken: "token-astrid",
            refreshToken: "refresh-astrid",
            openclawAgent: "astrid",
            host: "local",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return agentsFile;
}

function writeCapabilityPolicy(
  dir: string,
  codeReviewBodies: string[],
): string {
  const policyFile = path.join(dir, "capability-policy.yaml");
  const codeReviewBodyYaml = codeReviewBodies
    .map((id) => [
      `  - id: ${id}`,
      "    container: code-review",
      "    fills_roles: [code-review]",
    ].join("\n"))
    .join("\n");
  fs.writeFileSync(
    policyFile,
    [
      "bodies:",
      "  - id: astrid",
      "    container: steward",
      "    fills_roles: [steward]",
      codeReviewBodyYaml,
      "",
    ].join("\n"),
    "utf8",
  );
  return policyFile;
}

function makeLinearMock() {
  const delegateIdsSet: string[] = [];
  const issues = [
    {
      id: "issue-code-review-dormant",
      identifier: "INF-1176-D",
      labels: ["wf:dev-impl", "state:code-review"],
      delegateId: null as string | null,
    },
  ];

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};

    if (query.includes("WorkflowIssues") || query.includes("issues(")) {
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: issues.map((issue) => ({
                id: issue.id,
                identifier: issue.identifier,
                updatedAt: new Date(0).toISOString(),
                state: { name: "Doing" },
                labels: { nodes: issue.labels.map((name, i) => ({ id: `label-${i}`, name })) },
                delegate: issue.delegateId ? { id: issue.delegateId, name: issue.delegateId } : null,
                team: { id: "team-inf" },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("TeamLabels")) {
      return new Response(JSON.stringify({ data: { team: { labels: { nodes: [] } } } }), { status: 200 });
    }

    if (query.includes("RescueSeatGuard")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: variables.id,
              delegate: null,
              labels: { nodes: ["wf:dev-impl", "state:code-review"].map((name) => ({ name })) },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("issueUpdate") && query.includes("delegateId")) {
      const delegateId = String(variables.delegateId ?? "");
      delegateIdsSet.push(delegateId);
      const issue = issues.find((candidate) => candidate.id === variables.issueId || candidate.id === variables.id);
      if (issue) issue.delegateId = delegateId;
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: /^[0-9a-f-]{36}$/i.test(delegateId) } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (query.includes("VerifyDelegate")) {
      const issue = issues.find((candidate) => candidate.id === variables.issueId || candidate.id === variables.id);
      return new Response(
        JSON.stringify({ data: { issue: issue ? { delegate: issue.delegateId ? { id: issue.delegateId } : null } : null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`INF-1176 test received unexpected Linear query: ${query.slice(0, 100)}`);
  };

  return { fetch, delegateIdsSet };
}

describe("INF-1176 live code-review body resolvers", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-1176-"));
    originalFetch = globalThis.fetch;
    process.env.AGENTS_FILE = writeAgentsFile(dir);
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY;
    delete process.env.LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE;
    reloadAgents();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AGENTS_FILE;
    reloadAgents();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("AC1/AC3: AC-verify code dimension ignores stale cra and resolves to the registered code-review body", () => {
    const livePolicyPath = writeCapabilityPolicy(dir, ["charles"]);
    const configWithStaleCodeMap = {
      dimensionMap: { code: "cra", design: "laren" },
      defaultOwner: "astrid",
      capabilityPolicyPath: livePolicyPath,
      registeredAgentIds: ["astrid", "charles", "laren"],
    } as VerifyConfig & { capabilityPolicyPath: string; registeredAgentIds: string[] };

    const resolution = resolveVerifyOwner(["wf:dev-impl", "verify:code"], configWithStaleCodeMap);

    expect(configWithStaleCodeMap.registeredAgentIds).not.toContain("cra");
    expect(resolution).toMatchObject({
      owner: "charles",
      designated: true,
      source: "verify-label",
    });
    expect(configWithStaleCodeMap.registeredAgentIds).toContain(resolution.owner);
  });

  test("AC2/AC3: rescue-sweep filters stale unregistered cra and seats live code-review body from config", async () => {
    const policyPath = writeCapabilityPolicy(dir, ["cra", "charles"]);
    const { fetch, delegateIdsSet } = makeLinearMock();
    globalThis.fetch = fetch;

    const result = await runRescueSweep({
      authToken: "Bearer test-token",
      workflowRegistry: new Map([["dev-impl", DEV_IMPL_WITH_CODE_REVIEW]]),
      capabilityPolicyPath: policyPath,
    });

    expect(delegateIdsSet).toEqual([CHARLES_UUID]);
    expect(delegateIdsSet).not.toContain("cra");
    expect(result.rescued).toBe(1);
    expect(result.rescues[0]).toMatchObject({
      classification: "dormant",
      outcome: "rescued",
    });
  });
});
