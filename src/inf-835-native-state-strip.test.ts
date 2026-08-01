/**
 * INF-835: governed workflow intents must not forward native stateId writes.
 *
 * A wf:task sign-off rejection (`request-revision` -> `reject`) closed a ticket
 * as Done. The proxy already strips state:* label deltas so B2 is the sole
 * workflow-state writer, but the forwarded CLI mutation could still carry a
 * native Linear `stateId` before B2 resolved the def destination. Strip that too.
 */

import { describe, expect, it } from "@jest/globals";
import { _stripNativeStateFieldForTests } from "./proxy.js";

describe("INF-835 native state stripping", () => {
  it("removes stateId from an issueUpdate input while preserving other fields", () => {
    const body = {
      query: "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: {
        id: "INF-819",
        input: {
          stateId: "linear-done-state",
          delegateId: "ai-app-user",
          addedLabelIds: ["non-state-label"],
        },
      },
    };

    const stripped = _stripNativeStateFieldForTests(body);

    expect(stripped).toBe(true);
    expect(body.variables.input).toEqual({
      delegateId: "ai-app-user",
      addedLabelIds: ["non-state-label"],
    });
  });

  it("is a no-op when the mutation has no native state field", () => {
    const body = {
      query: "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: {
        id: "INF-819",
        input: {
          delegateId: "worker-user",
        },
      },
    };

    expect(_stripNativeStateFieldForTests(body)).toBe(false);
    expect(body.variables.input).toEqual({ delegateId: "worker-user" });
  });
});
