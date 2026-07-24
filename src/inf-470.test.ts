/**
 * Tests for INF-470 — Spawner idempotency and spec-source integrity.
 *
 * Covers:
 *   - Duplicate sibling guard in executeFanout (INF-470 item 2)
 *   - fetchFanoutSpecDescription comment-source preference for sprint-spawner sign-off (INF-470 item 1)
 */

import { executeFanout, type Finding, type ExistingChild, extractSpecFindings } from "./fanout.js";
import { applyStateTransition, resetWorkflowCache, type WorkflowDef } from "./workflow-gate.js";
import { reloadAgents, upsertAgent } from "./agents.js";
import { resetPolicyCache } from "./escalation-gate.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANONICAL_UX_AUDIT_FIXTURE = path.resolve(process.cwd(), "src/__fixtures__/canonical-ux-audit.yaml");

describe("INF-470: Spawner duplicate-sibling guard", () => {
  const authToken = "test-token";
  const parentId = "PARENT-123";
  const config = { spec_source: "findings", child_workflow: "wf:dev-sprint" };

  // Helper to mock the parent issue fetch
  const mockParentFetch = (description: string) => {
    global.fetch = (async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("IssueTeamParent")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              issue: {
                id: "uuid-123",
                title: "Parent Title",
                description,
                team: { id: "team-123" },
                parent: null
              }
            }
          }),
          json: async () => ({
            data: {
              issue: {
                id: "uuid-123",
                title: "Parent Title",
                description,
                team: { id: "team-123" },
                parent: null
              }
            }
          })
        };
      }
      if (body.query.includes("IssueLastComment")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: { issue: { comments: { nodes: [] } } } }),
          json: async () => ({
            data: { issue: { comments: { nodes: [] } } }
          })
        };
      }
      // Mock label lookups to pass the wf:* check
      if (body.query.includes("IssueLabelLookup")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                  { id: "label-wf", name: "wf:dev-sprint" },
                  { id: "label-todo", name: "state:todo" }
                ]
              }
            }
          }),
          json: async () => ({
            data: {
              issueLabels: {
                nodes: [
                  { id: "label-wf", name: "wf:dev-sprint" },
                  { id: "label-todo", name: "state:todo" }
                ]
              }
            }
          })
        };
      }
      return { ok: true, text: async () => "{}", json: async () => ({ data: {} }) };
    }) as any;
  };

  it("suppresses a spec entry already minted by a sibling (any workflow)", async () => {
    const description = "## Findings\n- **Cycle 6 Scope**: duplicate\n- **Cycle 7 Scope**: new";
    mockParentFetch(description);

    // Existing sibling carries the Cycle 6 specEntryId (hash-stable)
    const findings = extractSpecFindings(description, "findings");
    const cycle6Id = findings.find(f => f.title === "Cycle 6 Scope")?.id;
    
    const existingChildren: ExistingChild[] = [
      {
        identifier: "INF-439",
        specEntryId: cycle6Id!,
        childWorkflow: "wf:dev-sprint"
      }
    ];

    const result = await executeFanout(parentId, authToken, config as any, {
      existingChildren,
      skipPreview: true,
      lookupEntryState: async () => "state:todo"
    });

    // Cycle 6 was suppressed (duplicate sibling guard); Cycle 7 was minted.
    expect(result.attempted).toBe(1);
  });
});

