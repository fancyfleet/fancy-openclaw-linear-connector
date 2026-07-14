import { describe, expect, it } from "@jest/globals";

import { buildManagingWakeMessage } from "./managing-wake.js";

describe("buildManagingWakeMessage", () => {
  it("throws when given no tickets", () => {
    expect(() => buildManagingWakeMessage([])).toThrow();
  });

  it("formats a first-review ticket", () => {
    const msg = buildManagingWakeMessage(
      [{ identifier: "AI-1", title: "Wire up X", lastDispatchedAt: null }],
      1_000_000,
    );
    expect(msg).toContain("You are managing these tickets:");
    expect(msg).toContain("- AI-1: Wire up X (last reviewed: first review)");
    expect(msg).toContain("Check subtask state");
    expect(msg).toContain("delta-only note");
    expect(msg).toContain("Do not restate unchanged child status");
    expect(msg).toContain("Move tickets out of Managing");
  });

  it("formats minute / hour / day relative timestamps", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const msg = buildManagingWakeMessage(
      [
        { identifier: "AI-1", title: "T1", lastDispatchedAt: now - 30 * 1000 },
        { identifier: "AI-2", title: "T2", lastDispatchedAt: now - 5 * 60 * 1000 },
        { identifier: "AI-3", title: "T3", lastDispatchedAt: now - 3 * 60 * 60 * 1000 },
        { identifier: "AI-4", title: "T4", lastDispatchedAt: now - 2 * 24 * 60 * 60 * 1000 },
      ],
      now,
    );
    expect(msg).toContain("30s ago");
    expect(msg).toContain("5m ago");
    expect(msg).toContain("3h ago");
    expect(msg).toContain("2d ago");
  });

  it("bundles multiple tickets into one message", () => {
    const msg = buildManagingWakeMessage(
      [
        { identifier: "AI-1", title: "First", lastDispatchedAt: null },
        { identifier: "AI-2", title: "Second", lastDispatchedAt: null },
      ],
      0,
    );
    const lines = msg.split("\n");
    const headerIdx = lines.indexOf("You are managing these tickets:");
    expect(headerIdx).toBe(0);
    expect(lines[1]).toMatch(/AI-1/);
    expect(lines[2]).toMatch(/AI-2/);
  });
});
