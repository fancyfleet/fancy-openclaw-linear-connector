/**
 * Tests for Phase 6.5 / H-2 — Spawn-preview gate + hard recursion caps (AI-1477).
 *
 * Covers:
 *   - checkCaps: hard cap enforcement (max_children, max_depth, approval_above)
 *   - resolveDepth: tree depth resolution
 *   - generateSpawnPreview: preview generation
 *   - formatPreviewComment / formatCapRefusalComment: formatting
 *   - parseSpawnCaps: environment variable parsing
 *   - Integration: fan-out respects caps and generates preview
 */

import {
  checkCaps,
  parseSpawnCaps,
  formatPreviewComment,
  formatCapRefusalComment,
  DEFAULT_SPAWN_CAPS,
  type SpawnCaps,
} from "./spawn-preview.js";

// ── checkCaps ──────────────────────────────────────────────────────────────

describe("checkCaps", () => {
  it("allows a spawn within all caps", () => {
    const result = checkCaps(5, 0);
    expect(result.allowed).toBe(true);
    expect(result.needsApproval).toBe(false);
    expect(result.refusalReason).toBeUndefined();
  });

  it("allows a spawn at exactly max_children (may need approval)", () => {
    const result = checkCaps(DEFAULT_SPAWN_CAPS.maxChildren, 0);
    expect(result.allowed).toBe(true);
    // max_children=20 > approval_above=10, so approval IS required
    expect(result.needsApproval).toBe(true);
  });

  // AC1: A fan-out exceeding max_children is refused (not truncated).
  it("AC1: REFUSES when proposed count exceeds max_children (not truncated)", () => {
    const result = checkCaps(DEFAULT_SPAWN_CAPS.maxChildren + 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.refusalReason).toContain("Child count cap exceeded");
    expect(result.refusalReason).toContain("REFUSED (not truncated)");
  });

  it("REFUSES when depth >= max_depth", () => {
    const result = checkCaps(1, DEFAULT_SPAWN_CAPS.maxDepth);
    expect(result.allowed).toBe(false);
    expect(result.refusalReason).toContain("Recursion depth cap exceeded");
  });

  it("allows at depth just below max_depth", () => {
    const result = checkCaps(1, DEFAULT_SPAWN_CAPS.maxDepth - 1);
    expect(result.allowed).toBe(true);
  });

  // AC2: A spawn above approval_above requires steward approval.
  it("AC2: requires approval when proposed count > approval_above", () => {
    const result = checkCaps(DEFAULT_SPAWN_CAPS.approvalAbove + 1, 0);
    expect(result.allowed).toBe(true);
    expect(result.needsApproval).toBe(true);
  });

  it("does not require approval at exactly approval_above", () => {
    const result = checkCaps(DEFAULT_SPAWN_CAPS.approvalAbove, 0);
    expect(result.allowed).toBe(true);
    expect(result.needsApproval).toBe(false);
  });

  it("depth cap takes priority over child count cap", () => {
    // Both caps violated — depth should be checked first
    const result = checkCaps(DEFAULT_SPAWN_CAPS.maxChildren + 10, DEFAULT_SPAWN_CAPS.maxDepth);
    expect(result.allowed).toBe(false);
    expect(result.refusalReason).toContain("Recursion depth cap exceeded");
  });

  it("depth cap takes priority over approval gate", () => {
    const result = checkCaps(DEFAULT_SPAWN_CAPS.approvalAbove + 5, DEFAULT_SPAWN_CAPS.maxDepth);
    expect(result.allowed).toBe(false);
    expect(result.refusalReason).toContain("Recursion depth cap");
  });

  it("respects custom caps", () => {
    const customCaps: SpawnCaps = { maxChildren: 5, maxDepth: 2, approvalAbove: 3 };

    // Within custom caps
    const within = checkCaps(3, 1, customCaps);
    expect(within.allowed).toBe(true);
    expect(within.needsApproval).toBe(false);

    // Exceeds custom max_children
    const overChildren = checkCaps(6, 0, customCaps);
    expect(overChildren.allowed).toBe(false);
    expect(overChildren.refusalReason).toContain("proposed 6 children > max_children 5");

    // At custom max_depth
    const atDepth = checkCaps(1, 2, customCaps);
    expect(atDepth.allowed).toBe(false);

    // Over custom approval_above
    const overApproval = checkCaps(4, 0, customCaps);
    expect(overApproval.allowed).toBe(true);
    expect(overApproval.needsApproval).toBe(true);
  });

  it("includes caps and proposed values in result", () => {
    const result = checkCaps(7, 1);
    expect(result.caps).toEqual(DEFAULT_SPAWN_CAPS);
    expect(result.depth).toBe(1);
    expect(result.proposedCount).toBe(7);
  });
});

// ── formatPreviewComment ──────────────────────────────────────────────────

