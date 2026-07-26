/**
 * INF-730: `spawning-scope → scoping` fan-out over-splits a multi-paragraph
 * `## structured` bullet into N children instead of minting exactly one scoping
 * child.
 *
 * Live repro (2026-07-26, LIF-45 Cycle 9): the `## structured` section was a
 * SINGLE top-level `*` bullet whose body carried an indented `IN` block with
 * numbered `1.`/`2.`/`3.` sub-items plus `Trust floor`/`Ring`/`OUT`/`Vision`/
 * `Refs` sub-sections. The old flat line-regex matched every indented `N.`
 * sub-item and each interstitial bold line as its own finding → 9 findings →
 * 9 scoping children (LIF-279..287). Only LIF-279 was correct; 280..287 were
 * sentence-fragment children with no governed cleanup path.
 *
 * AC1: firing spawn against such a bullet mints exactly ONE scoping child.
 *
 * The fix parses only TOP-LEVEL bullets (column 0); indented sub-items and
 * continuation prose fold into the current entry's description.
 */
import { extractSpecFindings, extractFindings } from "./fanout.js";

// Faithful reduction of LIF-45's live `## structured` section: one top-level
// `*` bullet, an indented IN spine with numbered sub-items, and indented
// Trust/Ring/OUT/Vision/Refs sub-sections.
const LIF45_STRUCTURED = [
  "## structured",
  "",
  '* **🏘️ LifeOS 2026-07-26 Scoping**: Cycle 9 "Inhabitation" — populate the city and make presence real, on the trust floor. All four Cycle-9 lenses converged.',
  "",
  "  **IN (spine — parallel per Rule 15):**",
  "  1. **Directory hygiene.** Segregate/exclude the test-principal namespace from `residents.list`.",
  "  2. **Liveness metric + presence-lag fix.** Instrument ONE inhabitation number at `/metrics`.",
  "  3. **Seed real density.** Real residents each creating >1 real entity with REAL media.",
  "",
  "  **Trust floor (sequenced blocker):**",
  "  4. [LIF-275](https://linear.app/fancymatt/issue/LIF-275) close `residents.register` + [EN-6](https://linear.app/fancymatt/issue/EN-6) TLS.",
  "",
  "  **Ring (capacity-permitting; else Cycle 10):**",
  "  5. **Wardrobe/appearance-as-entity** — Design's #1 keystone as the 2nd entity type.",
  "",
  "  **OUT:** signal inference/rules engine; [MK-2](https://linear.app/fancymatt/issue/MK-2) discovery feed (gated behind density).",
  "",
  "  **Vision alignment:** `vision.md`'s \"the city notices\" only becomes true when there IS activity to notice.",
  "",
  "  **Refs:** [LIF-271](https://linear.app/fancymatt/issue/LIF-271)/272/273/274, `specialist-observations.md` → Cycle 9.",
  "",
  "## sprint",
  "* placeholder to bound the structured section",
].join("\n");

describe("INF-730: multi-paragraph structured bullet does not over-fan (AC1)", () => {
  it("mints exactly ONE scoping child from a single top-level multi-paragraph bullet", () => {
    const findings = extractSpecFindings(LIF45_STRUCTURED, "structured");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("🏘️ LifeOS 2026-07-26 Scoping");
  });

  it("folds the nested IN/OUT/Refs body into the single finding's description, not into siblings", () => {
    const findings = extractSpecFindings(LIF45_STRUCTURED, "structured");
    expect(findings).toHaveLength(1);
    const desc = findings[0].description ?? "";
    // The indented sub-items are captured as body, not promoted to findings.
    expect(desc).toContain("Directory hygiene");
    expect(desc).toContain("Seed real density");
    expect(desc).toContain("Refs:");
    // No finding was ever titled from an indented numbered sub-item.
    expect(findings.some((f) => /^\d+\.\s/.test(f.title))).toBe(false);
    expect(findings.some((f) => f.title.startsWith("Directory hygiene"))).toBe(false);
  });

  it("still fans out a genuine multi-bullet spec (each TOP-LEVEL bullet is its own finding)", () => {
    const multi = [
      "## structured",
      "- **[wf:sprint-arm-scope → igor] Scope shaping**: Define scope and boundaries",
      "- **[wf:sprint-arm-ux → signe] UX shaping**: Design user experience",
      "- **[wf:sprint-arm-design → laren] Design shaping**: Visual design direction",
    ].join("\n");
    const findings = extractSpecFindings(multi, "structured");
    expect(findings).toHaveLength(3);
    expect(findings[0].title).toBe("Scope shaping");
    expect(findings[0].child_workflow).toBe("wf:sprint-arm-scope");
    expect(findings[0].delegate).toBe("igor");
    expect(findings[1].title).toBe("UX shaping");
    expect(findings[2].title).toBe("Design shaping");
  });

  it("extractFindings shares the top-level-only parse (audit path parity)", () => {
    // A findings section whose bullet carries an indented numbered sub-list must
    // not promote the sub-items to their own findings.
    const audit = [
      "## Findings",
      "- **Missing auth on /api/users**: no auth check",
      "  1. GET is unguarded",
      "  2. POST is unguarded",
      "- **SQL injection in search**: input not sanitized",
    ].join("\n");
    const findings = extractFindings(audit, "Fallback");
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Missing auth on /api/users");
    expect(findings[1].title).toBe("SQL injection in search");
  });
});
