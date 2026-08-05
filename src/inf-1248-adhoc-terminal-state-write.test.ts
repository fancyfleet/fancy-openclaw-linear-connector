/**
 * INF-1248: semantic terminal verbs (complete/cancel/park) silently no-op the
 * Linear state write on ad-hoc / label-less tickets.
 *
 * Root cause: the proxy strips the CLI's forwarded native `stateId` (INF-835) so
 * that applyStateTransition (B2) is the sole native-state writer. But B2 no-ops on
 * ad-hoc tickets (no wf:* label → no workflow def → `code:"ad-hoc"`), so on those
 * tickets nothing writes the state: the delegate clear + comment land, the state
 * stays live, and the verb reports success ("Done-that-isn't").
 *
 * Fix: only strip the CLI stateId for GOVERNED workflow tickets (or when
 * workflow-ness is unknown, fail-safe). On a confirmed ad-hoc ticket the CLI's
 * resolved terminal stateId is the sole writer and must pass through — exactly what
 * the manual break-glass `issueUpdate(id, {stateId})` workaround did.
 */

import { describe, expect, it } from "@jest/globals";
import {
  shouldStripForwardedNativeState,
  _stripNativeStateFieldForTests,
} from "./proxy.js";

describe("INF-1248 ad-hoc terminal state write", () => {
  describe("shouldStripForwardedNativeState gating", () => {
    it("strips for a governed workflow ticket (workflow id present)", () => {
      // B2 will write the resolved destination — CLI stateId must not race it.
      expect(shouldStripForwardedNativeState("task")).toBe(true);
      expect(shouldStripForwardedNativeState("dev-impl")).toBe(true);
    });

    it("does NOT strip for a confirmed ad-hoc / label-less ticket (null)", () => {
      // B2 no-ops on ad-hoc; the CLI stateId is the sole writer and must survive.
      expect(shouldStripForwardedNativeState(null)).toBe(false);
    });

    it("strips (fail-safe) when workflow-ness is unknown (fetch failed → undefined)", () => {
      // Preserve the pre-INF-1248 posture on unknowns so a governed transition
      // can never partial-apply if the pre-forward label fetch throws.
      expect(shouldStripForwardedNativeState(undefined)).toBe(true);
    });
  });

  describe("end-to-end strip decision on a `complete`-shaped mutation", () => {
    // The shape the CLI forwards for `linear complete` on an ad-hoc ticket:
    // resolved terminal stateId + delegate clear, no state:* label delta.
    const completeMutation = () => ({
      query:
        "mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
      variables: {
        id: "INF-1241",
        input: {
          stateId: "linear-done-state",
          delegateId: null,
        },
      },
    });

    it("preserves stateId on an ad-hoc ticket (regression guard for the silent no-op)", () => {
      const body = completeMutation();
      if (shouldStripForwardedNativeState(null)) {
        _stripNativeStateFieldForTests(body);
      }
      // stateId survives → the forwarded mutation actually moves the ticket to Done.
      expect(body.variables.input.stateId).toBe("linear-done-state");
    });

    it("strips stateId on a governed workflow ticket (B2 becomes sole writer)", () => {
      const body = completeMutation();
      if (shouldStripForwardedNativeState("task")) {
        _stripNativeStateFieldForTests(body);
      }
      expect("stateId" in body.variables.input).toBe(false);
      // delegate clear is untouched by the native-state strip.
      expect(body.variables.input.delegateId).toBeNull();
    });
  });
});