describe("formatPreviewComment", () => {
  it("formats an approved preview", () => {
    const preview = {
      parentIssueId: "AI-1440",
      childCount: 3,
      children: [
        { index: 0, title: "Finding A", workflow: "dev-impl", seedAc: "Finding A" },
        { index: 1, title: "Finding B", description: "Desc B", workflow: "dev-impl", seedAc: "Finding B: Desc B" },
        { index: 2, title: "Finding C", workflow: "dev-impl", seedAc: "Finding C" },
      ],
      currentDepth: 0,
      requiresApproval: false,
      capResult: checkCaps(3, 0),
    };

    const comment = formatPreviewComment(preview);

    expect(comment).toContain("[Spawn Preview]");
    expect(comment).toContain("AI-1440");
    expect(comment).toContain("**Proposed children:** 3");
    expect(comment).toContain("**Tree depth:** 0");
    expect(comment).toContain("1. **Finding A**");
    expect(comment).toContain("2. **Finding B**");
    expect(comment).toContain("_Desc B_");
    expect(comment).toContain("3. **Finding C**");
    expect(comment).toContain("✅ Preview generated");
  });

  it("formats a refused preview", () => {
    const preview = {
      parentIssueId: "AI-1440",
      childCount: 50,
      children: Array.from({ length: 50 }, (_, i) => ({
        index: i,
        title: `Finding ${i + 1}`,
        workflow: "dev-impl",
        seedAc: `Finding ${i + 1}`,
      })),
      currentDepth: 0,
      requiresApproval: false,
      capResult: checkCaps(50, 0),
    };

    const comment = formatPreviewComment(preview);
    expect(comment).toContain("🚫 **REFUSED:**");
    expect(comment).toContain("Child count cap exceeded");
  });

  it("formats a pending-approval preview", () => {
    const preview = {
      parentIssueId: "AI-1440",
      childCount: 15,
      children: Array.from({ length: 15 }, (_, i) => ({
        index: i,
        title: `Finding ${i + 1}`,
        workflow: "dev-impl",
        seedAc: `Finding ${i + 1}`,
      })),
      currentDepth: 0,
      requiresApproval: true,
      capResult: checkCaps(15, 0),
    };

    const comment = formatPreviewComment(preview);
    expect(comment).toContain("⚠️ **Steward approval required**");
  });
});

// ── formatCapRefusalComment ────────────────────────────────────────────────

describe("formatCapRefusalComment", () => {
  it("formats a cap refusal comment", () => {
    const capResult = checkCaps(50, 0);
    const comment = formatCapRefusalComment(capResult, "AI-1440");

    expect(comment).toContain("[Spawn Refused]");
    expect(comment).toContain("AI-1440");
    expect(comment).toContain("max_children=20");
    expect(comment).toContain("max_depth=3");
    expect(comment).toContain("break-glass");
  });
});

// ── parseSpawnCaps ─────────────────────────────────────────────────────────

describe("parseSpawnCaps", () => {
  it("returns defaults when no env vars set", () => {
    const originalMaxChildren = process.env.SPAWN_CAP_MAX_CHILDREN;
    const originalMaxDepth = process.env.SPAWN_CAP_MAX_DEPTH;
    const originalApprovalAbove = process.env.SPAWN_CAP_APPROVAL_ABOVE;

    delete process.env.SPAWN_CAP_MAX_CHILDREN;
    delete process.env.SPAWN_CAP_MAX_DEPTH;
    delete process.env.SPAWN_CAP_APPROVAL_ABOVE;

    const caps = parseSpawnCaps();
    expect(caps).toEqual(DEFAULT_SPAWN_CAPS);

    // Restore
    if (originalMaxChildren !== undefined) process.env.SPAWN_CAP_MAX_CHILDREN = originalMaxChildren;
    if (originalMaxDepth !== undefined) process.env.SPAWN_CAP_MAX_DEPTH = originalMaxDepth;
    if (originalApprovalAbove !== undefined) process.env.SPAWN_CAP_APPROVAL_ABOVE = originalApprovalAbove;
  });

  it("parses valid env vars", () => {
    process.env.SPAWN_CAP_MAX_CHILDREN = "10";
    process.env.SPAWN_CAP_MAX_DEPTH = "5";
    process.env.SPAWN_CAP_APPROVAL_ABOVE = "3";

    const caps = parseSpawnCaps();
    expect(caps.maxChildren).toBe(10);
    expect(caps.maxDepth).toBe(5);
    expect(caps.approvalAbove).toBe(3);

    delete process.env.SPAWN_CAP_MAX_CHILDREN;
    delete process.env.SPAWN_CAP_MAX_DEPTH;
    delete process.env.SPAWN_CAP_APPROVAL_ABOVE;
  });

  it("ignores invalid (non-numeric) env vars", () => {
    process.env.SPAWN_CAP_MAX_CHILDREN = "abc";
    process.env.SPAWN_CAP_MAX_DEPTH = "-1";
    process.env.SPAWN_CAP_APPROVAL_ABOVE = "0";

    const caps = parseSpawnCaps();
    expect(caps).toEqual(DEFAULT_SPAWN_CAPS);

    delete process.env.SPAWN_CAP_MAX_CHILDREN;
    delete process.env.SPAWN_CAP_MAX_DEPTH;
    delete process.env.SPAWN_CAP_APPROVAL_ABOVE;
  });
});

