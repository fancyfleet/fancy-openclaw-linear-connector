/**
 * INF-1099 — unit tests for the live-signal deploy verdict logic.
 *
 * Proves the verdict is derived from live /health + code-level grep and that
 * missing signals fail OPEN (never a manufactured stall), while the concrete
 * Done-≠-deployed divergence produces a STALL with evidence.
 */

import { describe, it, expect } from "@jest/globals";
import {
  deriveVerdict,
  makeDeployVerdictApi,
  extractHallmarkSymbol,
  type CodePresence,
} from "./deploy-verdict.js";

const REF = "origin/main";

describe("extractHallmarkSymbol", () => {
  it("returns the symbol from a hallmark:<symbol> label", () => {
    expect(extractHallmarkSymbol(["wf:task", "hallmark:myFn", "state:doing"])).toBe("myFn");
  });
  it("trims whitespace and ignores empty hallmark labels", () => {
    expect(extractHallmarkSymbol(["hallmark:  spaced  "])).toBe("spaced");
    expect(extractHallmarkSymbol(["hallmark:"])).toBeNull();
  });
  it("returns null when no hallmark label is present", () => {
    expect(extractHallmarkSymbol(["wf:task", "state:doing"])).toBeNull();
    expect(extractHallmarkSymbol([])).toBeNull();
  });
});

describe("deriveVerdict", () => {
  it("no hallmark → unverifiable, never a stall (AC4)", () => {
    const v = deriveVerdict(null, null, null, null, REF);
    expect(v.status).toBe("unverifiable");
    expect(v.stall).toBe(false);
    expect(v.deployed).toBe(false);
    expect(v.evidence).toContain("AC4");
  });

  it("present in deployed artifact → deployed, no stall", () => {
    const v = deriveVerdict("sym", true, "abc1234", true, REF);
    expect(v.status).toBe("deployed");
    expect(v.deployed).toBe(true);
    expect(v.stall).toBe(false);
    expect(v.evidence).toContain("abc1234");
    expect(v.evidence).toContain("sym");
  });

  it("absent from deployed artifact → STALL with divergence evidence (the core case)", () => {
    const v = deriveVerdict("sym", true, "abc1234", false, REF);
    expect(v.status).toBe("stale-not-deployed");
    expect(v.stall).toBe(true);
    expect(v.deployed).toBe(false);
    expect(v.evidence).toContain("abc1234"); // live running commit
    expect(v.evidence).toContain("sym"); // hallmark
    expect(v.evidence).toContain("Done ≠ deployed");
    expect(v.evidence).not.toMatch(/title|Done label/i); // not ticket text
  });

  it("deployed commit unknowable but absent from main → STALL (never merged)", () => {
    const v = deriveVerdict("sym", false, null, null, REF);
    expect(v.status).toBe("absent-from-main");
    expect(v.stall).toBe(true);
    expect(v.evidence).toContain("not merged");
  });

  it("deployed commit unknowable but present on main → UNVERIFIABLE (fail open, no false stall)", () => {
    const v = deriveVerdict("sym", true, null, null, REF);
    expect(v.status).toBe("unverifiable");
    expect(v.stall).toBe(false);
    expect(v.evidence).toContain("fail-open");
  });

  it("health commit present but not in clone (indeterminate) with present-on-main → fail open", () => {
    const v = deriveVerdict("sym", true, "notInClone", null, REF);
    expect(v.stall).toBe(false);
    expect(v.status).toBe("unverifiable");
  });
});

describe("makeDeployVerdictApi", () => {
  const present = (symbol: string, ref: string): CodePresence => {
    if (ref === "origin/main") return true;
    if (ref === "deployedSha") return false;
    return null;
  };

  it("STALL: hallmark on main, absent from live /health commit", async () => {
    const api = makeDeployVerdictApi({
      symbolPresentAt: present,
      fetchHealthCommit: async () => "deployedSha",
    });
    const v = await api.verify({ identifier: "INF-1099", labels: ["hallmark:mySym"] });
    expect(v.stall).toBe(true);
    expect(v.runningCommit).toBe("deployedSha");
  });

  it("skips (unverifiable) when no hallmark label — never derives from ticket text", async () => {
    let grepCalled = false;
    const api = makeDeployVerdictApi({
      symbolPresentAt: () => {
        grepCalled = true;
        return true;
      },
      fetchHealthCommit: async () => "deployedSha",
    });
    const v = await api.verify({ identifier: "AI-1", labels: ["wf:task", "state:doing"] });
    expect(v.status).toBe("unverifiable");
    expect(v.stall).toBe(false);
    expect(grepCalled).toBe(false);
  });

  it("fails open (no stall) when /health throws and the fix is on main", async () => {
    const api = makeDeployVerdictApi({
      symbolPresentAt: (_s, ref) => (ref === "origin/main" ? true : null),
      fetchHealthCommit: async () => {
        throw new Error("health unreachable");
      },
    });
    const v = await api.verify({ identifier: "AI-2", labels: ["hallmark:mySym"] });
    expect(v.stall).toBe(false);
    expect(v.runningCommit).toBeNull();
  });
});
