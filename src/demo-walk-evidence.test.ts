import { describe, it, expect } from "@jest/globals";
import {
  parseDemoWalkMarker,
  isPassingDemoWalkBundle,
  selectDemoWalkEvidence,
  verifyDemoWalkEvidence,
  type DemoWalkCandidate,
} from "./demo-walk-evidence.js";

const NOW = Date.parse("2026-07-25T23:59:00Z");
const H = 3_600_000;
const MAX_AGE = 24 * H;

function cand(over: Partial<DemoWalkCandidate["bundle"]>, attachedAt: string): DemoWalkCandidate {
  return {
    bundle: { artifact_kind: "demonstration-walk", exit_code: 0, passed: true, sha: "abc123", ...over },
    attachedAt,
    url: "https://uploads.linear.app/x",
  };
}

describe("parseDemoWalkMarker", () => {
  it("no marker → not required", () => {
    expect(parseDemoWalkMarker("just a normal ticket body")).toEqual({ required: false, explicitRequire: false });
    expect(parseDemoWalkMarker(null)).toEqual({ required: false, explicitRequire: false });
  });

  it("Demo-walk-script marker → required with path", () => {
    const m = parseDemoWalkMarker("## AC\nDemo-walk-script: scripts/verify_lif260_demo_walk.py\nmore");
    expect(m.required).toBe(true);
    expect(m.scriptPath).toBe("scripts/verify_lif260_demo_walk.py");
    expect(m.explicitRequire).toBe(false);
  });

  it("Demo-walk-required: true forces the gate even with no script", () => {
    const m = parseDemoWalkMarker("Demo-walk-required: true");
    expect(m.required).toBe(true);
    expect(m.explicitRequire).toBe(true);
    expect(m.scriptPath).toBeUndefined();
  });

  it("both markers present", () => {
    const m = parseDemoWalkMarker("Demo-walk-required: true\nDemo-walk-script: scripts/w.sh");
    expect(m.required).toBe(true);
    expect(m.explicitRequire).toBe(true);
    expect(m.scriptPath).toBe("scripts/w.sh");
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    const m = parseDemoWalkMarker("  demo-walk-script:   scripts/w.py  ");
    expect(m.required).toBe(true);
    expect(m.scriptPath).toBe("scripts/w.py");
  });
});

describe("isPassingDemoWalkBundle", () => {
  it("passes on exit 0 + demonstration-walk kind", () => {
    expect(isPassingDemoWalkBundle({ artifact_kind: "demonstration-walk", exit_code: 0, passed: true })).toBe(true);
  });
  it("rejects wrong artifact_kind", () => {
    expect(isPassingDemoWalkBundle({ artifact_kind: "screenshot", exit_code: 0 })).toBe(false);
  });
  it("rejects non-zero exit", () => {
    expect(isPassingDemoWalkBundle({ artifact_kind: "demonstration-walk", exit_code: 7 })).toBe(false);
  });
  it("rejects exit 0 but passed:false (defensive)", () => {
    expect(isPassingDemoWalkBundle({ artifact_kind: "demonstration-walk", exit_code: 0, passed: false })).toBe(false);
  });
  it("rejects null/undefined", () => {
    expect(isPassingDemoWalkBundle(null)).toBe(false);
    expect(isPassingDemoWalkBundle(undefined)).toBe(false);
  });
});

describe("selectDemoWalkEvidence", () => {
  it("no artifact at all → not-run failure", () => {
    const r = selectDemoWalkEvidence([], NOW, MAX_AGE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no demonstration-walk artifact");
  });

  it("a failed walk → loud fail (distinguished from not-run)", () => {
    const r = selectDemoWalkEvidence(
      [cand({ exit_code: 7, passed: false }, "2026-07-25T23:50:00Z")],
      NOW,
      MAX_AGE,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("FAILED");
    expect(r.exitCode).toBe(7);
  });

  it("fresh passing walk → ok", () => {
    const r = selectDemoWalkEvidence([cand({}, "2026-07-25T23:50:00Z")], NOW, MAX_AGE);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.sha).toBe("abc123");
  });

  it("stale passing walk → stale failure", () => {
    const r = selectDemoWalkEvidence([cand({}, "2026-07-23T00:00:00Z")], NOW, MAX_AGE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("stale");
  });

  it("picks the newest passing walk when several exist", () => {
    const r = selectDemoWalkEvidence(
      [
        cand({ sha: "old" }, "2026-07-25T20:00:00Z"),
        cand({ sha: "new" }, "2026-07-25T23:40:00Z"),
      ],
      NOW,
      MAX_AGE,
    );
    expect(r.ok).toBe(true);
    expect(r.sha).toBe("new");
  });

  it("a fresh PASS after an earlier FAIL still passes", () => {
    const r = selectDemoWalkEvidence(
      [
        cand({ exit_code: 7, passed: false }, "2026-07-25T22:00:00Z"),
        cand({ sha: "fixed" }, "2026-07-25T23:40:00Z"),
      ],
      NOW,
      MAX_AGE,
    );
    expect(r.ok).toBe(true);
    expect(r.sha).toBe("fixed");
  });
});

describe("verifyDemoWalkEvidence", () => {
  it("fails CLOSED when comments cannot be read", async () => {
    const r = await verifyDemoWalkEvidence({
      issueId: "LIF-263",
      authToken: "t",
      nowMs: NOW,
      maxAgeMs: MAX_AGE,
      fetchCandidates: async () => ({ candidates: [], fetchFailed: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unable to read");
  });

  it("passes with an injected fresh passing candidate", async () => {
    const r = await verifyDemoWalkEvidence({
      issueId: "LIF-263",
      authToken: "t",
      nowMs: NOW,
      maxAgeMs: MAX_AGE,
      fetchCandidates: async () => ({ candidates: [cand({}, "2026-07-25T23:50:00Z")], fetchFailed: false }),
    });
    expect(r.ok).toBe(true);
  });
});
