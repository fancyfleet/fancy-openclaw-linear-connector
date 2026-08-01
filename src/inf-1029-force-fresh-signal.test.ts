/**
 * INF-1029 — Connector emits a force-fresh signal on the C4 husk re-poke path.
 *
 * Gateway-side "fresh instead of continuation" behavior is covered by INF-977.
 * These connector tests pin the regression surface: C4 re-poke must keep the
 * stable per-ticket key while adding the reset signal to the delivery call.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";

const INDEX = path.join(process.cwd(), "src", "index.ts");

function source(): string {
  return fs.readFileSync(INDEX, "utf8");
}

describe("INF-1029: C4 husk redispatch force-fresh connector signal", () => {
  it("preserves the stable linear-<id> C4 session key invariant", () => {
    const text = source();
    const c4Block = text.slice(
      text.indexOf("const recovery = await recoverTicket"),
      text.indexOf("// 7. Re-signal pending tickets"),
    );

    expect(c4Block).toContain("const sessionKey = normalizeSessionKey(ticketId)");
    expect(c4Block).toContain("deliverMessageToAgent(stale.agentId, sessionKey, rePokeMsg");
    expect(c4Block).not.toMatch(/sessionKey\s*=\s*[^;\n]*(fresh|reset|Date\.now|randomUUID)/i);
  });

  it("INF-1029 red baseline: C4 re-poke passes forceFreshSession to delivery for totalCalls:0 husks", () => {
    const text = source();
    const c4Block = text.slice(
      text.indexOf("const recovery = await recoverTicket"),
      text.indexOf("// 7. Re-signal pending tickets"),
    );

    // The totalCalls:0 classification happens in stale-session forensics; this
    // connector-side regression pins only the C4 re-poke handoff into delivery.
    expect(c4Block).toMatch(
      /deliverMessageToAgent\(\s*stale\.agentId,\s*sessionKey,\s*rePokeMsg,\s*\{[\s\S]*\.\.\.wakeConfigForAgent\(stale\.agentId\)[\s\S]*forceFreshSession:\s*true[\s\S]*\}\s*\)/,
    );
  });
});
