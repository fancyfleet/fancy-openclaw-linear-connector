/**
 * INF-752: connector fail-closed decline reason never reaches the CLI —
 * `commentCreate` mutations declare `$issueId` as `ID!` while Linear's
 * `CommentCreateInput.issueId` field is `String`, so every comment-post 400s
 * with GRAPHQL_VALIDATION_FAILED and the reason is silently dropped in the
 * host journal.
 *
 * Journal evidence (INF-746 approve retries):
 *   [workflow-gate] postComment HTTP 400 ...
 *   Variable "$issueId" of type "ID!" used in position expecting type "String".
 *
 * The fix declares `$issueId` as `String!` everywhere `commentCreate` is posted
 * to Linear — matching the already-fixed reference paths (index.ts:948,
 * delegate-ping-pong-detector.ts) so decline reasons actually reach the CLI.
 */

import { describe, it, expect, jest } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { _postCommentForTests } from "./workflow-gate.js";

describe("INF-752: commentCreate uses Linear's String issueId type", () => {
  // ── Behavior: the AC path (failDelegateUnresolved → postComment) ──────────
  // postComment is the single delivery point for every delegate-unresolved
  // fail-close remedy comment. The mutation it sends to Linear must declare
  // $issueId as String! or Linear rejects it at validation time (400) and the
  // decline reason never reaches the operator.
  describe("postComment outbound mutation (fail-close remedy delivery)", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      jest.restoreAllMocks();
    });

    it("declares $issueId as String!, not ID!, in the query sent to Linear", async () => {
      let capturedQuery = "";
      globalThis.fetch = (async (_url: unknown, init: any) => {
        capturedQuery = JSON.parse(init.body).query;
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1" } } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof globalThis.fetch;

      await _postCommentForTests("issue-uuid", "[Connector] Transition blocked: supply --target", "Bearer tok");

      // Linear's CommentCreateInput.issueId is String — an ID! variable in a
      // String position is a GRAPHQL_VALIDATION_FAILED 400.
      expect(capturedQuery).toContain("$issueId: String!");
      expect(capturedQuery).not.toContain("$issueId: ID!");
    });
  });

  // ── Source guard: the whole defect class, not just the AC branch ─────────
  // Every commentCreate against the Linear API shares this bug. Guarding the
  // source (same precedent as delegate-ping-pong-detector.test.ts) stops a new
  // ID!-typed commentCreate from silently 400-ing in any of these files.
  describe("no commentCreate mutation declares $issueId as ID! (source guard)", () => {
    const files = [
      "src/workflow-gate.ts",
      "src/linear-helpers.ts",
      "src/escalation.ts",
      "src/fanout.ts",
      "src/routing-guard.ts",
      "src/bag/stale-session-forensics.ts",
    ];

    it.each(files)("%s posts commentCreate with a String issueId variable", (file) => {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      // The exact form the Linear schema rejects for commentCreate.
      expect(source).not.toContain("$issueId: ID!, $body: String!");
    });
  });
});
