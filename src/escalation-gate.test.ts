/**
 * Unit tests for escalation-gate enforcement (AI-1346).
 *
 * Uses a minimal in-memory capability policy injected via CAPABILITY_POLICY_PATH
 * so tests never depend on the vault file system path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bodyHasCapability,
  checkEnforcementRules,
  ENFORCEMENT_RULES,
  resetPolicyCache,
} from "./escalation-gate.js";

// ── Minimal test policy ───────────────────────────────────────────────────

const TEST_POLICY_YAML = `
capabilities:
  - id: human:escalate
  - id: linear:transition

containers:
  - id: steward
    grants: [linear:transition, human:escalate]
  - id: dev
    grants: [linear:transition]
  - id: main-agent
    grants: [linear:transition]

roles:
  - id: steward
    requires: [human:escalate]

bodies:
  - id: astrid
    container: steward
    fills_roles: [steward]
  - id: charles
    container: dev
    fills_roles: []
  - id: ai
    openclaw_agent: main
    container: main-agent
    fills_roles: []
`;

let policyFile: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escalation-gate-test-"));
  policyFile = path.join(dir, "capability-policy.yaml");
  fs.writeFileSync(policyFile, TEST_POLICY_YAML, "utf8");
  process.env.CAPABILITY_POLICY_PATH = policyFile;
});

beforeEach(() => {
  resetPolicyCache();
});

// ── ENFORCEMENT_RULES shape ───────────────────────────────────────────────

describe("ENFORCEMENT_RULES", () => {
  // AI-1488: needs-human moved to the B1 cross-cutting allowlist in workflow-gate.ts.
  // ENFORCEMENT_RULES is now empty (retained as an extension point for future rules).
  it("is empty after AI-1488 (needs-human moved to B1 allowlist)", () => {
    expect(ENFORCEMENT_RULES).toHaveLength(0);
    const rule = ENFORCEMENT_RULES.find((r) => r.intent === "needs-human");
    expect(rule).toBeUndefined();
  });
});

// ── bodyHasCapability ─────────────────────────────────────────────────────

describe("bodyHasCapability", () => {
  it("returns true for astrid with human:escalate", async () => {
    expect(await bodyHasCapability("astrid", "human:escalate")).toBe(true);
  });

  it("returns true for astrid with linear:transition", async () => {
    expect(await bodyHasCapability("astrid", "linear:transition")).toBe(true);
  });

  it("returns false for charles with human:escalate", async () => {
    expect(await bodyHasCapability("charles", "human:escalate")).toBe(false);
  });

  it("returns true for charles with linear:transition", async () => {
    expect(await bodyHasCapability("charles", "linear:transition")).toBe(true);
  });

  it("returns false for unknown body", async () => {
    expect(await bodyHasCapability("unknown-body", "human:escalate")).toBe(false);
  });

  // AI-1348: runtime sends OPENCLAW_MCP_AGENT_ID=main but policy body id is ai
  it("resolves main (openclaw_agent alias) to ai body capabilities", async () => {
    expect(await bodyHasCapability("main", "linear:transition")).toBe(true);
    expect(await bodyHasCapability("main", "human:escalate")).toBe(false);
  });
});

// ── checkEnforcementRules ─────────────────────────────────────────────────

function makeLabelFetch(labelNames: string[]): typeof globalThis.fetch {
  return async (_url, _init) => {
    const body = {
      data: {
        issue: {
          labels: { nodes: labelNames.map((name) => ({ name })) },
        },
      },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("checkEnforcementRules", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null for an intent with no matching rule", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("begin-work", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns null when issueId is null (fail open)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", null, "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns null when ticket has no wf:* label (ad-hoc — §4.6 mode switch)", async () => {
    globalThis.fetch = makeLabelFetch(["bug", "priority:high"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  // AI-1488: needs-human is allowlisted at the B1 layer — checkEnforcementRules no
  // longer intercepts it regardless of the caller's capability. Both steward and
  // non-steward callers now get null here; the proxy's body sanitization handles the
  // delegate-preservation concern instead.
  it("returns null for needs-human on wf: ticket (AI-1488: moved to B1 allowlist)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1", "bug"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  it("returns null when steward (Astrid) runs needs-human on workflow ticket", async () => {
    globalThis.fetch = makeLabelFetch(["wf:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "astrid");
    expect(result).toBeNull();
  });

  it("fails open when label fetch throws", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });

  // AI-1488: needs-human is now B1-allowlisted so this test verifies case-insensitive
  // wf: detection via a different intent (future enforcement rules can test it again).
  it("returns null for needs-human even with case-variant wf: label (AI-1488: B1 allowlisted)", async () => {
    globalThis.fetch = makeLabelFetch(["WF:sprint-1"]);
    const result = await checkEnforcementRules("needs-human", "issue-uuid", "Bearer tok", "charles");
    expect(result).toBeNull();
  });
});
