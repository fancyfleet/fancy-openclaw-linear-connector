import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../index.js";
import { resetWorkflowCache, resetNativeStateCache } from "../workflow-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { reloadAgents } from "../agents.js";

/**
 * INF-474/475: sprint-workflow end-to-end integration-test harness.
 * Drives a full spawner cycle and asserts canonical hierarchy.
 */

const MOCK_TEAM_ID = "team-fancymatt";
const MOCK_TOKEN = "mock-token";
const ASTRID_ID = "astrid-uuid";

describe("INF-474/475: sprint-workflow e2e integration-test harness", () => {
  let tmpDir: string;
  let defsDir: string;
  let dataDir: string;
  let app: any;
  let mockFetch: jest.Mock<typeof fetch>;
  
  // Mock state store
  const ticketStates = new Map<string, string>();
  const ticketWorkflows = new Map<string, string>();
  const ticketNativeStates = new Map<string, string>();
  let harnessGreen = true;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-475-e2e-"));
    defsDir = path.join(tmpDir, "defs");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(defsDir);
    fs.mkdirSync(dataDir);

    // Setup environment for the connector
    process.env.WORKFLOW_DEFS_DIR = defsDir;
    process.env.DATA_DIR = dataDir;
    process.env.LOG_LEVEL = "info";
    process.env.ADMIN_SECRET = "test-secret";
    process.env.CAPABILITY_POLICY_PATH = path.join(tmpDir, "policy.yaml");
    process.env.LINEAR_OAUTH_TOKEN = MOCK_TOKEN;

    const agentsFile = path.join(tmpDir, "agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: [
        {
          name: "astrid",
          linearUserId: ASTRID_ID,
          accessToken: MOCK_TOKEN,
          refreshToken: "mock-refresh",
          status: "active"
        },
        {
          name: "ai",
          linearUserId: "ai-uuid",
          accessToken: MOCK_TOKEN,
          refreshToken: "mock-refresh",
          status: "active"
        }
      ]
    }), "utf8");
    process.env.AGENTS_FILE = agentsFile;
    reloadAgents();

    // Minimal policy
    fs.writeFileSync(process.env.CAPABILITY_POLICY_PATH, `
capabilities:
  - id: linear:transition
  - id: sprint:signoff
containers:
  - id: workflow
    grants: [linear:transition, sprint:signoff]
bodies:
  - id: astrid
    container: workflow
    fills_roles: [steward]
`, "utf8");

    // Copy canonical defs to tmpDir
    const repoRoot = process.cwd();
    const defSourceDir = path.join(repoRoot, "src/registered-defs");
    const defFiles = [
      "sprint-spawner.yaml",
      "sprint-scoping.yaml",
      "dev-sprint.yaml",
      "task.yaml",
      "dev-impl.yaml",
      "sprint-arm-scope.yaml"
    ];

    for (const f of defFiles) {
      const content = fs.readFileSync(path.join(defSourceDir, f), "utf8");
      fs.writeFileSync(path.join(defsDir, f), content);
    }

    mockFetch = jest.fn() as jest.Mock<typeof fetch>;
    global.fetch = mockFetch;

    app = createApp({
      bagDbPath: path.join(dataDir, "bag.db"),
      agentQueueDbPath: path.join(dataDir, "queue.db"),
    });

    // Set up a permanent dynamic mock
    mockFetch.mockImplementation(async (url: any, init?: any) => {
      const body = JSON.parse(init?.body || "{}");
      const query = body.query || "";
      const variables = body.variables || {};

      const resolveId = (id: string) => id && id.startsWith("uuid-") ? id.replace("uuid-", "") : id;

      const getLabels = (id: string) => {
        const lookupId = resolveId(id);
        const stateId = ticketStates.get(lookupId) || "evaluating";
        const wfId = ticketWorkflows.get(lookupId) || "wf:sprint-spawner";
        const labels = [
          { name: wfId },
          { name: `state:${stateId}` }
        ];
        if (lookupId === "INF-196" && harnessGreen) labels.push({ name: "harness-green" });
        return labels;
      };

      if (query.includes("query IssueContext")) {
         const id = variables.id;
         return { ok: true, status: 200, json: async () => ({ data: { issue: { identifier: id, labels: { nodes: getLabels(id) }, delegate: { id: ASTRID_ID } } } }) } as any;
      }
      if (query.includes("query IssueWithLabels")) {
         const id = variables.id;
         return { ok: true, status: 200, json: async () => ({ data: { issue: { id: "uuid-" + id, internalId: "uuid-" + id, identifier: id, team: { id: MOCK_TEAM_ID }, labels: { nodes: getLabels(id).map((l, i) => ({ ...l, id: `l${i}` })) } } } }) } as any;
      }
      if (query.includes("query IssueLabels")) {
         const id = variables.id;
         return { ok: true, status: 200, json: async () => ({ data: { issue: { labels: { nodes: getLabels(id) } } } }) } as any;
      }
      if (query.includes("query IssueTeamParent")) {
         const id = variables.id;
         const lookupId = resolveId(id);
         if (lookupId === "SPRINT-1" || lookupId === "sprint-uuid") {
            return { ok: true, status: 200, json: async () => ({ data: { issue: { id: "sprint-uuid", internalId: "sprint-uuid", identifier: "SPRINT-1", title: "Cycle 7 Sprint", description: "## Structured\n- [wf:sprint-arm-scope] Research Task", team: { id: MOCK_TEAM_ID }, labels: { nodes: [{ name: "wf:dev-sprint" }] } } } }) } as any;
         }
         return { ok: true, status: 200, json: async () => ({ data: { issue: { id: "spawner-uuid", internalId: "spawner-uuid", identifier: "INF-196", title: "Spawner", description: "## structured\n- [wf:sprint-scoping] Cycle 7 Scoping\n\n## sprint\n- **Cycle 7 Sprint**", team: { id: MOCK_TEAM_ID }, labels: { nodes: getLabels(id) } } } }) } as any;
      }
      if (query.includes("query TeamLabels")) {
         return { ok: true, status: 200, json: async () => ({ data: { team: { labels: { nodes: [
            { id: "wf-scoping", name: "wf:sprint-scoping" },
            { id: "wf-dev-sprint", name: "wf:dev-sprint" },
            { id: "wf-arm-scope", name: "wf:sprint-arm-scope" },
            { id: "state-intake", name: "state:intake" },
            { id: "state-scanning", name: "state:scanning" },
            { id: "state-determining-scope", name: "state:determining-scope" },
            { id: "state-spawning-scope", name: "state:spawning-scope" },
            { id: "state-scoping", name: "state:scoping" },
            { id: "state-launching", name: "state:launching" },
            { id: "state-managing", name: "state:managing" },
            { id: "state-todo", name: "state:todo" }
         ] } } } }) } as any;
      }
      if (query.includes("query TeamStates")) {
         return { ok: true, status: 200, json: async () => ({ data: { team: { states: { nodes: [
            { id: "s-todo", name: "To Do", type: "todo" },
            { id: "s-doing", name: "Doing", type: "doing" },
            { id: "s-managing", name: "Managing", type: "managing" }
         ] } } } }) } as any;
      }
      if (query.includes("query IssueChildren")) {
         const lookupId = resolveId(variables.id);
         if (lookupId === "sprint-uuid" || lookupId === "SPRINT-1") {
            return { ok: true, status: 200, json: async () => ({ data: { issue: { children: { nodes: [{ id: "scope-uuid", title: "Scope" }, { id: "impl-uuid", title: "Implementation" }, { id: "val-uuid", title: "Validation" }] } } } }) } as any;
         }
         // Freshly created 'new-id' has no children initially
         return { ok: true, status: 200, json: async () => ({ data: { issue: { children: { nodes: [] } } } }) } as any;
      }
      if (query.includes("query VerifyTransitionWrite")) {
         const id = variables.id;
         const lookupId = resolveId(id);
         const nativeStateId = ticketNativeStates.get(lookupId) || "s-todo";
         return { ok: true, status: 200, json: async () => ({ data: { issue: { labels: { nodes: getLabels(id) }, delegate: { id: ASTRID_ID }, state: { id: nativeStateId } } } }) } as any;
      }

      // Default empty success for mutations
      if (query.trim().startsWith("mutation")) {
        if (query.includes("issueUpdate")) {
           const id = variables.id || variables.issueId || (query.match(/id:\s*"([^"]+)"/) || [])[1];
           const labelIds = variables.input?.labelIds || variables.labelIds;
           const stateId = variables.input?.stateId || variables.stateId;
           
           if (id) {
              const lookupId = resolveId(id);
              if (labelIds) {
                 const stateLabelId = labelIds.find((l: string) => l.startsWith("state-"));
                 if (stateLabelId) {
                    ticketStates.set(lookupId, stateLabelId.replace("state-", ""));
                 }
              }
              if (stateId) {
                 ticketNativeStates.set(lookupId, stateId);
              }
           }
        }

        const data = {
          success: true,
          issueCreate: { success: true, issue: { id: "new-id", identifier: "NEW-1" } },
          issueUpdate: { success: true },
          commentCreate: { success: true }
        };
        return { ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) } as any;
      }

      return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => JSON.stringify({ data: {} }) } as any;
    });
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetWorkflowCache();
    resetPolicyCache();
    resetNativeStateCache();
    _resetAppliedStateStore();
    ticketStates.clear();
    ticketWorkflows.clear();
    ticketNativeStates.clear();
    harnessGreen = true;
  });

  async function waitForCalls(count: number, queryInclude: string, timeout = 5000): Promise<any[]> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const calls = mockFetch.mock.calls.filter(c => {
        const body = JSON.parse(c[1]?.body as string);
        return (body.query?.includes(queryInclude) || body.operationName?.includes(queryInclude));
      });
      if (calls.length >= count) return calls;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const actual = mockFetch.mock.calls.filter(c => {
      const body = JSON.parse(c[1]?.body as string);
      return (body.query?.includes(queryInclude) || body.operationName?.includes(queryInclude));
    }).length;
    throw new Error(`Timed out waiting for ${count} calls to ${queryInclude} (actual: ${actual})`);
  }

  it("drives a full spawner-to-sprint-to-arms cycle and asserts canonical hierarchy", async () => {
    const spawnerId = "INF-196";

    // --- PHASE A: Readiness Guard ---
    harnessGreen = false;
    ticketStates.set(spawnerId, "evaluating");
    ticketWorkflows.set(spawnerId, "wf:sprint-spawner");
    const resGuard = await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "proceed")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-scanning"] } }
      });

    expect(resGuard.body.errors?.[0]?.message).toContain("spawner is frozen until the integration-test harness is green");

    // --- PHASE B: Full Lifecycle (evaluating -> scoping) ---
    harnessGreen = true;
    
    // 1. evaluating -> scanning
    ticketStates.set(spawnerId, "evaluating");
    ticketNativeStates.set(spawnerId, "s-todo");
    await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "proceed")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-scanning"] } }
      });
    expect(ticketStates.get(spawnerId)).toBe("scanning");

    // 2. scanning -> determining-scope
    _resetAppliedStateStore();
    await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "collect")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-determining-scope"] } }
      });
    expect(ticketStates.get(spawnerId)).toBe("determining-scope");

    // 3. determining-scope -> spawning-scope
    _resetAppliedStateStore();
    await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "propose-brief")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-spawning-scope"] } }
      });
    expect(ticketStates.get(spawnerId)).toBe("spawning-scope");

    // 4. spawning-scope (fire fanout) -> scoping
    _resetAppliedStateStore();
    await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "spawn")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-scoping"] } }
      });
    expect(ticketStates.get(spawnerId)).toBe("scoping");

    const createCallsScoping = await waitForCalls(1, "issueCreate");
    expect(JSON.parse(createCallsScoping[0][1].body).variables.input.title).toBe("Cycle 7 Scoping");

    // --- PHASE C: launching -> managing (Sprint + Skeleton) ---
    // Manually advance mock state to 'launching' as if scoping finished
    ticketStates.set(spawnerId, "launching");
    _resetAppliedStateStore();
    mockFetch.mockClear();
    
    await request(app.app)
      .post("/proxy/graphql")
      .set("x-openclaw-agent", "astrid")
      .set("x-openclaw-linear-intent", "spawn")
      .set("x-openclaw-linear-cli-version", "0.3.5")
      .set("authorization", `Bearer ${MOCK_TOKEN}`)
      .send({ 
         query: `mutation ApplyState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
         variables: { id: spawnerId, input: { labelIds: ["state-managing"] } }
      });
    
    expect(ticketStates.get(spawnerId)).toBe("managing");

    // We expect 1 (Sprint) + 3 (Skeleton) = 4 issueCreate calls
    const createCallsSprint = await waitForCalls(4, "issueCreate");
    const allCreatedTitles = createCallsSprint.map(c => {
       const b = JSON.parse(c[1].body);
       return b.variables.input?.title || b.variables.title;
    });
    
    expect(allCreatedTitles).toContain("Cycle 7 Sprint");
    expect(allCreatedTitles).toContain("Scope");
    expect(allCreatedTitles).toContain("Implementation");
    expect(allCreatedTitles).toContain("Validation");

    // --- PHASE D: Arm Fan-out re-parenting ---
    mockFetch.mockClear();
    const { executeFanout } = await import("../fanout.js");
    await executeFanout("sprint-uuid", MOCK_TOKEN, {
       spec_source: "structured",
       child_workflow: "wf:sprint-arm-scope"
    }, { skipPreview: true });

    const armCreateCalls = await waitForCalls(1, "CreateChild");
    expect(JSON.parse(armCreateCalls[0][1].body).variables.input.parentId).toBe("scope-uuid");
  }, 30000);

  it("handles Backlog pull-in re-parenting", async () => {
    ticketStates.set("task-uuid", "todo");
    ticketWorkflows.set("task-uuid", "wf:task");
    ticketWorkflows.set("sprint-uuid", "wf:dev-sprint");
    ticketStates.set("sprint-uuid", "managing");

    const webhookPayload = {
      type: "Issue",
      action: "update",
      data: {
        id: "task-uuid",
        identifier: "TASK-1",
        parentId: "sprint-uuid",
        teamKey: "AI"
      },
      updatedFrom: {
        parentId: null
      }
    };

    await request(app.app)
      .post("/")
      .set("linear-event", "Issue")
      .send(webhookPayload);

    const updateParentCalls = await waitForCalls(1, "UpdateParent");
    expect(JSON.parse(updateParentCalls[0][1].body).variables.parentId).toBe("impl-uuid");
  });
});
