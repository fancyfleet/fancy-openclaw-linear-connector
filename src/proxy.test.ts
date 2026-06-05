/**
 * Tests for the Phase 0B connector-as-proxy pass-through (design.md §4.6).
 *
 * We mock the upstream fetch so these tests never reach api.linear.app.
 */

import request from "supertest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createApp } from "./index.js";
import { reloadAgents } from "./agents.js";

// Minimal agents.json so createApp() doesn't complain.
function writeAgents(dir: string): string {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ agents: [{ name: "charles", linearUserId: "u1", openclawAgent: "charles", accessToken: "tok", host: "local" }] }),
    "utf8"
  );
  return file;
}

const MOCK_RESPONSE = { data: { viewer: { id: "user-1", name: "Charles" } } };

describe("proxy /proxy/graphql", () => {
  let dir: string;
  let appState: ReturnType<typeof createApp>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
    process.env.AGENTS_FILE = writeAgents(dir);
    reloadAgents();
    appState = createApp({
      bagDbPath: path.join(dir, "bag.db"),
      agentQueueDbPath: path.join(dir, "queue.db"),
      operationalEventsDbPath: path.join(dir, "events.db"),
    });

    // Capture real fetch and replace with mock.
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      // Only intercept Linear API calls.
      if (typeof url === "string" && url.includes("api.linear.app")) {
        return new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    appState.bag.close();
    appState.sessionTracker.close();
    appState.agentQueue.close();
    appState.operationalEventStore.close();
    appState.watchdog.stop();
    appState.noActivityDetector.stop();
    appState.managingPoller.stop();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .send({ query: "{ viewer { id } }" });
    expect(res.status).toBe(401);
    expect(res.body.errors).toBeDefined();
  });

  it("forwards requests to Linear and returns the response transparently", async () => {
    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Openclaw-Agent", "charles")
      .send({ query: "{ viewer { id name } }", operationName: "ViewerQuery" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_RESPONSE);
  });

  it("passes the Authorization header to Linear unchanged", async () => {
    let capturedAuth: string | undefined;
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
        return new Response(JSON.stringify(MOCK_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, init);
    };

    await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer my-agent-token")
      .send({ query: "{ viewer { id } }" });

    expect(capturedAuth).toBe("Bearer my-agent-token");
  });

  it("returns 502 when Linear API is unreachable", async () => {
    globalThis.fetch = async (url) => {
      if (typeof url === "string" && url.includes("api.linear.app")) {
        throw new Error("ECONNREFUSED");
      }
      return originalFetch(url);
    };

    const res = await request(appState.app)
      .post("/proxy/graphql")
      .set("Authorization", "Bearer test-token")
      .send({ query: "{ viewer { id } }" });

    expect(res.status).toBe(502);
    expect(res.body.errors[0].message).toContain("ECONNREFUSED");
  });
});
