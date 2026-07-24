/**
 * INF-529: unit tests for the leaked-credential rotation gate (Layer 1) and the
 * shared artifact-detection predicate.
 */

import { jest, describe, it, expect, afterEach } from "@jest/globals";
import {
  SEC_LEAKED_CREDENTIAL_LABEL,
  commentConfirmsRotation,
  anyCommentConfirmsRotation,
} from "./leaked-credential-artifact.js";
import { checkLeakedCredentialGate, CLOSE_INTENTS } from "./leaked-credential-gate.js";

// ── Fake Linear transport ────────────────────────────────────────────────────

interface MockOpts {
  labels?: string[];
  comments?: string[];
  stateType?: string; // WorkflowState.type for a stateId lookup
  failLabels?: boolean;
  failComments?: boolean;
  failStateType?: boolean;
}

function installMockFetch(opts: MockOpts): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { query: string };
    const q = parsed.query;
    if (q.includes("IssueLabels")) {
      if (opts.failLabels) throw new Error("boom-labels");
      return jsonResponse({ data: { issue: { labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) } } } });
    }
    if (q.includes("LeakedCredComments")) {
      if (opts.failComments) throw new Error("boom-comments");
      return jsonResponse({ data: { issue: { comments: { nodes: (opts.comments ?? []).map((body) => ({ body })) } } } });
    }
    if (q.includes("StateType")) {
      if (opts.failStateType) throw new Error("boom-state");
      return jsonResponse({ data: { workflowState: { type: opts.stateType ?? "started" } } });
    }
    throw new Error(`unexpected query: ${q}`);
  });
}

function jsonResponse(obj: unknown): { json: () => Promise<unknown> } {
  return { json: async () => obj };
}

const AUTH = "Bearer test";
const ID = "issue-uuid-1";

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Artifact predicate ───────────────────────────────────────────────────────

describe("commentConfirmsRotation", () => {
  it("accepts the structured marker with revoked:true", () => {
    expect(commentConfirmsRotation('<!-- rotation-confirmed: {"credential":"GEMINI_API_KEY","revoked":true} -->')).toBe(true);
  });

  it("rejects the structured marker without revocation", () => {
    expect(commentConfirmsRotation('<!-- rotation-confirmed: {"credential":"X","revoked":false} -->')).toBe(false);
    expect(commentConfirmsRotation('<!-- rotation-confirmed: {"credential":"X"} -->')).toBe(false);
  });

  it("accepts a ROTATION-CONFIRMED plaintext line that asserts revocation", () => {
    expect(commentConfirmsRotation("ROTATION-CONFIRMED: rotated GEMINI_API_KEY, old value revoked in console.")).toBe(true);
    expect(commentConfirmsRotation("notes above\nROTATION-CONFIRMED — key deleted from Google console")).toBe(true);
  });

  it("rejects a ROTATION-CONFIRMED line with no revocation signal", () => {
    expect(commentConfirmsRotation("ROTATION-CONFIRMED: generated a new key")).toBe(false);
  });

  it("rejects unrelated / empty comments", () => {
    expect(commentConfirmsRotation("closing as invalid, dup of AI-2371")).toBe(false);
    expect(commentConfirmsRotation("")).toBe(false);
  });

  it("does not accept a corrupt marker", () => {
    expect(commentConfirmsRotation("<!-- rotation-confirmed: {not json} -->")).toBe(false);
  });

  it("anyCommentConfirmsRotation scans a set", () => {
    expect(anyCommentConfirmsRotation(["nope", "still nope", "ROTATION-CONFIRMED: revoked"])).toBe(true);
    expect(anyCommentConfirmsRotation(["nope", "still nope"])).toBe(false);
  });
});

// ── Gate: pass-through (no network) ──────────────────────────────────────────

describe("checkLeakedCredentialGate — non-close pass-through", () => {
  it("returns null for a non-close intent with no stateId, without any fetch", async () => {
    const fetchSpy = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    const result = await checkLeakedCredentialGate("note", ID, AUTH, null, false);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null (bypass) under break-glass even on a close", async () => {
    const fetchSpy = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    const result = await checkLeakedCredentialGate("complete-work", ID, AUTH, null, true);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when issueId is missing", async () => {
    const result = await checkLeakedCredentialGate("complete-work", null, AUTH, null, false);
    expect(result).toBeNull();
  });
});

