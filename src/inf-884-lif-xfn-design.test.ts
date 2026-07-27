/**
 * INF-884: LIF must be able to accept design-origin cross-functional requests.
 *
 * AC mapping:
 * - AC1: LIF exposes an applicable `xfn:design` label through the demotion
 *   helper's label lookup/resolution path.
 * - AC2: A non-owner design requester targeting LIF To Do is demoted to Backlog
 *   and carries both `cross-functional-request` and `xfn:design`.
 * - AC3: ENG, DSN, INF, AGI, GEN, GMS, and MDA keep their existing flat
 *   `xfn:design` demotion labels.
 * - AC4: The inherited-label conflict path for future `xfn:*` dimensions is
 *   documented or automated so one sub-team cannot be stranded silently.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";

type GraphQLCall = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
};

type Label = {
  id: string;
  name: string;
  team?: { id: string; key?: string } | null;
};

const TEAM_IDS = {
  AGI: "team-agi",
  DSN: "team-dsn",
  ENG: "team-eng",
  GEN: "team-gen",
  GMS: "team-gms",
  INF: "team-inf",
  LIF: "team-lif",
  MDA: "team-mda",
} as const;

const ALREADY_PROVISIONED_DESIGN_TEAMS = ["ENG", "DSN", "INF", "AGI", "GEN", "GMS", "MDA"] as const;

const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: human:escalate

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: design
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]
  - id: design
    requires: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: laren
    container: design
    fills_roles: [design]
`;

function writeAgents(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "u-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "laren", linearUserId: "u-laren", openclawAgent: "laren", accessToken: "tok-laren", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = path.join(dir, "agents.json");
}

function writePolicy(dir: string): void {
  fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function issueCreateInput(call: GraphQLCall): Record<string, unknown> {
  const input = call.variables.input;
  expect(input && typeof input === "object" && !Array.isArray(input)).toBe(true);
  return input as Record<string, unknown>;
}

function labelsForTeam(teamId: string): Label[] {
  const teamKey = Object.entries(TEAM_IDS).find(([, id]) => id === teamId)?.[0] ?? "UNK";
  const base = [{ id: `lbl-${teamKey.toLowerCase()}-cross-functional`, name: "cross-functional-request", team: { id: teamId, key: teamKey } }];

  if (teamId === TEAM_IDS.LIF) {
    return [
      ...base,
      // Live failure shape: Linear exposes the inherited parent label by name,
      // but using that parent-owned ID in a LIF issue mutation is rejected.
      { id: "lbl-gen-xfn-design-inherited", name: "xfn:design", team: { id: TEAM_IDS.GEN, key: "GEN" } },
    ];
  }

  return [
    ...base,
    { id: `lbl-${teamKey.toLowerCase()}-xfn-design`, name: "xfn:design", team: { id: teamId, key: teamKey } },
  ];
}

function makeLinearFetch(): { fetch: typeof globalThis.fetch; calls: GraphQLCall[] } {
  const calls: GraphQLCall[] = [];
  const createdLabels: Label[] = [];

  const fetchMock: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }

    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GraphQLCall;
    calls.push(parsed);
    const query = parsed.query ?? "";
    const vars = parsed.variables ?? {};

    if (query.includes("team") && query.includes("states")) {
      return json({
        data: {
          team: {
            states: {
              nodes: [
                { id: "s-backlog", name: "Backlog", type: "backlog" },
                { id: "s-todo", name: "To Do", type: "unstarted" },
              ],
            },
          },
        },
      });
    }

    if (query.includes("team") && query.includes("labels")) {
      const teamId = String(vars.teamId);
      return json({
        data: {
          team: {
            labels: {
              nodes: [...labelsForTeam(teamId), ...createdLabels.filter((label) => label.team?.id === teamId || label.team == null)],
            },
          },
        },
      });
    }

    if (query.includes("issueLabelCreate")) {
      const teamId = typeof vars.teamId === "string" ? vars.teamId : null;
      const name = String(vars.name);
      if (teamId === TEAM_IDS.LIF && name === "xfn:design") {
        return json({ errors: [{ message: "conflicting inherited label: GEN already owns xfn:design" }] });
      }
      const label = { id: `lbl-workspace-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, name, team: null };
      createdLabels.push(label);
      return json({ data: { issueLabelCreate: { success: true, issueLabel: { id: label.id } } } });
    }

    if (query.includes("issueCreate")) {
      const input = issueCreateInput(parsed);
      const labelIds = Array.isArray(input.labelIds) ? input.labelIds : [];
      if (labelIds.includes("lbl-gen-xfn-design-inherited")) {
        return json({ errors: [{ message: "labelIds contains a label that does not belong to the LIF team" }] });
      }
      return json({ data: { issueCreate: { success: true, issue: { id: "lif-884", identifier: "LIF-884" } } } });
    }

    if (query.includes("commentCreate")) {
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    }

    return json({ data: {} });
  };

  return { fetch: fetchMock, calls };
}

describe("INF-884 LIF xfn:design cross-functional demotion", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let calls: GraphQLCall[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-884-xfn-"));
    writeAgents(dir);
    writePolicy(dir);
    resetPolicyCache();
    resetWorkflowCache();
    resetConfigHealth();
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
      mutationAuditDbPath: path.join(dir, "audit.db"),
    });

    originalFetch = globalThis.fetch;
    const mock = makeLinearFetch();
    globalThis.fetch = mock.fetch;
    calls = mock.calls;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTS_FILE;
    delete process.env.CAPABILITY_POLICY_PATH;
  });

  async function createDesignRequest(teamId: string): Promise<Record<string, unknown>> {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-laren")
      .set("X-Openclaw-Agent", "laren")
      .set("Content-Type", "application/json")
      .send({
        query: `mutation CreateDesignRequest($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        variables: {
          input: {
            teamId,
            title: "Design request for owner triage",
            stateId: "s-todo",
            assigneeId: "u-laren",
            delegateId: "u-laren",
            labelIds: [],
          },
        },
        operationName: "CreateDesignRequest",
      });

    expect(res.body.errors).toBeUndefined();
    const create = calls.find((call) => call.query.includes("issueCreate"));
    expect(create).toBeDefined();
    return issueCreateInput(create!);
  }

  it("AC1+AC2: demotes a non-owner design request on LIF using an applicable LIF-safe xfn:design label", async () => {
    const input = await createDesignRequest(TEAM_IDS.LIF);

    expect(input.stateId).toBe("s-backlog");
    expect(input.assigneeId).toBeNull();
    expect(input.delegateId).toBeNull();
    expect(input.labelIds).toEqual(expect.arrayContaining(["lbl-lif-cross-functional"]));
    expect(input.labelIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^lbl-(lif|workspace)-xfn-design$/),
      ]),
    );
    expect(input.labelIds).not.toEqual(expect.arrayContaining(["lbl-gen-xfn-design-inherited"]));
  });

  it("AC3: preserves the already-provisioned xfn:design demotion path for ENG, DSN, INF, AGI, GEN, GMS, and MDA", async () => {
    for (const teamKey of ALREADY_PROVISIONED_DESIGN_TEAMS) {
      calls.length = 0;
      const input = await createDesignRequest(TEAM_IDS[teamKey]);

      expect(input.stateId).toBe("s-backlog");
      expect(input.labelIds).toEqual(
        expect.arrayContaining([
          `lbl-${teamKey.toLowerCase()}-cross-functional`,
          `lbl-${teamKey.toLowerCase()}-xfn-design`,
        ]),
      );
    }
  });

  it("AC4: documents or automates the inherited-label conflict path for future xfn dimensions", () => {
    const candidates = [
      "docs/linear-inherited-label-conflicts.md",
      "docs/xfn-label-provisioning.md",
      "skills/connector-ops/SKILL.md",
      "skills/connector-ops/scripts/provision-xfn-label.sh",
      "scripts/provision-xfn-labels.mjs",
    ];

    const evidence = candidates
      .filter((candidate) => fs.existsSync(path.join(process.cwd(), candidate)))
      .map((candidate) => fs.readFileSync(path.join(process.cwd(), candidate), "utf8"))
      .join("\n");

    expect(evidence).toMatch(/xfn:\*/i);
    expect(evidence).toMatch(/conflicting inherited label|inherited-label conflict/i);
    expect(evidence).toMatch(/LIF|sub-?team/i);
  });
});
