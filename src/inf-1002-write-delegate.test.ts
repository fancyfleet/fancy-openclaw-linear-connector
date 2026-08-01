import { writeDelegate } from "./delegate-write.js";

function jsonResponse(obj: unknown): Response {
  return { json: async () => obj } as unknown as Response;
}

/** Build a fetch mock that answers the write mutation and the read-back query. */
function mockFetch(opts: {
  writeSuccess?: boolean;
  writeErrors?: string[];
  readBackDelegateId?: string | null;
  readBackThrows?: boolean;
  readBackErrors?: string[];
  readBackOmitsDelegate?: boolean;
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
    if (opts.readBackThrows) throw new Error("read-back network error (INF-984)");
    if (opts.readBackErrors) return jsonResponse({ errors: opts.readBackErrors.map((message) => ({ message })) });
    if (opts.readBackOmitsDelegate) return jsonResponse({ data: { issue: {} } });
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

  it("fails loud (ok:false, verified) when the write silently reverts — read-back mismatch", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: true, readBackDelegateId: "someone-else" }));
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(true); // the read succeeded; the delegate is genuinely wrong
    expect(r.persistedDelegateId).toBe("someone-else");
    expect(r.error).toMatch(/did not persist/);
  });

  it("INF-984: a read-back FAILURE returns unverified (ok:true), NOT a false 'did not persist'", async () => {
    // The write reported success; the verify read throws (single-issue reads fail under stress).
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: true, readBackThrows: true }));
    expect(r.ok).toBe(true); // do NOT churn callers on a read failure
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/unverified/);
  });

  it("INF-984: read-back GraphQL errors also yield unverified (ok:true), not non-persist", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: true, readBackErrors: ["Rate limit exceeded"] }));
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
  });

  it("INF-1005: a partial verify-read that omits delegate is unverified, not a delegate mismatch", async () => {
    const r = await writeDelegate("issue-1", "user-1", "Bearer x", mockFetch({ writeSuccess: true, readBackOmitsDelegate: true }));
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.persistedDelegateId).toBeNull();
    expect(r.error).toMatch(/unverified|read-back/i);
    expect(r.error).not.toMatch(/did not persist/i);
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
