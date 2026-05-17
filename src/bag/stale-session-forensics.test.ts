import { classify, type ToolCallSummary, type LastAssistantMessage, STALE_CLASS_NAMES, buildSnapshot, writeSnapshot, aggregateDigest, formatDigestSummary } from "./stale-session-forensics.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── classify() tests ────────────────────────────────────────────────────────

const emptyToolCalls: ToolCallSummary = { byName: {}, totalCalls: 0, last10: [] };

function makeAssistant(overrides: Partial<LastAssistantMessage> = {}): LastAssistantMessage {
  return {
    fullText: "Done with the work.",
    hasQuestion: false,
    hasToolCalls: false,
    stopReason: "end_turn",
    timestamp: "2026-05-17T22:00:00Z",
    ...overrides,
  };
}

describe("classify", () => {
  test("C4 — never started (no tool calls, no text)", () => {
    expect(classify(null, emptyToolCalls, [])).toBe("C4");
    expect(classify(makeAssistant({ fullText: "" }), emptyToolCalls, [])).toBe("C4");
  });

  test("C6 — errored", () => {
    const assistant = makeAssistant({ stopReason: "error" });
    expect(classify(assistant, emptyToolCalls, ["Model error at 22:00"])).toBe("C6");
  });

  test("C5 — looped (many tool calls, no productive text)", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 25 },
      totalCalls: 25,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [])).toBe("C5");
  });

  test("C5 — not triggered when productive text exists", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 25 },
      totalCalls: 25,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    expect(classify(makeAssistant({ fullText: "I've completed the implementation of the new forensics module. Here's a summary..." }), manyToolCalls, [])).not.toBe("C5");
  });

  test("C2 — tool hang (last tool call has no result)", () => {
    const toolCalls: ToolCallSummary = {
      byName: { exec: 3 },
      totalCalls: 3,
      last10: [
        { name: "exec", arguments: { command: "npm test" }, result: "no-result", timestamp: "2026-05-17T22:00:00Z" },
      ],
    };
    const assistant = makeAssistant({ hasToolCalls: true, stopReason: "tool_use" });
    expect(classify(assistant, toolCalls, [])).toBe("C2");
  });

  test("C1 — waiting on user (question, end_turn)", () => {
    const assistant = makeAssistant({
      fullText: "Should I proceed with option A or option B?",
      hasQuestion: true,
      stopReason: "end_turn",
    });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C1");
  });

  test("C3 — silent completion (long text, end_turn, no tool calls)", () => {
    const assistant = makeAssistant({
      fullText: "I've completed the implementation. The new module handles session timeout detection and creates forensic snapshots for debugging.",
      stopReason: "end_turn",
    });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C3");
  });

  test("C3 — tool calls completed but didn't transition", () => {
    const toolCalls: ToolCallSummary = {
      byName: { edit: 2, write: 1 },
      totalCalls: 3,
      last10: [
        { name: "write", arguments: { path: "/tmp/test.ts" }, result: "success", timestamp: "2026-05-17T22:00:00Z" },
      ],
    };
    expect(classify(makeAssistant(), toolCalls, [])).toBe("C3");
  });

  test("C-UNK — edge case", () => {
    const assistant = makeAssistant({ fullText: "hmm", stopReason: "unknown" });
    expect(classify(assistant, emptyToolCalls, [])).toBe("C-UNK");
  });

  test("loop threshold is configurable", () => {
    const manyToolCalls: ToolCallSummary = {
      byName: { read: 15 },
      totalCalls: 15,
      last10: Array(10).fill({ name: "read", arguments: {}, result: "success" as const, timestamp: "2026-05-17T22:00:00Z" }),
    };
    // Default threshold is 20, so 15 calls should NOT be C5
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [])).not.toBe("C5");
    // But with threshold=10, it should be C5
    expect(classify(makeAssistant({ fullText: "" }), manyToolCalls, [], 10)).toBe("C5");
  });
});

// ── STALE_CLASS_NAMES coverage ─────────────────────────────────────────────

describe("STALE_CLASS_NAMES", () => {
  const classes = ["C1", "C2", "C3", "C4", "C5", "C6", "C-UNK"] as const;
  for (const cls of classes) {
    test(`has name for ${cls}`, () => {
      expect(STALE_CLASS_NAMES[cls]).toBeTruthy();
      expect(typeof STALE_CLASS_NAMES[cls]).toBe("string");
    });
  }
});

