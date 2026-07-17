/**
 * AI-2176 — Tests for group-aware label resolution + raw-error surfacing in
 * findOrCreateLabel.
 *
 * Background: LIF-team governed transitions silently declined because
 * create-on-miss for `state:product-definition` fail-closed with no visibility.
 * Grover's forensics (AI-2198) pinned it to B2 label resolution: a team that
 * models `state:*` as a Linear label GROUP ("state") with bare-named children
 * ("product-definition") breaks a blind flat lookup/create.
 *
 * These tests exercise findOrCreateLabel directly:
 *   1. Flat exact match (GEN + flat LIF labels) — unchanged behavior.
 *   2. Group-child match — resolves an existing child of a `state` group.
 *   3. Group-aware create — creates the label under the group (parentId), not flat.
 *   4. Flat create — a team with no group still gets a flat colon-named label.
 *   5. Raw-error surfacing — a non-success create logs the GraphQL errors body.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { findOrCreateLabel } from "./linear-helpers.js";

interface LabelFixture {
  id: string;
  name: string;
  isGroup?: boolean;
  parent?: { id: string; name: string } | null;
  /** AI-2557: team ownership for inherited-label filtering. */
  team?: { id: string };
}

interface FetchLog {
  createInputs: Array<Record<string, unknown>>;
}

/**
 * Build a fetch mock that returns `labels` on the TeamLabels lookup and a
 * configurable outcome on issueLabelCreate. Records every create input so tests
 * can assert whether a flat or group-child create was issued.
 */
function makeFetch(
  labels: LabelFixture[],
  createOutcome: { success: boolean; id?: string; errors?: unknown },
  log: FetchLog,
  /** AI-2557: override the team.id injected into labels lacking an explicit team.
   *  Defaults to the teamId arg passed to findOrCreateLabel. Set to a different
   *  team ID to simulate an inherited parent-team label. */
  teamFilterOverride?: string,
): typeof globalThis.fetch {
  return (async (_url: string, init?: RequestInit) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Buffer
          ? init.body.toString()
          : "";
    if (bodyText.includes("TeamLabels")) {
      // AI-2557: extract the teamId from the query variables so we inject the
      // correct team ownership into mock labels for inherited-label filtering.
      let queryTeamId = teamFilterOverride ?? "";
      if (!queryTeamId) {
        try {
          const parsed = JSON.parse(bodyText) as { variables?: Record<string, unknown> };
          queryTeamId = (parsed.variables?.teamId as string) ?? "";
        } catch { /* ignore */ }
      }
      const enrichedLabels = labels.map((l) => ({
        ...l,
        team: l.team ?? (queryTeamId ? { id: queryTeamId } : undefined),
      }));
      return new Response(
        JSON.stringify({ data: { team: { labels: { nodes: enrichedLabels } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (bodyText.includes("issueLabelCreate")) {
      const parsed = JSON.parse(bodyText) as { variables: Record<string, unknown> };
      log.createInputs.push(parsed.variables);
      const body: Record<string, unknown> = {
        data: {
          issueLabelCreate: {
            success: createOutcome.success,
            issueLabel: createOutcome.success ? { id: createOutcome.id } : null,
          },
        },
      };
      if (createOutcome.errors) body.errors = createOutcome.errors;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("findOrCreateLabel — group-aware resolution (AI-2176)", () => {
  let originalFetch: typeof globalThis.fetch;
  let log: FetchLog;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    log = { createInputs: [] };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns the id of an existing flat label without creating (GEN path)", async () => {
    globalThis.fetch = makeFetch(
      [{ id: "flat-uuid", name: "state:product-definition" }],
      { success: false },
      log,
    );
    const id = await findOrCreateLabel("team-gen", "state:product-definition", "Bearer t");
    expect(id).toBe("flat-uuid");
    expect(log.createInputs).toHaveLength(0); // no create attempted
  });

  it("resolves an existing group child without creating (LIF nested path)", async () => {
    globalThis.fetch = makeFetch(
      [
        { id: "grp-uuid", name: "state", isGroup: true },
        {
          id: "child-uuid",
          name: "product-definition",
          isGroup: false,
          parent: { id: "grp-uuid", name: "state" },
        },
      ],
      { success: false },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBe("child-uuid");
    expect(log.createInputs).toHaveLength(0);
  });

  it("creates the label under the group when the group exists but the child is missing", async () => {
    globalThis.fetch = makeFetch(
      [{ id: "grp-uuid", name: "state", isGroup: true }],
      { success: true, id: "new-child-uuid" },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBe("new-child-uuid");
    expect(log.createInputs).toHaveLength(1);
    // Created as a child: bare name + parentId pointing at the group.
    expect(log.createInputs[0]).toMatchObject({
      name: "product-definition",
      parentId: "grp-uuid",
    });
  });

  it("creates a flat colon-named label when no group exists (unchanged behavior)", async () => {
    globalThis.fetch = makeFetch([], { success: true, id: "flat-new-uuid" }, log);
    const id = await findOrCreateLabel("team-gen", "state:product-definition", "Bearer t");
    expect(id).toBe("flat-new-uuid");
    expect(log.createInputs).toHaveLength(1);
    expect(log.createInputs[0]).toMatchObject({ name: "state:product-definition" });
    expect(log.createInputs[0]).not.toHaveProperty("parentId");
  });

  it("rejects inherited parent-team label and falls through to create (AI-2557)", async () => {
    // Simulate LIF team looking for a label owned by GEN (parent team).
    // The label "state:product-definition" exists but its owning team is GEN,
    // not LIF — pre-fix code would early-return GEN's id, which Linear rejects.
    globalThis.fetch = makeFetch(
      [
        {
          id: "gen-label-uuid",
          name: "state:product-definition",
          // Explicitly set a DIFFERENT team to simulate inherited parent-team label.
          team: { id: "team-gen" },
        },
      ],
      { success: true, id: "new-lif-label-uuid" },
      log,
      // Inject teamFilterOverride that matches the calling team, so the mock labels
      // show the parent-team ownership for the inherited label.
      "team-gen",
    );
    // Call with team-lif — the inherited label (team-gen) should be rejected.
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    // Post-fix: inherited label rejected → create fires → new LIF-owned label id.
    expect(id).toBe("new-lif-label-uuid");
    // A create must have been attempted (the inherited match was rejected).
    expect(log.createInputs).toHaveLength(1);
    expect(log.createInputs[0]).toMatchObject({
      name: "state:product-definition",
      teamId: "team-lif",
    });
  });

  it("fail-closes to null AND logs the raw GraphQL errors body on create failure (AI-2177)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = makeFetch(
      [],
      { success: false, errors: [{ message: "A label with this name already exists." }] },
      log,
    );
    const id = await findOrCreateLabel("team-lif", "state:product-definition", "Bearer t");
    expect(id).toBeNull();
    // The raw GraphQL error must reach the logs — this is the opacity fix.
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("A label with this name already exists.");
    expect(logged).toContain("state:product-definition");
  });
});