// ── Gate: label scoping ──────────────────────────────────────────────────────

describe("checkLeakedCredentialGate — label scoping", () => {
  it("returns null for a close on an UNlabelled ticket", async () => {
    installMockFetch({ labels: ["bug", "state:done"], comments: [] });
    const result = await checkLeakedCredentialGate("complete-work", ID, AUTH, null, false);
    expect(result).toBeNull();
  });

  it("fails open when the label fetch fails", async () => {
    installMockFetch({ failLabels: true });
    const result = await checkLeakedCredentialGate("complete-work", ID, AUTH, null, false);
    expect(result).toBeNull();
  });
});

// ── Gate: the enforcement core ───────────────────────────────────────────────

describe("checkLeakedCredentialGate — enforcement", () => {
  it("BLOCKS a semantic close of a labelled ticket with no artifact", async () => {
    installMockFetch({ labels: [SEC_LEAKED_CREDENTIAL_LABEL], comments: ["closing, dup"] });
    const result = await checkLeakedCredentialGate("refuse-work", ID, AUTH, null, false);
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
    expect(result).toContain(SEC_LEAKED_CREDENTIAL_LABEL);
  });

  it("ALLOWS a close of a labelled ticket once a rotation artifact is present", async () => {
    installMockFetch({
      labels: [SEC_LEAKED_CREDENTIAL_LABEL],
      comments: ["work log", "ROTATION-CONFIRMED: key rotated and old value revoked"],
    });
    const result = await checkLeakedCredentialGate("complete-work", ID, AUTH, null, false);
    expect(result).toBeNull();
  });

  it("BLOCKS a raw stateId close (type=canceled) of a labelled ticket with no artifact", async () => {
    installMockFetch({ labels: [SEC_LEAKED_CREDENTIAL_LABEL], comments: [], stateType: "canceled" });
    const result = await checkLeakedCredentialGate(null, ID, AUTH, "state-uuid", false);
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("BLOCKS a raw stateId close (type=completed) of a labelled ticket with no artifact", async () => {
    installMockFetch({ labels: [SEC_LEAKED_CREDENTIAL_LABEL], comments: [], stateType: "completed" });
    const result = await checkLeakedCredentialGate(null, ID, AUTH, "state-uuid", false);
    expect(result).not.toBeNull();
  });

  it("returns null for a raw stateId move to a NON-closing state (type=started)", async () => {
    installMockFetch({ labels: [SEC_LEAKED_CREDENTIAL_LABEL], comments: [], stateType: "started" });
    const result = await checkLeakedCredentialGate(null, ID, AUTH, "state-uuid", false);
    expect(result).toBeNull();
  });

  it("FAILS CLOSED: labelled close blocks when the comment fetch fails", async () => {
    installMockFetch({ labels: [SEC_LEAKED_CREDENTIAL_LABEL], failComments: true });
    const result = await checkLeakedCredentialGate("complete-work", ID, AUTH, null, false);
    expect(result).not.toBeNull();
    expect(result).toContain("blocked");
  });

  it("treats an unresolvable stateId as non-close (fail open) for an unlabelled-path mutation", async () => {
    // stateType fetch fails and intent is not a close verb → not a close → null,
    // without ever needing labels/comments.
    installMockFetch({ failStateType: true });
    const result = await checkLeakedCredentialGate("update", ID, AUTH, "state-uuid", false);
    expect(result).toBeNull();
  });
});

describe("CLOSE_INTENTS", () => {
  it("covers the resolving verbs", () => {
    for (const v of ["complete-work", "complete", "refuse-work", "cancel", "abandon"]) {
      expect(CLOSE_INTENTS.has(v)).toBe(true);
    }
    expect(CLOSE_INTENTS.has("note")).toBe(false);
    expect(CLOSE_INTENTS.has("handoff-work")).toBe(false);
  });
});
