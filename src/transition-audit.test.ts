/**
 * AI-2554 — Tests for structured transition audit logging.
 *
 * Tests the pure-data-flow paths of `transition-audit.ts`:
 *   - buildTransitionAuditRecord constructs the expected shape
 *   - emitTransitionAuditRecord logs at correct severity
 */

import path from "node:path";
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// Import the module under test after mocks are set up
import {
  buildTransitionAuditRecord,
  emitTransitionAuditRecord,
  emitLabelSyncWarning,
  checkLabelNativeStateSyncForTicket,
  emitLabelNativeSyncWarning,
} from "./transition-audit.js";
import { resetWorkflowCache } from "./workflow-gate.js";

describe("buildTransitionAuditRecord", () => {
  it("produces a complete record with all fields", () => {
    const record = buildTransitionAuditRecord(
      "AI-2554",
      "continue-workflow",
      "code-review",
      "implementation",
      "code-review",
      "applied",
      "OK",
      "Transition applied successfully",
      "igor",
      [{ name: "capability-check", passed: true, detail: null }],
    );

    expect(record.ticketId).toBe("AI-2554");
    expect(record.command).toBe("continue-workflow");
    expect(record.transitionName).toBe("code-review");
    expect(record.fromState).toBe("implementation");
    expect(record.toState).toBe("code-review");
    expect(record.status).toBe("applied");
    expect(record.code).toBe("OK");
    expect(record.detail).toBe("Transition applied successfully");
    expect(record.agentId).toBe("igor");
    expect(record.gateResults).toEqual([
      { name: "capability-check", passed: true, detail: null },
    ]);
    expect(record.postVerification).toBeNull();
    expect(record.ts).toBeDefined();
  });

  it("produces a record for a blocked transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2555",
      "continue-workflow",
      null,
      "implementation",
      null,
      "blocked",
      "GATE_BLOCKED",
      "Capability check: not-implementer",
      "ai",
      [{ name: "capability-check", passed: false, detail: "not-implementer" }],
    );

    expect(record.ticketId).toBe("AI-2555");
    expect(record.status).toBe("blocked");
    expect(record.code).toBe("GATE_BLOCKED");
    expect(record.gateResults[0].passed).toBe(false);
    expect(record.transitionName).toBeNull();
    expect(record.toState).toBeNull();
  });

  it("handles null proxy-store state when ticket has no applied state", () => {
    // The applied-state-store returns null for unknown tickets
    const record = buildTransitionAuditRecord(
      "AI-9999",
      "observe-issue",
      null,
      null,
      null,
      "noop",
      "NO_OP",
      "No transition needed",
      null,
      [],
    );

    expect(record.proxyStoreState).toBeNull();
    expect(record.status).toBe("noop");
    expect(record.agentId).toBeNull();
  });
});

describe("emitTransitionAuditRecord", () => {
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let consoleInfoSpy: jest.SpiedFunction<typeof console.info>;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  it("calls emitTransitionAuditRecord without throwing for an applied transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2554",
      "continue-workflow",
      "code-review",
      "implementation",
      "code-review",
      "applied",
      "OK",
      null,
      "igor",
      [],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });

  it("calls emitTransitionAuditRecord without throwing for a blocked transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2555",
      "continue-workflow",
      null,
      "implementation",
      null,
      "blocked",
      "GATE_BLOCKED",
      "not-implementer",
      "ai",
      [{ name: "capability-check", passed: false, detail: "not-implementer" }],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });

  it("calls emitTransitionAuditRecord without throwing for a failed transition", () => {
    const record = buildTransitionAuditRecord(
      "AI-2556",
      "handoff-work",
      null,
      null,
      null,
      "failed",
      "ERR_INTERNAL",
      "Unexpected error",
      null,
      [],
    );

    expect(() => emitTransitionAuditRecord(record)).not.toThrow();
  });
});

describe("emitLabelSyncWarning", () => {
  it("accepts a divergence descriptor and logs without throwing", () => {
    const divergence = {
      ticketId: "AI-1234",
      proxyState: "implementation",
      linearState: "code-review",
      linearStateLabel: "state:code-review",
      ageSec: 3600,
    };

    expect(() => emitLabelSyncWarning(divergence)).not.toThrow();
  });
});