// ── generateSpawnPreview (mocked depth resolution) ─────────────────────────

describe("generateSpawnPreview — mocked depth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeMockFetch(depthChain: string[][]): typeof globalThis.fetch {
    // depthChain[i] = [issueId, parentId|null] for each level of the walk
    const chainMap = new Map(depthChain.map(([id, parentId]) => [id, parentId]));
    return async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      if (bodyText.includes("IssueParent")) {
        const parsed = JSON.parse(bodyText) as { variables?: { id?: string } };
        const id = parsed.variables?.id ?? "";
        const parentId = chainMap.get(id) ?? null;
        return new Response(
          JSON.stringify({
            data: { issue: { parent: parentId ? { identifier: parentId } : null } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected query: ${bodyText.slice(0, 100)}`);
    };
  }

  it("generates a preview for a root issue (depth=0)", async () => {
    const { generateSpawnPreview } = await import("./spawn-preview.js");
    globalThis.fetch = makeMockFetch([
      ["AI-1440", null], // AI-1440 has no parent → depth 0
    ]);

    const result = await generateSpawnPreview("AI-1440", "Bearer tok", [
      { title: "Finding A" },
      { title: "Finding B" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.preview).not.toBeNull();
    expect(result.preview!.parentIssueId).toBe("AI-1440");
    expect(result.preview!.childCount).toBe(2);
    expect(result.preview!.currentDepth).toBe(0);
    expect(result.preview!.requiresApproval).toBe(false);
    expect(result.preview!.capResult.allowed).toBe(true);
    expect(result.preview!.children).toHaveLength(2);
    expect(result.preview!.children[0].workflow).toBe("dev-impl");
  });

  it("generates a preview for a child issue (depth=1)", async () => {
    const { generateSpawnPreview } = await import("./spawn-preview.js");
    globalThis.fetch = makeMockFetch([
      ["AI-1500", "AI-1440"], // AI-1500's parent is AI-1440
      ["AI-1440", null],      // AI-1440 is root
    ]);

    const result = await generateSpawnPreview("AI-1500", "Bearer tok", [
      { title: "Sub-finding" },
    ]);

    expect(result.preview!.currentDepth).toBe(1);
    expect(result.preview!.capResult.allowed).toBe(true);
  });

  it("refuses preview at max depth", async () => {
    const { generateSpawnPreview } = await import("./spawn-preview.js");
    // Build a chain 3 levels deep: AI-1600 → AI-1500 → AI-1440 → AI-root → null
    globalThis.fetch = makeMockFetch([
      ["AI-1600", "AI-1500"],
      ["AI-1500", "AI-1440"],
      ["AI-1440", null],
    ]);

    const caps: SpawnCaps = { maxChildren: 20, maxDepth: 2, approvalAbove: 10 };
    const result = await generateSpawnPreview("AI-1600", "Bearer tok", [
      { title: "Deep finding" },
    ], caps);

    expect(result.preview!.currentDepth).toBe(2);
    expect(result.preview!.capResult.allowed).toBe(false);
    expect(result.preview!.capResult.refusalReason).toContain("Recursion depth cap");
  });
});

// ── resolveDepth (mocked API) ──────────────────────────────────────────────

describe("resolveDepth — mocked API", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 0 for a root issue with no parent", async () => {
    const { resolveDepth } = await import("./spawn-preview.js");
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ data: { issue: { parent: null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const depth = await resolveDepth("AI-1440", "Bearer tok");
    expect(depth).toBe(0);
  });

  it("walks up a 3-level chain", async () => {
    const { resolveDepth } = await import("./spawn-preview.js");
    const calls: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyText) as { variables?: { id?: string } };
      const id = parsed.variables?.id ?? "";
      calls.push(id);

      // AI-3 → AI-2 → AI-1 → AI-0 → null  (depth = 3 ancestors)
      const parents: Record<string, string | null> = {
        "AI-3": "AI-2",
        "AI-2": "AI-1",
        "AI-1": "AI-0",
        "AI-0": null,
      };
      const parent = parents[id] ?? null;
      return new Response(
        JSON.stringify({ data: { issue: { parent: parent ? { identifier: parent } : null } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const depth = await resolveDepth("AI-3", "Bearer tok");
    expect(depth).toBe(3);
    expect(calls).toEqual(["AI-3", "AI-2", "AI-1", "AI-0"]);
  });

  it("handles API errors gracefully (treats as no parent)", async () => {
    const { resolveDepth } = await import("./spawn-preview.js");
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network error");
      }
      return new Response(
        JSON.stringify({ data: { issue: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const depth = await resolveDepth("AI-1440", "Bearer tok");
    // Network error → fetchParentId returns null → depth stays 0
    expect(depth).toBe(0);
  });
});
