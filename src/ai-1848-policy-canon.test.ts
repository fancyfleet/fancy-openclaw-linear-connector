/**
 * AI-1848 — Pillar 2 D1: universal policy canon inlined into every dispatch
 * + policy-version stamping.
 *
 * Tests are RED on write — the policy-canon module and build-message
 * integration do not exist yet. Implementation must make all of these pass.
 *
 * Acceptance Criteria covered (one assertion of intent per AC):
 *
 *   AC1 — Canon file in instance config with version marker; fail-open load.
 *   AC2 — Workflow wake messages contain canon AND retain B3 per-step block.
 *   AC3 — Ad-hoc and mention dispatch messages contain canon text.
 *   AC4 — Each dispatch record persists the canon version injected.
 *   AC5 — Canon edits take effect without a connector rebuild.
 *   AC6 — Component registered at server bootstrap (integration assertion).
 *   AC7 — Liveness observable at ac-validate (/health field).
 *
 * Design notes for the implementer (test-driving the API surface):
 *
 *  - New module `src/delivery/policy-canon.ts` exports `loadPolicyCanon()`
 *    returning `{ loaded: true; version: string; text: string }` on success
 *    or `{ loaded: false; reason: string }` on missing/broken file.
 *  - Canon path resolved from instance-config: `defaultPolicyCanonPath()`
 *    → `{instanceConfigRoot}/policy/universal.md`. Env override:
 *    `POLICY_CANON_PATH` (mirrors WORKFLOW_DEF_PATH / CAPABILITY_POLICY_PATH).
 *  - Canon file format: YAML frontmatter `---\nversion: v1\n---\n` followed
 *    by markdown body. Version is parsed from frontmatter.
 *  - `buildDeliveryMessage` returns a richer result exposing the canon
 *    version so the delivery path can stamp it into dispatch records:
 *      export interface BuildMessageResult {
 *        message: string;
 *        canonVersion: string | null; // null when canon unavailable (fail-open)
 *      }
 *  - Canon inlined ONCE, clearly delimited, BEFORE per-step guidance,
 *    on all three paths (workflow / ad-hoc / mention).
 *  - Steward intake directive: omit rule 10 (`linear guidance <topic>`) —
 *    that verb is D2 (AI-1849) and won't exist when D1 ships.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { resetWorkflowCache } from "./workflow-gate.js";
import { resetPolicyCache } from "./escalation-gate.js";
import { _resetAppliedStateStore } from "./store/applied-state-store.js";

// ── Test workflow YAML (mirrors build-message.test.ts) ────────────────────

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
    sla: 24h
    transitions:
      - command: approve
        to: deployment
      - command: request-changes
        to: implementation
        feedback:
          required: true
          category_enum: [missing-tests, style, scope-creep, correctness, ac-mismatch]

  - id: deployment
    owner_role: deployment
    kind: normal
    native_state: todo
    transitions:
      - command: deploy
        to: done
        requires_capability: deploy:execute
      - command: reject
        to: implementation
        feedback:
          required: true
          category_enum: [missing-tests, style, scope-creep, correctness, ac-mismatch]

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
  - id: noah
    container: dev
    fills_roles: [dev]
  - id: sage
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

// ── Test canon file content ───────────────────────────────────────────────
// v1 canon (rule 10 omitted per steward intake — D2 verb doesn't exist yet).

const CANON_V1 = `---
version: v1
---

## Universal task-handling canon

1. Read the ticket description and AC of record before acting.
2. Acknowledge dispatches promptly via the connector proxy.
3. Transition state at the end of every working turn.
4. Post one substantive comment per action — no restating the ticket.
5. Escalate to Ai for any blocker; do not route humans directly.
6. Never exfiltrate private data.
7. \\\`trash\\\` over \\\`rm\\\`; never run destructive commands without asking.
8. Stay in your role; do not implement if you are the test-author.
9. Hand finished work off for review — you do not pick your own reviewer.
`;

const CANON_V2 = `---
version: v2
---

## Universal task-handling canon

1. Read the ticket description and AC of record before acting.
2. Acknowledge dispatches promptly via the connector proxy.
3. Transition state at the end of every working turn.
4. Post one substantive comment per action — no restating the ticket.
5. Escalate to Ai for any blocker; do not route humans directly.
6. Never exfiltrate private data.
7. \\\`trash\\\` over \\\`rm\\\`; never run destructive commands without asking.
8. Stay in your role; do not implement if you are the test-author.
9. Hand finished work off for review — you do not pick your own reviewer.
10. Run \\\`linear guidance <topic>\\\` for context on a workflow topic.
`;

// Broken canon: no frontmatter, no version marker.
const CANON_BROKEN_NO_VERSION = `This is just markdown with no frontmatter and no version marker.

It should be treated as unparseable — the version is mandatory.`;

// Broken canon: malformed YAML frontmatter.
const CANON_BROKEN_MALFORMED = `---
this is not: valid: yaml: at all
===not-a-frontmatter-delimiter===
text
`;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRoute(
  identifier: string,
  title: string,
  routingReason: "delegate" | "assignee" | "mention" | "body-mention" = "delegate",
): import("./types.js").RouteResult {
  return {
    agentId: "charles",
    sessionKey: `linear-${identifier}`,
    priority: 0,
    routingReason,
    event: {
      type: "Issue",
      action: "update",
      actor: { id: "u1", name: "Ai", type: "user" },
      data: { identifier, title },
    } as unknown as import("./types.js").RouteResult["event"],
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

let tmpRoot: string;
let tmpYamlPath: string;
let tmpGuidanceDir: string;
let tmpPolicyPath: string;
let tmpCanonPath: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai1848-test-"));
  tmpYamlPath = path.join(tmpRoot, "dev-impl.yaml");
  fs.writeFileSync(tmpYamlPath, TEST_WORKFLOW_YAML, "utf8");
  tmpGuidanceDir = path.join(tmpRoot, "guidance");
  fs.mkdirSync(path.join(tmpGuidanceDir, "dev-impl"), { recursive: true });
  tmpPolicyPath = path.join(tmpRoot, "capability-policy.yaml");
  fs.writeFileSync(tmpPolicyPath, TEST_POLICY_YAML, "utf8");
  tmpCanonPath = path.join(tmpRoot, "universal.md");
});

beforeEach(() => {
  resetWorkflowCache();
  resetPolicyCache();
  _resetAppliedStateStore();
  process.env.WORKFLOW_DEF_PATH = tmpYamlPath;
  process.env.WORKFLOW_GUIDANCE_DIR = tmpGuidanceDir;
  process.env.CAPABILITY_POLICY_PATH = tmpPolicyPath;
  // Canon path override — tests control the canon file via this env var.
  process.env.POLICY_CANON_PATH = tmpCanonPath;
  originalFetch = globalThis.fetch;
  // Default: canon v1 file present.
  fs.writeFileSync(tmpCanonPath, CANON_V1, "utf8");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.WORKFLOW_DEF_PATH;
  delete process.env.WORKFLOW_GUIDANCE_DIR;
  delete process.env.CAPABILITY_POLICY_PATH;
  delete process.env.POLICY_CANON_PATH;
  resetPolicyCache();
  // Remove any guidance files written by tests.
  for (const f of fs.readdirSync(path.join(tmpGuidanceDir, "dev-impl"))) {
    fs.rmSync(path.join(tmpGuidanceDir, "dev-impl", f));
  }
});

// ── Dynamic import helper (gets fresh module state per test) ──────────────

async function importPolicyCanon() {
  return import("./delivery/policy-canon.js");
}

async function importBuildMessage() {
  return import("./delivery/build-message.js");
}

// ══════════════════════════════════════════════════════════════════════════
// AC1 — Canon file exists in instance config with version marker;
//        connector loads it fail-open.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC1: policy canon loader — fail-open loading", () => {
  it("loads a valid canon file and returns version + text", async () => {
    const { loadPolicyCanon } = await importPolicyCanon();
    const result = await loadPolicyCanon();
    expect(result.loaded).toBe(true);
    if (result.loaded) {
      expect(result.version).toBe("v1");
      expect(result.text).toContain("Universal task-handling canon");
      // Rule 10 MUST be absent in v1 (steward intake directive).
      expect(result.text).not.toContain("linear guidance");
    }
  });

  it("missing canon file → { loaded: false } (fail-open, no throw)", async () => {
    fs.rmSync(tmpCanonPath);
    const { loadPolicyCanon } = await importPolicyCanon();
    const result = await loadPolicyCanon();
    expect(result.loaded).toBe(false);
    if (!result.loaded) {
      expect(result.reason).toBeTruthy();
    }
  });

  it("broken canon file (no version marker) → { loaded: false } (fail-open)", async () => {
    // Steward intake: "write a test for the broken-file case, not just missing-file."
    fs.writeFileSync(tmpCanonPath, CANON_BROKEN_NO_VERSION, "utf8");
    const { loadPolicyCanon } = await importPolicyCanon();
    const result = await loadPolicyCanon();
    expect(result.loaded).toBe(false);
    if (!result.loaded) {
      expect(result.reason).toBeTruthy();
    }
  });

  it("malformed canon file (bad YAML frontmatter) → { loaded: false }", async () => {
    fs.writeFileSync(tmpCanonPath, CANON_BROKEN_MALFORMED, "utf8");
    const { loadPolicyCanon } = await importPolicyCanon();
    const result = await loadPolicyCanon();
    expect(result.loaded).toBe(false);
  });

  it("defaultPolicyCanonPath resolves under the instance-config root", async () => {
    // The path must live alongside other instance-config artifacts —
    // NOT inside the repo or the vault. See instance-config.ts convention.
    const { defaultPolicyCanonPath } = await import("./instance-config.js");
    const p = defaultPolicyCanonPath();
    expect(p).toContain("policy");
    expect(p).toContain("universal.md");
    // Must NOT be inside the connector repo working directory.
    expect(path.isAbsolute(p)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC2 — Workflow wake messages contain canon text AND retain B3 per-step.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC2: workflow dispatch message — canon + B3 retention", () => {
  it("workflow ticket message contains the canon text", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-101", "WF ticket"), "Bearer tok");

    const msg = typeof result === "string" ? result : result.message;
    // Canon text appears in the message.
    expect(msg).toContain("Universal task-handling canon");
    // Canon appears BEFORE per-step guidance / legal commands.
    const canonIdx = msg.indexOf("Universal task-handling canon");
    const legalCmdIdx = msg.indexOf("Your legal action(s)");
    expect(canonIdx).toBeGreaterThan(-1);
    expect(legalCmdIdx).toBeGreaterThan(-1);
    expect(canonIdx).toBeLessThan(legalCmdIdx);
  });

  it("canon is clearly delimited (appears once, bounded)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-102", "Delimited"), "Bearer tok");
    const msg = typeof result === "string" ? result : result.message;

    // Canon text appears exactly once (not duplicated).
    const matches = msg.match(/Universal task-handling canon/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("B3 per-step block is RETAINED (no regression)", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:code-review"]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-103", "B3 retained"), "Bearer tok");
    const msg = typeof result === "string" ? result : result.message;

    // Workflow header still present.
    expect(msg).toContain("[dev-impl]");
    expect(msg).toContain("state: **code-review**");
    // Legal commands for code-review state still present.
    expect(msg).toContain("linear approve AI-103");
    expect(msg).toContain("linear request-changes AI-103");
    // Generic "Next Steps:" block still absent (no regression to B3 mode switch).
    expect(msg).not.toContain("Next Steps:");
  });

  it("canon present alongside step guidance (no either/or suppression)", async () => {
    fs.writeFileSync(
      path.join(tmpGuidanceDir, "dev-impl", "implementation.md"),
      "Include edge-case tests.\n",
      "utf8",
    );
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-104", "Both"), "Bearer tok");
    const msg = typeof result === "string" ? result : result.message;

    expect(msg).toContain("Universal task-handling canon");
    expect(msg).toContain("Step guidance");
    expect(msg).toContain("Include edge-case tests.");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC3 — Ad-hoc (non-wf) and mention dispatch messages contain canon text.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC3: ad-hoc + mention dispatch — canon injected", () => {
  it("ad-hoc delegation message contains canon text", async () => {
    globalThis.fetch = makeLabelFetch([]); // no wf:* label
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-201", "Ad-hoc"), "Bearer tok");
    const msg = typeof result === "string" ? result : result.message;

    expect(msg).toContain("Universal task-handling canon");
    // Generic message structure still intact.
    expect(msg).toContain("Next Steps:");
    expect(msg).toContain("linear consider-work AI-201");
  });

  it("ad-hoc with no authToken (bare generic) still contains canon", async () => {
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-202", "No token"), undefined);
    const msg = typeof result === "string" ? result : result.message;

    expect(msg).toContain("Universal task-handling canon");
  });

  it("mention message contains canon text", async () => {
    globalThis.fetch = makeLabelFetch(["wf:dev-impl", "state:implementation"]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(
      makeRoute("AI-203", "Mention", "mention"),
      "Bearer tok",
    );
    const msg = typeof result === "string" ? result : result.message;

    expect(msg).toContain("Universal task-handling canon");
    // Mention message identity retained.
    expect(msg).toContain("You were mentioned on AI-203");
    expect(msg).toContain("linear observe-issue AI-203");
  });

  it("fail-open: missing canon file → ad-hoc message still delivered, no canon section", async () => {
    fs.rmSync(tmpCanonPath);
    globalThis.fetch = makeLabelFetch([]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-204", "No canon"), "Bearer tok");
    const msg = typeof result === "string" ? result : result.message;

    // Message still delivered — fail-open.
    expect(msg).toContain("Next Steps:");
    expect(msg).toContain("linear consider-work AI-204");
    // No canon section.
    expect(msg).not.toContain("Universal task-handling canon");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC4 — Each dispatch record persists the canon version injected.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC4: dispatch record persists canon version", () => {
  it("buildDeliveryMessage exposes the canon version alongside the message", async () => {
    globalThis.fetch = makeLabelFetch([]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-301", "Stamp"), "Bearer tok");

    // The return type MUST carry the canon version so the delivery path can
    // stamp it into the dispatch record. A bare string return does NOT satisfy AC4.
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    if (typeof result === "object" && result !== null && "canonVersion" in result) {
      expect((result as { canonVersion: string | null }).canonVersion).toBe("v1");
      expect(typeof (result as { message: string }).message).toBe("string");
    } else {
      throw new Error(
        "buildDeliveryMessage must return { message, canonVersion } — got: " + JSON.stringify(result).slice(0, 100),
      );
    }
  });

  it("canonVersion is null when canon file is missing (fail-open)", async () => {
    fs.rmSync(tmpCanonPath);
    globalThis.fetch = makeLabelFetch([]);
    const { buildDeliveryMessage } = await importBuildMessage();
    const result = await buildDeliveryMessage(makeRoute("AI-302", "Missing canon"), "Bearer tok");

    if (typeof result === "object" && result !== null && "canonVersion" in result) {
      expect((result as { canonVersion: string | null }).canonVersion).toBeNull();
    } else {
      throw new Error("Expected object return with canonVersion field");
    }
  });

  it("operational event detail carries policyCanonVersion for a dispatched ticket", async () => {
    // The dispatch record (operational event with outcome "delivered" /
    // "dispatch-accepted") must persist the canon version in its detail.
    // This test verifies the store can round-trip the field; the delivery
    // path wiring is asserted via source-level checks below.
    const { OperationalEventStore } = await import("./store/operational-event-store.js");
    const dbPath = path.join(tmpRoot, `oe-ac4-${Date.now()}.db`);
    const store = new OperationalEventStore(dbPath);

    const canonVersion = "v1";
    const id = store.append({
      outcome: "delivered",
      agent: "charles",
      key: "linear-AI-303",
      sessionKey: "linear-AI-303",
      deliveryMode: "direct",
      attemptCount: 1,
      detail: { policyCanonVersion: canonVersion },
    });
    expect(id).toBeGreaterThan(0);

    const events = store.query({ key: "linear-AI-303", outcome: "delivered" });
    expect(events.length).toBe(1);
    const detail = events[0].detail as Record<string, unknown>;
    expect(detail.policyCanonVersion).toBe("v1");

    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("delivery path stamps canon version: webhook source references canon version", async () => {
    // Source-level wiring assertion: the webhook dispatch path must reference
    // the canon version when appending the "delivered"/"dispatch-accepted"
    // operational event. The implementer threads canonVersion from
    // buildDeliveryMessage's return into the detail payload.
    const WEBHOOK_TS = fs.readFileSync(
      path.resolve(__dirname, "webhook", "index.ts"),
      "utf8",
    );
    expect(WEBHOOK_TS.includes("canonVersion")).toBe(true);
  });

  it("deliver.ts threads canon version from buildDeliveryMessage", async () => {
    // The delivery module sits between the webhook path and buildDeliveryMessage.
    // It must carry the canon version out so the webhook path can stamp it.
    const DELIVER_TS = fs.readFileSync(
      path.resolve(__dirname, "delivery", "deliver.ts"),
      "utf8",
    );
    expect(DELIVER_TS.includes("canonVersion")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC5 — Canon edits take effect without a connector rebuild
//        (hot-reload or read-per-dispatch).
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC5: canon hot-reload — edits without rebuild", () => {
  it("canon v1 → edit to v2 → next load returns v2 (read-per-dispatch)", async () => {
    const { loadPolicyCanon } = await importPolicyCanon();

    // Load v1.
    const first = await loadPolicyCanon();
    expect(first.loaded).toBe(true);
    if (first.loaded) expect(first.version).toBe("v1");

    // Edit the canon file on disk (no rebuild, no re-import).
    fs.writeFileSync(tmpCanonPath, CANON_V2, "utf8");

    // Next load reflects the edit.
    const second = await loadPolicyCanon();
    expect(second.loaded).toBe(true);
    if (second.loaded) {
      expect(second.version).toBe("v2");
      // Rule 10 is now present in v2.
      expect(second.text).toContain("linear guidance");
    }
  });

  it("canon file deleted then recreated → load reflects current state", async () => {
    const { loadPolicyCanon } = await importPolicyCanon();

    // Delete → missing.
    fs.rmSync(tmpCanonPath);
    const missing = await loadPolicyCanon();
    expect(missing.loaded).toBe(false);

    // Recreate → loaded.
    fs.writeFileSync(tmpCanonPath, CANON_V1, "utf8");
    const back = await loadPolicyCanon();
    expect(back.loaded).toBe(true);
    if (back.loaded) expect(back.version).toBe("v1");
  });

  it("buildDeliveryMessage picks up canon edit without re-import (end-to-end)", async () => {
    globalThis.fetch = makeLabelFetch([]);
    const { buildDeliveryMessage } = await importBuildMessage();

    // Build with v1 canon.
    const r1 = await buildDeliveryMessage(makeRoute("AI-501", "v1 build"), "Bearer tok");
    const m1 = typeof r1 === "string" ? r1 : r1.message;
    expect(m1).toContain("Universal task-handling canon");
    expect(m1).not.toContain("linear guidance");

    // Edit canon on disk.
    fs.writeFileSync(tmpCanonPath, CANON_V2, "utf8");

    // Build again — message now reflects v2.
    const r2 = await buildDeliveryMessage(makeRoute("AI-501", "v2 build"), "Bearer tok");
    const m2 = typeof r2 === "string" ? r2 : r2.message;
    expect(m2).toContain("Universal task-handling canon");
    expect(m2).toContain("linear guidance");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC6 — Component registered at server bootstrap (integration assertion).
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC6: policy canon wired into server bootstrap", () => {
  // The AI-1775/AI-1808 lesson: a module can be exported, fully unit-tested,
  // and still never reach the production entry point. This block reads
  // index.ts source and asserts the wiring is present — mechanical,
  // generic, does not rely on runtime.

  const INDEX_TS = fs.readFileSync(
    path.resolve(__dirname, "index.ts"),
    "utf8",
  );

  it("index.ts imports the policy-canon module", () => {
    expect(
      INDEX_TS.includes("policy-canon") ||
      INDEX_TS.includes("loadPolicyCanon") ||
      INDEX_TS.includes("PolicyCanon"),
    ).toBe(true);
  });

  it("index.ts loads the canon at startup (bootstrap registration)", () => {
    // The bootstrap path must actively load the canon — not just import the
    // module. Look for an invocation of loadPolicyCanon or a registration
    // call in the entry-point section.
    expect(
      INDEX_TS.includes("loadPolicyCanon") ||
      INDEX_TS.includes("registerPolicyCanon") ||
      INDEX_TS.includes("policyCanon"),
    ).toBe(true);
  });

  it("createApp or entry point exposes the canon status for /health", () => {
    // /health must be able to read the canon status. Either:
    //  - A module-level variable holds it after bootstrap load, OR
    //  - createApp's return object carries it, OR
    //  - /health handler calls loadPolicyCanon / reads a registry.
    // At minimum, "policyCanon" or "canonVersion" must appear in index.ts.
    expect(
      INDEX_TS.includes("policyCanon") ||
      INDEX_TS.includes("canonVersion"),
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AC7 — Liveness observable at ac-validate without waiting for a trigger.
// ══════════════════════════════════════════════════════════════════════════

describe("AI-1848 AC7: liveness — canon visible at /health", () => {
  // AC: "a /health field, startup log line, or registry entry showing the
  // policy file loaded and its version." We assert the /health field path
  // (strongest, most queryable surface) and the startup log line.

  const INDEX_TS = fs.readFileSync(
    path.resolve(__dirname, "index.ts"),
    "utf8",
  );

  it("/health response includes a policyCanon field", () => {
    // The /health handler must expose canon load status + version.
    // Check for a policyCanon key in the /health JSON body.
    const healthStart = INDEX_TS.indexOf('app.get("/health"');
    expect(healthStart).toBeGreaterThan(-1);
    const healthEnd = INDEX_TS.indexOf("});", healthStart);
    const healthBlock = INDEX_TS.slice(healthStart, healthEnd);
    expect(healthBlock.includes("policyCanon")).toBe(true);
  });

  it("/health policyCanon field includes loaded status and version", () => {
    // The field must surface both whether the canon loaded AND its version.
    // This is the ac-validate surface: a steward curls /health and sees
    // { policyCanon: { loaded: true, version: "v1" } } without waiting
    // for a trigger condition.
    const healthStart = INDEX_TS.indexOf('app.get("/health"');
    const healthEnd = INDEX_TS.indexOf("});", healthStart);
    const healthBlock = INDEX_TS.slice(healthStart, healthEnd);
    expect(healthBlock.includes("loaded")).toBe(true);
    expect(
      healthBlock.includes("version") || healthBlock.includes("canonVersion"),
    ).toBe(true);
  });
});
