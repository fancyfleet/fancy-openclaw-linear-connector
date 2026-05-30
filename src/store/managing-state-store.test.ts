import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ManagingStateStore } from "./managing-state-store.js";

function makeStore(): { store: ManagingStateStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managing-store-"));
  const dbPath = path.join(dir, "managing.db");
  const store = new ManagingStateStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("ManagingStateStore", () => {
  let active: { cleanup: () => void } | null = null;
  afterEach(() => {
    active?.cleanup();
    active = null;
  });

  it("returns null for unknown (agent, ticket)", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    expect(store.getLastDispatched("charles", "AI-1")).toBeNull();
  });

  it("records a dispatch and reads it back", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.recordDispatch("charles", "AI-1", 1000);
    expect(store.getLastDispatched("charles", "AI-1")).toBe(1000);
  });

  it("upserts on second recordDispatch", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.recordDispatch("charles", "AI-1", 1000);
    store.recordDispatch("charles", "AI-1", 2000);
    expect(store.getLastDispatched("charles", "AI-1")).toBe(2000);
  });

  it("ensure() inserts with null lastDispatchedAt and does not overwrite existing", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.ensure("charles", "AI-1");
    expect(store.getLastDispatched("charles", "AI-1")).toBeNull();
    store.recordDispatch("charles", "AI-1", 500);
    store.ensure("charles", "AI-1");
    expect(store.getLastDispatched("charles", "AI-1")).toBe(500);
  });

  it("remove() deletes a single (agent, ticket)", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.recordDispatch("charles", "AI-1", 100);
    store.recordDispatch("charles", "AI-2", 200);
    store.remove("charles", "AI-1");
    expect(store.getLastDispatched("charles", "AI-1")).toBeNull();
    expect(store.getLastDispatched("charles", "AI-2")).toBe(200);
  });

  it("pruneAgent() removes rows not in the current set", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.recordDispatch("charles", "AI-1", 100);
    store.recordDispatch("charles", "AI-2", 200);
    store.recordDispatch("charles", "AI-3", 300);
    store.recordDispatch("astrid", "AI-9", 999);
    const removed = store.pruneAgent("charles", ["AI-2"]);
    expect(removed).toBe(2);
    expect(store.getLastDispatched("charles", "AI-1")).toBeNull();
    expect(store.getLastDispatched("charles", "AI-2")).toBe(200);
    expect(store.getLastDispatched("charles", "AI-3")).toBeNull();
    expect(store.getLastDispatched("astrid", "AI-9")).toBe(999);
  });

  it("pruneAgent() with empty list removes all for that agent", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.recordDispatch("charles", "AI-1", 100);
    store.recordDispatch("charles", "AI-2", 200);
    store.recordDispatch("astrid", "AI-9", 999);
    const removed = store.pruneAgent("charles", []);
    expect(removed).toBe(2);
    expect(store.listByAgent("charles")).toHaveLength(0);
    expect(store.getLastDispatched("astrid", "AI-9")).toBe(999);
  });

  it("listByAgent() returns all entries for that agent", () => {
    const { store, cleanup } = makeStore();
    active = { cleanup };
    store.ensure("charles", "AI-1");
    store.recordDispatch("charles", "AI-2", 200);
    const entries = store.listByAgent("charles").sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    expect(entries).toEqual([
      { agentId: "charles", ticketId: "AI-1", lastDispatchedAt: null },
      { agentId: "charles", ticketId: "AI-2", lastDispatchedAt: 200 },
    ]);
  });
});