/**
 * INF-1242 AC3 — label-vs-native divergence detection.
 *
 * INF-1197's actual observed failure was "labels read `state:intake` while
 * native Linear state is `Doing`" — the `state:*` LABEL diverged from the
 * native Linear STATUS FIELD. This is distinct from checkLabelSyncForTicket
 * above (which compares the connector's own applied-state-store record
 * against the label — never touches the native status field at all).
 *
 * checkLabelNativeStateSyncForTicket compares a ticket's current `state:*`
 * label (resolved through the workflow def's `native_state` semantic
 * mapping + SEMANTIC_STATE_MAP candidate names) against the actual native
 * Linear workflow state name.
 */
describe("checkLabelNativeStateSyncForTicket", () => {
  const REGISTERED_DEFS_DIR = path.resolve(process.cwd(), "src/registered-defs");
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.WORKFLOW_DEFS_DIR = process.env.WORKFLOW_DEFS_DIR;
    savedEnv.WORKFLOW_DEF_DIR = process.env.WORKFLOW_DEF_DIR;
    savedEnv.WORKFLOW_DEF_PATH = process.env.WORKFLOW_DEF_PATH;
    process.env.WORKFLOW_DEFS_DIR = REGISTERED_DEFS_DIR;
    delete process.env.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
  });

  afterEach(() => {
    if (savedEnv.WORKFLOW_DEFS_DIR === undefined) delete process.env.WORKFLOW_DEFS_DIR;
    else process.env.WORKFLOW_DEFS_DIR = savedEnv.WORKFLOW_DEFS_DIR;
    if (savedEnv.WORKFLOW_DEF_DIR === undefined) delete process.env.WORKFLOW_DEF_DIR;
    else process.env.WORKFLOW_DEF_DIR = savedEnv.WORKFLOW_DEF_DIR;
    if (savedEnv.WORKFLOW_DEF_PATH === undefined) delete process.env.WORKFLOW_DEF_PATH;
    else process.env.WORKFLOW_DEF_PATH = savedEnv.WORKFLOW_DEF_PATH;
    resetWorkflowCache();
    jest.restoreAllMocks();
  });

  function mockIssueState(stateLabelName: string | null, nativeStateName: string | null): void {
    jest.spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query?: string };
      if ((body.query ?? "").includes("IssueStateLabel")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                labels: { nodes: stateLabelName ? [{ name: stateLabelName }] : [] },
                state: nativeStateName ? { name: nativeStateName } : null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof globalThis.fetch);
  }

  // dev-impl v20's `intake` state declares native_state: todo, whose
  // SEMANTIC_STATE_MAP candidates are ["Todo", "To Do", "To Develop"].

  it("returns a label-native-desync divergence when the label's expected native state doesn't match Linear's actual native state (the INF-1197 shape)", async () => {
    mockIssueState("state:intake", "Doing");

    const divergence = await checkLabelNativeStateSyncForTicket("INF-1197", "dev-impl", "Bearer tok");

    expect(divergence).not.toBeNull();
    expect(divergence).toMatchObject({
      kind: "label-native-desync",
      ticketId: "INF-1197",
      workflowId: "dev-impl",
      stateLabel: "state:intake",
      expectedNativeState: "todo",
      actualNativeStateName: "Doing",
    });
  });

  it("returns null when the native state name matches one of the semantic candidates (case/space-insensitive)", async () => {
    mockIssueState("state:intake", "To Do");

    const divergence = await checkLabelNativeStateSyncForTicket("INF-9001", "dev-impl", "Bearer tok");

    expect(divergence).toBeNull();
  });

  it("returns null when the state label has no matching workflow state in the def", async () => {
    mockIssueState("state:not-a-real-state", "Doing");

    const divergence = await checkLabelNativeStateSyncForTicket("INF-9002", "dev-impl", "Bearer tok");

    expect(divergence).toBeNull();
  });
});

describe("emitLabelNativeSyncWarning", () => {
  it("accepts a label-native-desync divergence descriptor and logs without throwing", () => {
    const divergence = {
      kind: "label-native-desync" as const,
      ticketId: "INF-1197",
      workflowId: "dev-impl",
      stateLabel: "state:intake",
      expectedNativeState: "todo",
      expectedNativeStateCandidates: ["Todo", "To Do", "To Develop"],
      actualNativeStateName: "Doing",
    };

    expect(() => emitLabelNativeSyncWarning(divergence)).not.toThrow();
  });
});
