import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { reloadAgents } from "./agents.js";
import { resetConfigHealth } from "./config-health.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { createApp } from "./index.js";
import { resetWorkflowCache } from "./workflow-gate.js";

const POLICY_YAML = `
capabilities:
  - id: linear:transition

containers:
  - id: dev
    grants: [linear:transition]

roles:
  - id: dev
    requires: [linear:transition]

bodies:
  - id: aidev
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
`;

const WORKFLOW_YAML = `
id: dev-impl
version: 1
archetype: single-task
entry_state: implementation
states:
  - id: implementation
    owner_role: dev
    kind: normal
    native_state: doing
    transitions:
      - command: handoff-work
        to: implementation
        requires_comment: true
`;

const ISSUE_ID = "issue-uuid";
/** Igor's declarations are addressed TO the caller (aidev) — it is aidev that owes the next disclosure. */
const MARKER_IGOR = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"b777e17","to":"u-aidev"} -->';
const MARKER_IGOR_LONG = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"b777e171234567890abcdef","to":"u-aidev"} -->';
/** Authored BY the caller — must never become the record the caller is measured against. */
const MARKER_CALLER = '<!-- artifact-disclosure: {"branch":"feature/own","sha":"abc1234","to":"u-hanzo"} -->';
/** Igor's SECOND, newer declaration — e.g. after a force-push/rebase. */
const MARKER_IGOR_NEWER = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"dd11cc2","to":"u-aidev"} -->';
/**
 * Igor's declaration addressed to a THIRD party — the caller was handed nothing
 * by it. Its sha is deliberately DISTINCT from every marker addressed to the
 * caller: with a shared sha, a guard that ignored `to` entirely would produce a
 * byte-identical refusal and the scan tests could not discriminate.
 */
const MARKER_TO_OTHER = '<!-- artifact-disclosure: {"branch":"feature/x","sha":"77aa33b","to":"u-kana"} -->';

function writeAgents(d: string): string {
  const file = path.join(d, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { name: "aidev", linearUserId: "u-aidev", openclawAgent: "aidev", accessToken: "tok-aidev", host: "local" },
        { name: "igor", linearUserId: "u-igor", openclawAgent: "igor", accessToken: "tok-igor", host: "local" },
      ],
    }),
    "utf8",
  );
  return file;
}

function issueContext(): object {
  return {
    data: {
      issue: {
        identifier: "AI-2479",
        labels: { nodes: [] },
        delegate: { id: "u-aidev" },
      },
    },
  };
}

type TestComment = { body: string; userId: string };

function makeFetch(opts: { comments?: TestComment[]; throwOnComments?: boolean } = {}): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const json = (payload: object) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const mockFetch: typeof globalThis.fetch = async (url, init) => {
    if (typeof url !== "string" || !url.includes("api.linear.app")) {
      throw new Error("unexpected non-Linear fetch in test");
    }
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(bodyText) as { query?: string; variables?: Record<string, unknown> };
    const q = parsed.query ?? "";
    calls.push({ query: q, variables: parsed.variables ?? {} });

    if (q.includes("IssueContext")) return json(issueContext());
    if (q.includes("ArtifactDisclosureComments")) {
      if (opts.throwOnComments) throw new Error("comment fetch exploded");
      return json({
        data: {
          issue: {
            comments: {
              nodes: (opts.comments ?? []).map((c) => ({
                body: c.body,
                user: { id: c.userId },
              })),
            },
          },
        },
      });
    }
    return json({ data: { issueUpdate: { success: true } } });
  };

  return { fetch: mockFetch, calls };
}

function handoffBody(delegateId = "u-igor") {
  return {
    operationName: "HandoffDelegate",
    query: `mutation HandoffDelegate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_ID, input: { delegateId } },
  };
}

/**
 * The exact mutation shape `executeTransition` sends for the CLI's two
 * self-delegating, intent-less verbs: `consider-work` and `manage-work`
 * (`delegateToSelf: true` + `clearAssignee` + a target state, and no
 * setProxyIntent call site on either).
 */
function selfDelegateBody(opName: string, selfId = "u-aidev") {
  return {
    operationName: opName,
    query: `mutation ${opName}($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_ID, input: { delegateId: selfId, stateId: "state-thinking", assigneeId: null } },
  };
}

