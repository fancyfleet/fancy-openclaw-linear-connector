/**
 * INF-348: sla-sweep and anti-entropy must resolve Linear auth per tick.
 *
 * Token refresh mutates the in-memory agent store after boot and every 20h.
 * Passing a boot-captured token into cron registration leaves long-running
 * crons with revoked credentials.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX_TS = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);

describe("INF-348: cron auth token refresh wiring", () => {
  it("defines a resolver that reads the dedicated service credential, not the ai agent token", () => {
    expect(INDEX_TS).toContain("const resolveCronAuthToken = () => resolveServiceCredential()");
    expect(INDEX_TS.includes('getAccessToken("ai")')).toBe(false);
  });

  it("passes the live resolver into sla-sweep instead of a captured token value", () => {
    expect(INDEX_TS).toContain("registerSlaSweepCron({");
    expect(INDEX_TS).toContain("authToken: resolveCronAuthToken");
  });

  it("passes the live resolver into anti-entropy instead of a captured token value", () => {
    expect(INDEX_TS).toContain("registerAntiEntropyCron({ authToken: resolveCronAuthToken })");
  });
});
