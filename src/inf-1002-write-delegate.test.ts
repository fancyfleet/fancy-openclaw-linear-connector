import { writeDelegate } from "./delegate-write.js";

function jsonResponse(obj: unknown): Response {
  return { json: async () => obj } as unknown as Response;
}

/** Build a fetch mock that answers the write mutation and the read-back query. */
function mockFetch(opts: {
  writeSuccess?: boolean;
  writeErrors?: string[];
  readBackDelegateId?: string | null;
  capture?: Array<{ query: string; variables: Record<string, unknown> }>;
}): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    opts.capture?.push(body);
    if (/issueUpdate/.test(body.query)) {
      if (opts.writeErrors) return jsonResponse({ errors: opts.writeErrors.map((message) => ({ message })) });
      return jsonResponse({ data: { issueUpdate: { success: opts.writeSuccess ?? true } } });
    }
    // read-back query
    const id = opts.readBackDelegateId;
    return jsonResponse({ data: { issue: { delegate: id == null ? null : { id } } } });
  }) as unknown as typeof fetch;
}

describe("INF-1002: writeDelegate chokepoint (INF-973/AI-1395 root-cause close)", () => {
  it("seats an app-user delegate WITH assigneeId:null and verifies persistence via read-back", async () => {
    const capture: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ readBackDelegateId: "user-1", capture }));
    expect(r.ok).toBe(true);
    expect(r.persistedDelegateId).toBe("user-1");
    const mut = capture.find((c) => /issueUpdate/.test(c.query))!;
    expect(mut.query).toContain("assigneeId: $assigneeId"); // the AI-1395 fix
    expect(mut.variables).toEqual({ issueId: "issue-1", delegateId: "user-1", assigneeId: null });
    // a read-back call was made
    expect(capture.some((c) => /VerifyDelegate/.test(c.query))).toBe(true);
  });

  it("fails loud (ok:false) when the write silently reverts — read-back mismatch", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: true, readBackDelegateId: "someone-else" }));
    expect(r.ok).toBe(false);
    expect(r.persistedDelegateId).toBe("someone-else");
    expect(r.error).toMatch(/did not persist/);
  });

  it("clears the delegate WITHOUT touching assigneeId (preserves a human assignee)", async () => {
    const capture: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const r = await writeDelegate("issue-1", null, "Bearer x", mockFetch({ readBackDelegateId: null, capture }));
    expect(r.ok).toBe(true);
    expect(r.persistedDelegateId).toBeNull();
    const mut = capture.find((c) => /issueUpdate/.test(c.query))!;
    expect(mut.query).not.toContain("assigneeId");
    expect(mut.variables).toEqual({ issueId: "issue-1" });
  });

  it("returns ok:false on GraphQL errors (no false success)", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeErrors: ["delegateId must be a UUID"] }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/UUID/);
  });

  it("returns ok:false when issueUpdate reports success:false", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: false, readBackDelegateId: null }));
    expect(r.ok).toBe(false);
  });
});