// ── buildSnapshot ──────────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  test("produces valid snapshot for a stale session", () => {
    const snapshot = buildSnapshot(
      {
        agentId: "igor",
        sessionKey: "linear-AI-1010",
        startedAt: Date.now() - 30 * 60 * 1000,
        timeoutMs: 25 * 60 * 1000,
        pendingTickets: ["linear-AI-1011"],
      },
      { openclawHome: "/nonexistent" },
    );

    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.metadata.agentId).toBe("igor");
    expect(snapshot.metadata.ticketId).toBe("linear-AI-1010");
    expect(snapshot.metadata.totalDurationMs).toBeGreaterThan(0);
    expect(snapshot.classification).toMatch(/^C[1-6]|C-UNK$/);
    expect(snapshot.toolCallSummary.totalCalls).toBe(0); // nonexistent file = no events
    expect(snapshot.lastAssistantMessage).toBeNull();
    expect(snapshot.linearTicket.identifier).toBe("AI-1010");
  });
});

// ── writeSnapshot ──────────────────────────────────────────────────────────

describe("writeSnapshot", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forensics-test-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes valid JSON to diagnostics dir", () => {
    const snapshot = buildSnapshot(
      {
        agentId: "test-agent",
        sessionKey: "linear-AI-9999",
        startedAt: Date.now() - 30 * 60 * 1000,
        timeoutMs: 25 * 60 * 1000,
        pendingTickets: [],
      },
      { openclawHome: "/nonexistent" },
    );

    const filePath = writeSnapshot(snapshot, { diagnosticsDir: tmpDir });
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(written.capturedAt).toBe(snapshot.capturedAt);
    expect(written.metadata.agentId).toBe("test-agent");
  });
});

// ── aggregateDigest / formatDigestSummary ──────────────────────────────────

describe("aggregateDigest", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-test-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty summary when no digest file exists", () => {
    const summary = aggregateDigest({ diagnosticsDir: tmpDir });
    expect(summary.totalStaleSessions).toBe(0);
    expect(summary.entries).toHaveLength(0);
  });

  test("reads digest entries and aggregates", () => {
    // Write some digest entries
    const digestPath = path.join(tmpDir, "digest.jsonl");
    const entries = [
      { capturedAt: new Date().toISOString(), agent: "igor", ticket: "linear-AI-1001", classification: "C3", classificationName: "Silent completion", totalDurationMs: 1800000, toolCallCount: 5, stopReason: "end_turn", errors: 0, diagnosticPath: "/tmp/test.json" },
      { capturedAt: new Date().toISOString(), agent: "igor", ticket: "linear-AI-1002", classification: "C2", classificationName: "Tool hang", totalDurationMs: 1500000, toolCallCount: 3, stopReason: "tool_use", errors: 0, diagnosticPath: "/tmp/test2.json" },
      { capturedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), agent: "ai", ticket: "linear-AI-900", classification: "C4", classificationName: "Never started", totalDurationMs: 1500000, toolCallCount: 0, stopReason: null, errors: 0, diagnosticPath: "/tmp/old.json" },
    ];
    fs.writeFileSync(digestPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const summary = aggregateDigest({ diagnosticsDir: tmpDir }, 7);
    expect(summary.totalStaleSessions).toBe(2); // old entry filtered out
    expect(summary.byClass["C3"]).toBe(1);
    expect(summary.byClass["C2"]).toBe(1);
    expect(summary.byAgent["igor"]).toBe(2);
  });

  test("formatDigestSummary produces readable text", () => {
    const summary = {
      period: { from: "2026-05-10T00:00:00Z", to: "2026-05-17T00:00:00Z" },
      totalStaleSessions: 4,
      byClass: { C3: 2, C2: 1, C4: 1 },
      byAgent: { igor: 3, ai: 1 },
      entries: [],
    };
    const text = formatDigestSummary(summary);
    expect(text).toContain("Total stale sessions: 4");
    expect(text).toContain("C3");
    expect(text).toContain("50%"); // 2/4 = 50%
    expect(text).toContain("igor: 3");
  });
});
