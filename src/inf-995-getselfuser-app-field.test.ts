import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

type LinearCall = { query: string; variables?: Record<string, unknown> };
type UpdateCall = { issueId: string; input: Record<string, unknown> };
type Harness = {
  calls: LinearCall[];
  updateCalls: UpdateCall[];
};

declare global {
  // eslint-disable-next-line no-var
  var __INF995_CLI_HARNESS__: Harness | undefined;
}

const requireFromTest = createRequire(import.meta.url);

function stubLinearModules(packageDir: string): void {
  const distDir = path.join(packageDir, "dist");

  fs.writeFileSync(
    path.join(distDir, "client.js"),
    `
exports.setProxyIntent = () => {};
exports.setProxyTarget = () => {};
exports.linearGraphQL = async (query, variables) => {
  const harness = globalThis.__INF995_CLI_HARNESS__;
  harness.calls.push({ query, variables });
  if (query.includes("GetSelfUser")) {
    return { viewer: { id: "u-tdd-app", name: "TDD", email: "tdd@example.test", app: true } };
  }
  return {};
};
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(distDir, "issues.js"),
    `
const baseIssue = {
  id: "issue-uuid",
  identifier: "INF-995",
  title: "app-user delegate regression",
  description: "",
  team: { id: "team-infra", key: "INF", name: "Infrastructure" },
  state: { id: "state-todo", name: "To Do", type: "unstarted" },
  assignee: null,
  delegate: { id: "u-tdd-app", name: "TDD", app: true },
  labels: [],
};
exports.getIssue = async () => ({ ...baseIssue });
exports.updateIssue = async (issueId, input) => {
  const harness = globalThis.__INF995_CLI_HARNESS__;
  harness.updateCalls.push({ issueId, input });
  return {
    ...baseIssue,
    state: input.stateId ? { id: input.stateId, name: input.stateId === "state-thinking" ? "Thinking" : "Managing", type: "started" } : baseIssue.state,
    assignee: input.assigneeId === null ? null : baseIssue.assignee,
    delegate: input.delegateId ? { id: input.delegateId, name: "TDD", app: true } : baseIssue.delegate,
  };
};
exports.addComment = async () => ({
  issueId: "INF-995",
  commentId: "comment-1",
  commentUrl: "https://linear.test/comment-1",
  commentCreatedAt: "2026-07-29T00:00:00.000Z",
  commentBodyLength: 12,
});
exports.resolveUserWithHints = async (name) => ({ id: "u-" + String(name).toLowerCase(), name, app: true });
exports.findUserByName = exports.resolveUserWithHints;
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(distDir, "states.js"),
    `
exports.SEMANTIC_STATE_MAP = { thinking: ["thinking"], managing: ["managing"] };
exports.findSemanticState = async (_teamId, semantic) => ({ id: "state-" + semantic, name: semantic === "thinking" ? "Thinking" : "Managing", type: "started" });
exports.findStateByName = async (_teamId, name) => ({ id: "state-" + String(name).toLowerCase(), name, type: "started" });
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(distDir, "boards.js"),
    "exports.getComments = async () => []; exports.getIssueHistory = async () => [];",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "labels.js"),
    "exports.resolveLabelIds = async (_teamId, labels) => labels.map((label) => `label-${label}`);",
    "utf8",
  );
  fs.writeFileSync(
    path.join(distDir, "matt-escalation-guard.js"),
    "exports.isMattTarget = () => false; exports.checkMattEscalation = () => null; exports.logRefusal = async () => {}; exports.formatRefusalError = () => '';",
    "utf8",
  );
}

function loadVendoredCli() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-995-cli-"));
  const tarball = path.join(process.cwd(), "vendor", "fancy-openclaw-linear-skill-cli-0.3.5.tgz");
  execFileSync("tar", ["-xzf", tarball, "-C", tempDir]);
  const packageDir = path.join(tempDir, "package");
  stubLinearModules(packageDir);
  const auth = requireFromTest(path.join(packageDir, "dist", "auth.js")) as {
    getSelfUser: () => Promise<{ id: string; name: string; email?: string; app?: boolean }>;
  };
  const semantic = requireFromTest(path.join(packageDir, "dist", "semantic.js")) as {
    considerWork: (issueId: string, options?: { force?: boolean }) => Promise<unknown>;
    manageWork: (issueId: string, options?: { comment?: string }) => Promise<unknown>;
  };
  return { tempDir, auth, semantic };
}

describe("INF-995: getSelfUser app field keeps app-user self-delegation persistent", () => {
  let tempDir: string | undefined;
  const originalLinearApiKey = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    process.env.LINEAR_API_KEY = "linear-test-token";
    globalThis.__INF995_CLI_HARNESS__ = { calls: [], updateCalls: [] };
  });

  afterEach(() => {
    if (originalLinearApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalLinearApiKey;
    }
    delete globalThis.__INF995_CLI_HARNESS__;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("AC1: getSelfUser selects viewer.app and returns the current app-user flag", async () => {
    const loaded = loadVendoredCli();
    tempDir = loaded.tempDir;

    const self = await loaded.auth.getSelfUser();
    const selfQuery = globalThis.__INF995_CLI_HARNESS__?.calls.find((call) => call.query.includes("GetSelfUser"));

    expect(selfQuery?.query).toMatch(/\bviewer\s*\{[\s\S]*\bapp\b[\s\S]*\}/);
    expect(self).toMatchObject({ id: "u-tdd-app", name: "TDD", app: true });
  });

  it.each([
    ["consider-work", (semantic: ReturnType<typeof loadVendoredCli>["semantic"]) => semantic.considerWork("INF-995", { force: true })],
    ["manage", (semantic: ReturnType<typeof loadVendoredCli>["semantic"]) => semantic.manageWork("INF-995", { comment: "watching" })],
  ])("AC2: %s self-delegates app users with assigneeId:null in the same Linear write", async (_name, runCommand) => {
    const loaded = loadVendoredCli();
    tempDir = loaded.tempDir;

    await runCommand(loaded.semantic);

    expect(globalThis.__INF995_CLI_HARNESS__?.updateCalls).toContainEqual(
      expect.objectContaining({
        issueId: "INF-995",
        input: expect.objectContaining({
          delegateId: "u-tdd-app",
          assigneeId: null,
        }),
      }),
    );
  });
});
