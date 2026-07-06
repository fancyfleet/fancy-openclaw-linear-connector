/**
 * AI-1848 (Pillar 2 D1) — Integration tests for universal canon injection
 * into dispatch messages.
 *
 * Verifies the canon text appears in all three delivery paths
 * (workflow, ad-hoc/generic, mention) and that fail-open (missing/broken
 * canon file) leaves the message unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetWorkflowCache } from "../workflow-gate.js";
import { resetPolicyCache } from "../escalation-gate.js";
import { _resetAppliedStateStore } from "../store/applied-state-store.js";
import { _resetCanonForTest } from "../policy/universal-canon.js";

// ── Test workflow YAML ─────────────────────────────────────────────────────

const TEST_WORKFLOW_YAML = `
id: dev-impl
version: 3
archetype: single-task
entry_state: intake

break_glass:
  command: escape
  to: escape

states:
  - id: intake
    owner_role: steward
    kind: normal
    native_state: todo
    transitions:
      - command: accept
        to: implementation
      - command: demote
        to: __ad_hoc__

  - id: implementation
    owner_role: dev
    kind: normal
    native_state: todo
    transitions:
      - command: submit
        to: code-review

  - id: code-review
    owner_role: code-review
    kind: normal
    native_state: todo
    transitions:
      - command: approve
        to: deployment

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done

  - id: done
    kind: terminal
    native_state: done

  - id: escape
    kind: terminal
    native_state: invalid
`;

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition
  - id: deploy:execute
  - id: repo:read

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: code-review
    grants: [linear:transition, repo:read]
  - id: deployment
    grants: [linear:transition, deploy:execute]
  - id: main-agent
    grants: [linear:transition]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: code-review
    fills_roles: [code-review]
  - id: felix
    container: dev
    fills_roles: [dev]
  - id: igor
    container: dev
    fills_roles: [dev]
  - id: hanzo
    container: deployment
    fills_roles: [deployment]
  - id: ai
    openclaw_agent: main
    container: main-agent
    fills_roles: []
`;

const CANON_BODY = [
  "1. Read the ticket fully before acting.",
  "2. Use only legal workflow commands for your state.",
  "3. Comment discipline: post one substantive comment.",
  "4. You do not pick your own reviewer.",
  "5. Fail loudly when blocked.",
].join("\n");

function makeCanonFile(version: string): string {
  return `---\nversion: ${version}\n---\n${CANON_BODY}\n`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRoute(
  identifier: string,
  title: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate",
): import("../types.js").RouteResult {
  return {
    agentId: "igor",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason,
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("../types.js").RouteResult["event"],
  };
}

function makeLabelFetch(labels: string[]): typeof globalThis.fetch {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            labels: { nodes: labels.map((name) => ({ name })) },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

// ── Setup / teardown ──────────────────────────────────────────────────────

let tmpDir: string;
let tmpYamlPath: string;
let tmpGuidanceDir: string;
let tmpPolicyPath: string;
let tmpCanonPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-msg-test-"));
  tmpYamlPath = path.join(tmpDir, "dev-impl.yaml");
  fs.writeFileSync(tmpYamlPath, TEST_WORKFLOW_YAML, "utf8");
  tmpGuidanceDir = path.join(tmpDir, "guidance");
  fs.mkdirSync(path.join(tmpGuidanceDir, "dev-impl"), { recursive: true });
  tmpPolicyPath = path.join(tmpDir, "capability-policy.yaml");
  fs.writeFileSync(tmpPolicyPath, TEST_POLICY_YAML, "utf8");
  tmpCanonPath = path.join(tmpDir, "universal.md");
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();
  _resetCanonForTest();
  process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = tmpGuidanceDir;
  process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.UNIVERSAL_POLICY_PATH;
  resetPolicyCache();
  _resetCanonForTest();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getbuildDeliveryMessage() {
  const mod = await import("./build-message.js");
  return mod.buildDeliveryMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AI-1848 — universal canon injection into dispatch messages", () => {
  describe("canon present → injected into all three paths", () => {
    beforeEach(() => {
      fs.writeFileSync(tmpCanonPath, makeCanonFile("v1"), "utf8");
      process.env.UNIVERSAL_POLICY_PATH = tmpCanonPath;
    });

    it("workflow ticket message contains canon text + retains B3 step block", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-001", "Workflow ticket"), "Bearer tok");

      // Canon text present
      expect(msg).toContain("Universal task-handling canon (v1)");
      expect(msg).toContain("Read the ticket fully before acting.");
      expect(msg).toContain("Comment discipline: post one substantive comment.");

      // Canon appears before per-step guidance (before the legal commands block)
      const canonIdx = msg.indexOf("Universal task-handling canon");
      const commandsIdx = msg.indexOf("Your legal action(s)");
      expect(canonIdx).toBeGreaterThan(-1);
      expect(commandsIdx).toBeGreaterThan(-1);
      expect(canonIdx).toBeLessThan(commandsIdx);

      // B3 per-step block retained (no regression)
      expect(msg).toContain("[dev-impl]");
      expect(msg).toContain("state: **implementation**");
      expect(msg).toContain("linear submit AI-001");
    });

    it("ad-hoc (generic) message contains canon text", async () => {
      globalThis.fetch = makeLabelFetch([]); // no wf:* label

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-002", "Ad-hoc task"), "Bearer tok");

      // Canon text present
      expect(msg).toContain("Universal task-handling canon (v1)");
      expect(msg).toContain("Read the ticket fully before acting.");

      // Canon before the generic guidance ("Next Steps")
      const canonIdx = msg.indexOf("Universal task-handling canon");
      const nextStepsIdx = msg.indexOf("Next Steps:");
      expect(canonIdx).toBeLessThan(nextStepsIdx);

      // Generic content still intact
      expect(msg).toContain("linear consider-work AI-002");
    });

    it("mention message contains canon text", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(
        makeRoute("AI-004", "Mention test", "mention"),
        "Bearer tok",
      );

      // Canon text present
      expect(msg).toContain("Universal task-handling canon (v1)");
      expect(msg).toContain("Read the ticket fully before acting.");

      // Mention content still present
      expect(msg).toContain("You were mentioned on AI-004");
      expect(msg).toContain("linear observe-issue AI-004");
    });

    it("canon appears only once in the message (not duplicated)", async () => {
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-005", "Once only"), "Bearer tok");

      const occurrences = (msg.match(/Universal task-handling canon/g) || []).length;
      expect(occurrences).toBe(1);
    });

    it("canon hook line still comes before canon block", async () => {
      globalThis.fetch = makeLabelFetch([]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-006", "Hook test"), "Bearer tok");

      // The hook line ("You were delegated...") should come before the canon block
      const hookIdx = msg.indexOf("AI-006");
      const canonIdx = msg.indexOf("Universal task-handling canon");
      expect(hookIdx).toBeGreaterThan(-1);
      expect(canonIdx).toBeGreaterThan(hookIdx);
    });
  });

  describe("canon missing/broken → fail-open (no canon section)", () => {
    it("missing canon file → message unchanged, no canon section", async () => {
      process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "does-not-exist.md");
      globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-010", "No canon"), "Bearer tok");

      expect(msg).not.toContain("Universal task-handling canon");
      // Workflow content still present
      expect(msg).toContain("[dev-impl]");
      expect(msg).toContain("linear submit AI-010");
    });

    it("broken (empty) canon file → message unchanged", async () => {
      fs.writeFileSync(tmpCanonPath, "", "utf8");
      process.env.UNIVERSAL_POLICY_PATH = tmpCanonPath;
      globalThis.fetch = makeLabelFetch([]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-011", "Empty canon"), "Bearer tok");

      expect(msg).not.toContain("Universal task-handling canon");
      expect(msg).toContain("Next Steps:");
    });

    it("unparseable canon (frontmatter only, no body) → message unchanged", async () => {
      fs.writeFileSync(tmpCanonPath, "---\nversion: v1\n---\n", "utf8");
      process.env.UNIVERSAL_POLICY_PATH = tmpCanonPath;
      globalThis.fetch = makeLabelFetch([]);

      const buildDeliveryMessage = await getbuildDeliveryMessage();
      const msg = await buildDeliveryMessage(makeRoute("AI-012", "Broken canon"), "Bearer tok");

      expect(msg).not.toContain("Universal task-handling canon");
      expect(msg).toContain("Next Steps:");
    });
  });

  describe("version stamping", () => {
    it("getActiveCanonVersion reflects the version loaded during message build", async () => {
      fs.writeFileSync(tmpCanonPath, makeCanonFile("v2"), "utf8");
      process.env.UNIVERSAL_POLICY_PATH = tmpCanonPath;
      globalThis.fetch = makeLabelFetch([]);

      const { buildDeliveryMessage } = await import("./build-message.js");
      const { getActiveCanonVersion } = await import("../policy/universal-canon.js");

      await buildDeliveryMessage(makeRoute("AI-020", "Version stamp"), "Bearer tok");

      // The canon was loaded during message build; version should be available.
      expect(getActiveCanonVersion()).toBe("v2");
    });

    it("canon version null when canon file is missing", async () => {
      process.env.UNIVERSAL_POLICY_PATH = path.join(tmpDir, "missing.md");
      globalThis.fetch = makeLabelFetch([]);

      const { buildDeliveryMessage } = await import("./build-message.js");
      const { getActiveCanonVersion } = await import("../policy/universal-canon.js");

      await buildDeliveryMessage(makeRoute("AI-021", "No canon version"), "Bearer tok");

      expect(getActiveCanonVersion()).toBeNull();
    });
  });
});
