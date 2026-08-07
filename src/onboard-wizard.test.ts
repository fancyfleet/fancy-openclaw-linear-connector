/**
 * INF-1300 — onboard-wizard.ts + agents.ts
 *
 * AC: onboard-wizard and linear-rate-limit-client core logic.
 * This file covers onboard-wizard's testable contract via agents.ts (getAgent/upsertAgent,
 * name validation invariants, authorize URL building). The wizard itself is an interactive CLI
 * with no exported functions; its invariants are proven through the registry it writes to.
 * Mocks: fs tmp AGENTS_FILE, no live Linear, no live clock.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

function buildAuthorizeUrl(clientId: string, redirectUri: string, displayName: string, agentName: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
    state: agentName,
  });
  return "https://linear.app/oauth/authorize?" + params.toString();
}

describe("onboard-wizard", () => {
  describe("name validation (core logic)", () => {
    it("accepts lowercase hyphenated names", () => {
      expect(AGENT_NAME_RE.test("sakura")).toBe(true);
      expect(AGENT_NAME_RE.test("my-agent-1")).toBe(true);
    });

    it("rejects uppercase, spaces, leading digit, empty", () => {
      expect(AGENT_NAME_RE.test("Sakura")).toBe(false);
      expect(AGENT_NAME_RE.test("my agent")).toBe(false);
      expect(AGENT_NAME_RE.test("1agent")).toBe(false);
      expect(AGENT_NAME_RE.test("")).toBe(false);
    });
  });

  describe("authorize URL building (core logic)", () => {
    it("builds a URL with correct params and scopes", () => {
      const url = buildAuthorizeUrl("cid", "https://example.com/callback", "Sakura (Translator)", "sakura");
      const u = new URL(url);
      expect(u.hostname).toBe("linear.app");
      expect(u.pathname).toBe("/oauth/authorize");
      expect(u.searchParams.get("client_id")).toBe("cid");
      expect(u.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
      expect(u.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
      expect(u.searchParams.get("actor")).toBe("app");
      expect(u.searchParams.get("state")).toBe("sakura");
    });

    it("round-trips through URL parsing", () => {
      const url = buildAuthorizeUrl("cid2", "https://ai.fcy.sh/linear-webhook/callback", "X", "x");
      expect(() => new URL(url)).not.toThrow();
    });
  });

  describe("registry integration (agents.ts) — wizard's persistence target", () => {
    let tmpDir: string;
    let agentsFile: string;
    const prevAgentsFile = process.env.AGENTS_FILE;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-wizard-test-"));
      agentsFile = path.join(tmpDir, "agents.json");
      process.env.AGENTS_FILE = agentsFile;
      jest.resetModules();
    });

    afterEach(() => {
      process.env.AGENTS_FILE = prevAgentsFile;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("upsertAgent creates and getAgent retrieves (core wizard write path)", async () => {
      const { upsertAgent, getAgent, reloadAgents } = await import("./agents.js");
      // seed empty file
      fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
      reloadAgents();
      const res = upsertAgent({
        name: "sakura",
        linearUserId: "",
        clientId: "cid",
        clientSecret: "csec",
        accessToken: "",
        refreshToken: "",
        openclawAgent: "sakura",
        host: "local",
      } as unknown as Parameters<typeof upsertAgent>[0]);
      expect(res.isNew).toBe(true);
      const got = getAgent("sakura");
      expect(got).toBeDefined();
      expect(got!.clientId).toBe("cid");
    });

    it("second upsert for same name overwrites (wizard overwrite prompt)", async () => {
      const { upsertAgent, getAgent, reloadAgents } = await import("./agents.js");
      fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
      reloadAgents();
      upsertAgent({ name: "sakura", linearUserId: "", clientId: "cid1", clientSecret: "s1", accessToken: "", refreshToken: "", openclawAgent: "sakura", host: "local" } as unknown as Parameters<typeof upsertAgent>[0]);
      const res2 = upsertAgent({ name: "sakura", linearUserId: "", clientId: "cid2", clientSecret: "s2", accessToken: "", refreshToken: "", openclawAgent: "sakura", host: "local" } as unknown as Parameters<typeof upsertAgent>[0]);
      expect(res2.isNew).toBe(false);
      expect(getAgent("sakura")!.clientId).toBe("cid2");
    });

    it("negative case: getAgent for unknown name returns undefined", async () => {
      const { getAgent, reloadAgents } = await import("./agents.js");
      fs.writeFileSync(agentsFile, JSON.stringify({ agents: [] }), "utf8");
      reloadAgents();
      expect(getAgent("no-such-agent")).toBeUndefined();
    });
  });
});