function stateWriteBody() {
  return {
    operationName: "StateWrite",
    query: `mutation StateWrite($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    variables: { id: ISSUE_ID, input: { stateId: "state-doing" } },
  };
}

describe("proxy — AI-2479 artifact disclosure guard", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;
  let oldLinearOauthToken: string | undefined;
  let oldLinearApiKey: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ai2479-test-"));
    oldLinearOauthToken = process.env.LINEAR_OAUTH_TOKEN;
    oldLinearApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_OAUTH_TOKEN;
    delete process.env.LINEAR_API_KEY;
    process.env.AGENTS_FILE = writeAgents(dir);
    process.env.CAPABILITY_POLICY_PATH = path.join(dir, "capability-policy.yaml");
    fs.writeFileSync(path.join(dir, "capability-policy.yaml"), POLICY_YAML, "utf8");
    const wfFile = path.join(dir, "dev-impl.yaml");
    fs.writeFileSync(wfFile, WORKFLOW_YAML, "utf8");
    process.env.WORKFLOW_DEF_PATH = wfFile;

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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (oldLinearOauthToken === undefined) delete process.env.LINEAR_OAUTH_TOKEN;
    else process.env.LINEAR_OAUTH_TOKEN = oldLinearOauthToken;
    if (oldLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = oldLinearApiKey;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.mutationAuditStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.dispatchDeliveryScheduler.stop();
    appState.managingPoller.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function send(body: object, headers: Record<string, string> = {}) {
    let r = request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer tok-aidev")
      .set("X-Openclaw-Agent", "aidev");
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  }

  const forwardedMutations = (calls: Array<{ query: string }>) =>
    calls.filter((c) => c.query.includes("issueUpdate") && !c.query.includes("IssueContext")).length;

  // The comment fetch asks Linear for comments NEWEST FIRST
  // (`comments(first: 50, orderBy: createdAt)` returns descending — live-probed
  // 2026-07-16, and the CLI pairs the same query with a .reverse() to render
  // oldest-first). The guard takes the first marker it finds, so that ordering is
  // load-bearing: if it were ascending, the guard would silently compare against
  // the OLDEST declaration and refuse a truthful handoff.
  //
  // These two tests are the only thing standing in front of that. Every other
  // fixture has a single other-user marker, so ordering cannot discriminate and
  // reversing the scan passes the whole rest of the suite.
  describe("selects the most recent declaration, not the oldest", () => {
    // Mock order mirrors the API contract: index 0 is newest.
    const reDeclared = [
      { body: MARKER_IGOR_NEWER, userId: "u-igor" },
      { body: MARKER_IGOR, userId: "u-igor" },
    ];

    it("allows a declaration matching Igor's newest artifact", async () => {
      const mf = makeFetch({ comments: reDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@dd11cc2" });

      expect(res.body.errors).toBeUndefined();
      expect(forwardedMutations(mf.calls)).toBe(1);
    });

    it("blocks a declaration matching only Igor's superseded artifact", async () => {
      const mf = makeFetch({ comments: reDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

      expect(res.body.errors?.[0]?.message).toMatch(/blocked/);
      expect(res.body.errors?.[0]?.message).toContain("dd11cc2");
      expect(forwardedMutations(mf.calls)).toBe(0);
    });
  });

  it("AI-2476 shape: prior marker by Igor, different declaration, no reason blocks and does not forward", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@911ef85" });

    expect(res.status).toBe(200);
    expect(res.body.errors?.[0]?.message).toMatch(/blocked/);
    expect(forwardedMutations(mf.calls)).toBe(0);
  });

  it("declared substitution reason allows a different artifact and forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), {
      "X-Openclaw-Code-Artifact": "feature/x@911ef85",
      "X-Openclaw-Substitution-Reason": encodeURIComponent("reviewed replacement branch"),
    });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("declared artifact matching the recorded artifact forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("declared abbreviated sha matching recorded artifact forwards", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR_LONG, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "feature/x@b777e17" });

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("prior marker exists but caller declares nothing is refused with required echo", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors?.[0]?.message).toContain("this ticket was handed to you declaring artifact 'feature/x@b777e17'");
    expect(forwardedMutations(mf.calls)).toBe(0);
  });

  it("no prior marker anywhere forwards without declaration", async () => {
    const mf = makeFetch({ comments: [{ body: "ordinary comment", userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("only the caller's own prior markers exist, so nothing was handed by someone else", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_CALLER, userId: "u-aidev" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("non-delegate-change mutation does not engage the artifact guard", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(stateWriteBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("comment fetch failure fails open and forwards", async () => {
    const mf = makeFetch({ throwOnComments: true });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody());

    expect(res.body.errors).toBeUndefined();
    expect(forwardedMutations(mf.calls)).toBe(1);
  });

  it("unparseable declared artifact header is refused and names branch@sha form", async () => {
    const mf = makeFetch({ comments: [{ body: MARKER_IGOR, userId: "u-igor" }] });
    globalThis.fetch = mf.fetch;

    const res = await send(handoffBody(), { "X-Openclaw-Code-Artifact": "not-a-valid-artifact" });

    expect(res.body.errors?.[0]?.message).toMatch(/<branch>@<sha>/);
    expect(forwardedMutations(mf.calls)).toBe(0);
  });

  // ── Trigger shape (Ai's AI-2479 refusal) ──────────────────────────────────
  //
  // The guard hangs off `!intent`, and "intent-less delegate write" is a strict
  // SUPERSET of "handoff". These tests pin the two narrowing conditions that
  // make the trigger mean "handoff" and nothing else. If they go red, fix the
  // trigger — do NOT relax the assertion: every one of them is a live strand of
  // the workflow this feature exists to serve.
  describe("fires on handing work ON, not on taking work IN", () => {
    const igorDeclared = [{ body: MARKER_IGOR, userId: "u-igor" }];

    // The headline strand: Igor hands to Ai declaring an artifact, and Ai — the
    // validator this whole feature is built to police — cannot accept the
    // delegation. consider-work has no --code-artifact flag (index.ts), so the
    // remedy the refusal names is unreachable: the agent retries, gets the same
    // refusal, and the ticket has no forward exit.
    it("consider-work by the validator is allowed once a declaration exists", async () => {
      const mf = makeFetch({ comments: igorDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(selfDelegateBody("ConsiderWork"));

      expect(res.body.errors).toBeUndefined();
      expect(forwardedMutations(mf.calls)).toBe(1);
    });

    // manage-work is the third intent-less delegate writer. Ai's refusal named
    // consider-work only; enumerating the predicate rather than the reported
    // symptom is what surfaced this one (AI-2358's lesson).
    it("manage-work is allowed once a declaration exists", async () => {
      const mf = makeFetch({ comments: igorDeclared });
      globalThis.fetch = mf.fetch;

      const res = await send(selfDelegateBody("ManageWork"));

      expect(res.body.errors).toBeUndefined();
      expect(forwardedMutations(mf.calls)).toBe(1);
    });

    // A self-delegation skip must not become a laundering route: the caller
    // still owes a disclosure on the way OUT to a real recipient.
    it("still refuses an undeclared handoff to someone else after a self-delegation", async () => {
      const mf = makeFetch({ comments: igorDeclared });
      globalThis.fetch = mf.fetch;

      expect((await send(selfDelegateBody("ConsiderWork"))).body.errors).toBeUndefined();
      const res = await send(handoffBody("u-hanzo"));

      expect(res.body.errors?.[0]?.message).toMatch(/declares none/);
      expect(forwardedMutations(mf.calls)).toBe(1); // the consider-work only
    });
  });

  describe("obliges the recipient of a declaration, not every bystander", () => {
    // AC4, Ai's second victim: a declaration addressed to Kana must not oblige
    // the caller, who was handed nothing and reviewed nothing. Before the `to`
    // field the ONLY way past this refusal was to name an artifact you never
    // reviewed — a guard whose sole escape is echoing a string to get unstuck
    // teaches precisely the reflex this ticket exists to punish.
    it("allows an undeclared re-route by an agent the artifact was not handed to", async () => {
      const mf = makeFetch({ comments: [{ body: MARKER_TO_OTHER, userId: "u-igor" }] });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody("u-kana"));

      expect(res.body.errors).toBeUndefined();
      expect(forwardedMutations(mf.calls)).toBe(1);
    });

    // The scan must not stop at the newest marker: a declaration addressed to
    // someone else sits ABOVE the caller's own obligation in the timeline, and
    // skipping past it is what keeps the guard armed for the real recipient.
    it("keeps scanning past a newer declaration addressed to a third party", async () => {
      const mf = makeFetch({
        comments: [
          { body: MARKER_TO_OTHER, userId: "u-igor" },
          { body: MARKER_IGOR, userId: "u-igor" },
        ],
      });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody("u-hanzo"));

      expect(res.body.errors?.[0]?.message).toMatch(/feature\/x@b777e17/);
      expect(forwardedMutations(mf.calls)).toBe(0);
    });

    // Laundering: an agent must not be able to clear its obligation by
    // re-addressing the artifact to itself. Its own marker is skipped, so Igor's
    // original declaration underneath is still the one that binds.
    it("ignores a self-authored declaration addressed to self", async () => {
      const selfAddressed = '<!-- artifact-disclosure: {"branch":"feature/own","sha":"abc1234","to":"u-aidev"} -->';
      const mf = makeFetch({
        comments: [
          { body: selfAddressed, userId: "u-aidev" },
          { body: MARKER_IGOR, userId: "u-igor" },
        ],
      });
      globalThis.fetch = mf.fetch;

      const res = await send(handoffBody("u-hanzo"), { "X-Openclaw-Code-Artifact": "feature/own@abc1234" });

      expect(res.body.errors?.[0]?.message).toMatch(/substitution-reason/);
      expect(forwardedMutations(mf.calls)).toBe(0);
    });
  });
});
