/**
 * AI-1914 — AC2 + AC5 (steward-blocked): the `migrate-state <id> <target>`
 * fallback verb.
 *
 * AC2: a `migrate-state` command, capability-gated to `workflow:break-glass`
 * and audited like escape, performs a targeted non-lossy migration when no map
 * exists. Target must be a state in the live def; delegate is set per the target
 * state's owner role.
 *
 * AC5: the steward verb must be PROVEN blocked for non-steward callers.
 *
 * Transport contract (implementer conforms): the CLI sends the workflow intent
 * `migrate-state` with the target state carried in the `X-Openclaw-Migrate-Target`
 * header. The gate authorizes on the `workflow:break-glass` capability.
 *
 * These tests exercise the real proxy (`POST /proxy/graphql`) and are RED until
 * the verb exists: today `migrate-state` is an unknown intent, so a steward's
 * request is rejected (must become allowed) and a non-steward's rejection does
 * not name the verb / capability gate (must become a capability denial).
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { resetWorkflowCache } from "./workflow-gate.js";
import { resetConfigHealth } from "./config-health.js";

// astrid = steward (workflow:break-glass); hanzo = deployment role (NO break-glass).
const POLICY_YAML = `
capabilities:
  - id: linear:transition
  - id: workflow:break-glass
  - id: deploy:execute
containers:
  - id: steward
    grants: [linear:transition, workflow:break-glass]
  - id: deployment
    grants: [linear:transition, deploy:execute]
roles:
  - id: steward
    requires: [workflow:break-glass]
  - id: deployment
    requires: [deploy:execute]
bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
`;

// Live dev-impl def WITHOUT `deployment` — a ticket at state:deployment is the
// stranded, no-map case that migrate-state exists to rescue.
const WORKFLOW_YAML = `
id: dev-impl
version: 14
entry_state: intake
break_glass:
  command: escape
  to: escape
  owner_role: steward
states:
  - id: intake
    owner_role: steward
    native_state: todo
    transitions:
      - command: accept
        to: implementation
  - id: implementation
    owner_role: dev
    native_state: doing
    transitions:
      - command: submit
        to: ac-validate
  - id: merge
    owner_role: deployment
    native_state: doing
    transitions:
      - command: continue
        to: deploy
        generic: continue
        requires_capability: deploy:execute
  - id: deploy
    owner_role: host-deploy
    native_state: doing
    transitions:
      - command: continue
        to: ac-validate
        generic: continue
  - id: ac-validate
    owner_role: steward
    native_state: doing
    transitions:
      - command: validated
        to: done
  - id: done
    native_state: done
    transitions: []
  - id: escape
    native_state: invalid
    transitions: []
`;

const DEFUNCT_TICKET_RESPONSE = {
  data: {
    issue: {
      labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:deployment" }] },
      delegate: { id: "user-hanzo" },
    },
  },
};

// Full issue shape returned by setStateAtomic's fetchIssueWithLabels (IssueWithLabels
// query). The ticket is stranded at state:deployment (a defunct state with no map),
// which is the case migrate-state exists to rescue.
const DEFUNCT_ISSUE_WITH_LABELS = {
  data: {
    issue: {
      id: "issue-1857",
      identifier: "INF-1857",
      creator: { id: "user-matt" },
      title: "Stranded ticket",
      description: "",
      team: { id: "team-1", key: "INF", name: "Infra" },
      labels: {
        nodes: [
          { id: "lbl-wf", name: "wf:dev-impl", team: { id: "team-1" } },
          { id: "lbl-deployment", name: "state:deployment", team: { id: "team-1" } },
        ],
      },
      delegate: { id: "user-hanzo" },
      assignee: null,
      state: { id: "native-doing", name: "In Progress", type: "started" },
    },
  },
};

const MOCK_MUTATION_SUCCESS = { data: { issueUpdate: { success: true } } };

const MIGRATE_MUTATION = {
  query: "mutation M($id: String!) { issueUpdate(id: $id, input: { labelIds: [\"lbl-acvalidate\"] }) { success } }",
  variables: { id: "issue-1857" },
};

let dir: string;
let appState: ReturnType<typeof createApp>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-1914-migrate-"));

  const agentsFile = path.join(dir, "agents.json");
  fs.writeFileSync(
    agentsFile,
    JSON.stringify({
      agents: [
        { name: "astrid", linearUserId: "user-astrid", openclawAgent: "astrid", accessToken: "tok-astrid", host: "local" },
        { name: "hanzo", linearUserId: "user-hanzo", openclawAgent: "hanzo", accessToken: "tok-hanzo", host: "local" },
      ],
    }),
    "utf8",
  );
  process.env.AGENTS_FILE = agentsFile;

  const policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;

  const defFile = path.join(dir, "dev-impl.yaml");
  fs.writeFileSync(defFile, WORKFLOW_YAML, "utf8");
  process.env.WORKFLOW_DEF_PATH = defFile;
  delete process.env.WORKFLOW_DEFS_DIR;

  resetPolicyCache();
  resetWorkflowCache();
  resetConfigHealth();
  reloadAgents();

  appState = createApp({
    bagDbPath: path.join(dir, "bag.db"),
    agentQueueDbPath: path.join(dir, "queue.db"),
    operationalEventsDbPath: path.join(dir, "events.db"),
  });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  appState.bag.close();
  appState.sessionTracker.close();
  appState.agentQueue.close();
  appState.operationalEventStore.close();
  appState.watchdog.stop();
  appState.noActivityDetector.stop();
  appState.managingPoller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_FILE;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.WORKFLOW_DEF_PATH;
});

// Post-write issue shape: after the atomic issueUpdate lands, the verification
// re-fetch (IssueWithLabels) must read back the MIGRATED state so the write verifies.
const MIGRATED_ISSUE_WITH_LABELS = {
  data: {
    issue: {
      id: "issue-1857",
      identifier: "INF-1857",
      creator: { id: "user-matt" },
      title: "Stranded ticket",
      description: "",
      team: { id: "team-1", key: "INF", name: "Infra" },
      labels: {
        nodes: [
          { id: "lbl-wf", name: "wf:dev-impl", team: { id: "team-1" } },
          { id: "lbl-acvalidate", name: "state:ac-validate", team: { id: "team-1" } },
        ],
      },
      delegate: { id: "user-astrid" },
      assignee: null,
      state: { id: "native-doing", name: "In Progress", type: "started" },
    },
  },
};

function makeFetch(labelResponse: object, mutationResponse = MOCK_MUTATION_SUCCESS): typeof globalThis.fetch {
  // Track whether the atomic issueUpdate write has landed. Before it does,
  // IssueWithLabels returns the defunct (pre-migration) shape; after it lands,
  // the verification re-fetch returns the migrated shape so the write verifies.
  let writeLanded = false;
  return (async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      return originalFetch(url as never, init);
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsed = bodyText ? (JSON.parse(bodyText) as { query?: string }) : {};
    // setStateAtomic's fetchIssueWithLabels (and the atomic write's verification
    // re-fetch) use the IssueWithLabels query — return the full issue shape.
    if (parsed.query?.includes("IssueWithLabels")) {
      const shape = writeLanded ? MIGRATED_ISSUE_WITH_LABELS : DEFUNCT_ISSUE_WITH_LABELS;
      return new Response(JSON.stringify(shape), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // setStateAtomic's read-after-write consistency check uses VerifyTransitionWrite
    // (labels/delegate/state by id) — a distinct query from IssueWithLabels. After
    // the atomic write lands, return the migrated shape so the write verifies.
    if (parsed.query?.includes("VerifyTransitionWrite") || parsed.query?.includes("PreAuthWriteCheck")) {
      const migrated = MIGRATED_ISSUE_WITH_LABELS.data.issue;
      const defunct = DEFUNCT_ISSUE_WITH_LABELS.data.issue;
      const src = writeLanded ? migrated : defunct;
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: src.labels.nodes.map((l) => ({ name: l.name })) },
              delegate: src.delegate ? { id: src.delegate.id } : null,
              assignee: null,
              state: src.state,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // findOrCreateLabel's TeamLabels lookup — return the existing labels plus the
    // target state:ac-validate label so resolution succeeds without a create.
    if (parsed.query?.includes("TeamLabels")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: "lbl-wf", name: "wf:dev-impl", isGroup: false, team: { id: "team-1" }, parent: null },
                  { id: "lbl-deployment", name: "state:deployment", isGroup: false, team: { id: "team-1" }, parent: null },
                  { id: "lbl-acvalidate", name: "state:ac-validate", isGroup: false, team: { id: "team-1" }, parent: null },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // resolveNativeStateId's TeamStates lookup — return the native states so 'doing'
    // resolves to a native state id.
    if (parsed.query?.includes("TeamStates")) {
      return new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "native-todo", name: "Todo", type: "unstarted" },
                  { id: "native-doing", name: "In Progress", type: "started" },
                  { id: "native-done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.query?.includes("IssueContext") || parsed.query?.includes("IssueLabels") || parsed.query?.includes("delegate")) {
      return new Response(JSON.stringify(labelResponse), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // The atomic write's post-write verification re-fetch (VerifyTransitionWrite) —
    // return the migrated shape so the write verifies (labels + delegate + native state).
    if (parsed.query?.includes("VerifyTransitionWrite")) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              labels: { nodes: [{ name: "wf:dev-impl" }, { name: "state:ac-validate" }] },
              delegate: { id: "user-astrid" },
              assignee: null,
              state: { id: "native-doing" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // The atomic issueUpdate mutation — mark the write as landed so the next
    // IssueWithLabels verification re-fetch returns the migrated shape.
    if (parsed.query?.includes("issueUpdate")) {
      writeLanded = true;
    }
    return new Response(JSON.stringify(mutationResponse), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
}

describe("AC2: migrate-state is capability-gated to workflow:break-glass", () => {
  it("AC5: rejects migrate-state from a non-steward body (hanzo/deployment — no break-glass)", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-hanzo")
      .set("X-Openclaw-Agent", "hanzo")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    // The rejection must be a CAPABILITY denial that identifies the caller as not
    // holding workflow:break-glass — mirroring the existing break-glass identity
    // gate ("caller 'x' is not the recovery steward"). The current defunct-state
    // message (which merely says "contact a steward") names neither the caller nor
    // the capability, so this is RED today and GREEN only once the gate exists.
    const msg = res.body.errors[0].message as string;
    expect(msg).toMatch(/steward|break.glass|capabilit|authoriz/i);
    expect(msg).toMatch(/hanzo|caller|not authoriz|only the steward|workflow:break-glass/i);
  });

  it("allows migrate-state from a steward body (astrid) — the sanctioned non-lossy path", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    // A steward migrating a stranded ticket to a live state must NOT be rejected.
    expect(res.body.errors).toBeUndefined();
  });

  it("rejects migrate-state whose target is not a state in the live def (even for a steward)", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "no-such-state")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/target|not a (valid|live|known) state|no-such-state/i);
  });
});

describe("INF-1268: migrate-state routes through the atomic write path", () => {
  it("records the migrated state in the applied-state store (no desync)", async () => {
    const { getAppliedState } = await import("./store/applied-state-store.js");
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      .set("X-Openclaw-Migrate-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    // The atomic write path returns a structured migrateState result.
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
    // The authoritative applied-state store must reflect the migration target so the
    // next governed command reads the new state (not the stale pre-migration label).
    expect(getAppliedState("INF-1857")).toBe("ac-validate");
  });

  it("AC5: accepts the target via the generic X-Openclaw-Linear-Target header (CLI transition verb)", async () => {
    globalThis.fetch = makeFetch(DEFUNCT_TICKET_RESPONSE);
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-astrid")
      .set("X-Openclaw-Agent", "astrid")
      .set("X-Openclaw-Linear-Intent", "migrate-state")
      // No X-Openclaw-Migrate-Target — the CLI's generic transition verb sends the
      // target in X-Openclaw-Linear-Target instead.
      .set("X-Openclaw-Linear-Target", "ac-validate")
      .send(MIGRATE_MUTATION);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.migrateState?.to).toBe("ac-validate");
  });
});
