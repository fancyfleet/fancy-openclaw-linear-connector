/**
 * INF-890 — dev-sprint spawn-arms marker arrow parsing.
 *
 * Regression tests for the per-entry `[wf:... -> delegate]` marker parser in
 * extractSpecFindings(). AI-2199 introduced the marker but modeled the arrow
 * as a single-character class [→>-], which only ever handled the unicode arrow
 * (→). A steward hand-authoring LIF-327's spawn spec with the ASCII arrow "->"
 * (the natural keyboard form) hit two silent defects:
 *
 *   1. `[wf:sprint-arm-ux -> signe]` (spaced ASCII) matched NOTHING, so the
 *      marker was dropped and the child fell back to the fan-out config default
 *      (wf:sprint-arm-scope / initial_delegate astrid). Astrid's report: "every
 *      structured child minted as wf:sprint-arm-scope/Astrid regardless of its
 *      marker."
 *   2. `[wf:sprint-arm-design->laren]` (unspaced ASCII) absorbed the leading
 *      '-' into the workflow id → malformed label wf:sprint-arm-design->laren,
 *      no delegate. Astrid's report: "malformed UX/design arms."
 *
 * The AI-2199 suite was authored entirely with → and stayed green over both.
 * These tests exercise the ASCII forms directly and assert the id/delegate
 * split, while guarding the → form (no regression) and internal id hyphens.
 */

import { extractSpecFindings, type Finding } from "./fanout.js";

function bySpec(spec: string[]): Finding[] {
  return extractSpecFindings(spec.join("\n"), "Structured");
}

const header = "## Structured";

describe("INF-890: spawn-arms marker arrow parsing", () => {
  it("parses the ASCII arrow '->' (spaced) — previously dropped the whole marker", () => {
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-ux -> signe] UX shaping**: Design user experience",
      "- **[wf:sprint-arm-design -> laren] Design shaping**: Visual direction",
    ]);
    expect(findings).toHaveLength(2);

    expect(findings[0].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[0].delegate).toBe("signe");
    expect(findings[0].title).toBe("UX shaping");

    expect(findings[1].child_workflow).toBe("wf:sprint-arm-design");
    expect(findings[1].delegate).toBe("laren");
    expect(findings[1].title).toBe("Design shaping");
  });

  it("parses the ASCII arrow '->' (unspaced) without absorbing '-' into the id", () => {
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-design->laren] Design shaping**: Visual direction",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-design");
    expect(findings[0].delegate).toBe("laren");
    // The malformed pre-fix label must never leak through.
    expect(findings[0].child_workflow).not.toContain("->");
  });

  it("does NOT silently fall back to the config default for a marked entry", () => {
    // Regression for Astrid's report: a marked ux/design arm must keep its own
    // workflow, never collapse to wf:sprint-arm-scope/astrid.
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-ux -> signe] UX shaping**: Design UX",
    ]);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[0].child_workflow).not.toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).not.toBe("astrid");
  });

  it("still parses the unicode arrow '→' (no regression)", () => {
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-scope → igor] Scope shaping**: Define scope",
      "- **[wf:sprint-arm-ux → signe] UX shaping**: Design UX",
    ]);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).toBe("igor");
    expect(findings[1].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[1].delegate).toBe("signe");
  });

  it("keeps a marker with no delegate working (delegate undefined)", () => {
    const findings = bySpec([header, "- **[wf:sprint-arm-ux] UX shaping**: Design UX"]);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-ux");
    expect(findings[0].delegate).toBeUndefined();
    expect(findings[0].title).toBe("UX shaping");
  });

  it("preserves internal id hyphens with the ASCII arrow", () => {
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-spike -> igor] Spike shaping**: Technical spike",
    ]);
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-spike");
    expect(findings[0].delegate).toBe("igor");
  });

  it("handles a mixed spec with both arrow styles side by side", () => {
    const findings = bySpec([
      header,
      "- **[wf:sprint-arm-scope → igor] Scope**: Define scope",
      "- **[wf:sprint-arm-ux -> signe] UX**: Design UX",
      "- **[wf:sprint-arm-design->laren] Design**: Visual direction",
      "- **[wf:sprint-arm-spike] Spike**: Technical spike",
    ]);
    expect(findings.map((f) => f.child_workflow)).toEqual([
      "wf:sprint-arm-scope",
      "wf:sprint-arm-ux",
      "wf:sprint-arm-design",
      "wf:sprint-arm-spike",
    ]);
    expect(findings.map((f) => f.delegate)).toEqual(["igor", "signe", "laren", undefined]);
  });
});