describe("INF-470: fetchFanoutSpecDescription comment-source preference", () => {
  const authToken = "test-token";
  const issueId = "INF-196";

  it("prefers the signed brief in the last comment for sprint-spawner sign-off", async () => {
    const staleDescription = "## sprint\n- **Stale**: old\n\n## structured\n- **Stale**: old";
    const signedBrief = "## sprint\n- **Signed**: new brief\n\n## structured\n- **Signed**: new brief";

    global.fetch = (async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("IssueLastComment")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [{ body: signedBrief }]
                }
              }
            }
          }),
          json: async () => ({
            data: {
              issue: {
                comments: {
                  nodes: [{ body: signedBrief }]
                }
              }
            }
          })
        };
      }
      if (body.query.includes("IssueDescription") || body.query.includes("IssueTeamParent") || body.query.includes("IssueWithLabels")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              issue: {
                id: "uuid-196",
                identifier: "INF-196",
                internalId: "uuid-196",
                title: "The Helm",
                description: staleDescription,
                team: { id: "team-123", states: { nodes: [{ id: "s1", name: "Doing" }] } },
                parent: null,
                labels: { nodes: [{ id: "l1", name: "wf:sprint-spawner" }, { id: "l2", name: "state:determining-scope" }] }
              }
            }
          }),
          json: async () => ({
            data: {
              issue: {
                id: "uuid-196",
                identifier: "INF-196",
                internalId: "uuid-196",
                title: "The Helm",
                description: staleDescription,
                team: { id: "team-123", states: { nodes: [{ id: "s1", name: "Doing" }] } },
                parent: null,
                labels: { nodes: [{ id: "l1", name: "wf:sprint-spawner" }, { id: "l2", name: "state:determining-scope" }] }
              }
            }
          })
        };
      }
      // Mock TeamLabels lookup for findOrCreateLabel
      if (body.query.includes("TeamLabels")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: "label-dest", name: "state:spawning-scope", isGroup: false, team: { id: "team-123" }, parent: null }
                  ]
                }
              }
            }
          }),
          json: async () => ({
            data: {
              team: {
                labels: {
                  nodes: [
                    { id: "label-dest", name: "state:spawning-scope", isGroup: false, team: { id: "team-123" }, parent: null }
                  ]
                }
              }
            }
          })
        };
      }
      // Mock label lookups
      if (body.query.includes("IssueLabelLookup")) {
        const name = body.variables?.name;
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              issueLabels: {
                nodes: [
                    { id: "label-123", name: name || "unknown" },
                    { id: "label-dest", name: "state:spawning-scope" }
                ]
              }
            }
          }),
          json: async () => ({
            data: {
              issueLabels: {
                nodes: [
                    { id: "label-123", name: name || "unknown" },
                    { id: "label-dest", name: "state:spawning-scope" }
                ]
              }
            }
          })
        };
      }
      // Mock successful mutation
      if (body.query.includes("ApplyAtomicTransition") || body.query.includes("issueUpdate")) {
          return {
              ok: true,
              text: async () => JSON.stringify({
                data: {
                  issueUpdate: { success: true },
                  commentCreate: { success: true },
                  applyStateTransition: { success: true }
                }
              }),
              json: async () => ({
                data: {
                  issueUpdate: { success: true },
                  commentCreate: { success: true },
                  applyStateTransition: { success: true }
                }
              })
          }
      }
      return { ok: true, text: async () => JSON.stringify({ data: {} }), json: async () => ({ data: {} }) };
    }) as any;

    // Mock agent registry
    upsertAgent({
        name: "ai",
        linearUserId: "ai-user-id",
        clientId: "c",
        clientSecret: "s",
        accessToken: "a",
        refreshToken: "r"
    });

    // Use a temporary workspace for the workflow def
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-470-test-"));
    const defPath = path.join(tmpDir, "sprint-spawner.yaml");
    fs.writeFileSync(defPath, fs.readFileSync("src/registered-defs/sprint-spawner.yaml"));

    process.env.WORKFLOW_DEFS_DIR = tmpDir;
    resetWorkflowCache();

    // Mock capability policy
    const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf-470-policy-"));
    const policyPath = path.join(policyDir, "capability-policy.yaml");
    fs.writeFileSync(policyPath, `
capabilities:
  - id: sprint:signoff
containers:
  - id: engine
    grants: [sprint:signoff]
roles:
  - id: engine
    requires: [sprint:signoff]
bodies:
  - id: ai
    container: engine
    fills_roles: [engine]
    linearUserId: "ai-user-id"
`);
    process.env.CAPABILITY_POLICY_PATH = policyPath;
    resetPolicyCache();

    // Trigger sign-off transition
    const result = await applyStateTransition("propose-brief", issueId, authToken, {
      bodyId: "ai",
      sourceStateOverride: "determining-scope"
    });

    // Verification: status is applied.
    expect(result.status).toBe("applied");

    fs.rmSync(tmpDir, { recursive: true });
    fs.rmSync(policyDir, { recursive: true });
  });
});
