/**
 * Unit tests for the verbatim AC record store (AI-1482 Phase 6.5 / H-7).
 */

import {
  captureAc,
  getAcRecord,
  hasAcRecord,
  removeAcRecord,
  clearAcRecordStore,
  extractAcFromDescription,
} from "./ac-record-store.js";

describe("ac-record-store", () => {
  beforeEach(() => {
    clearAcRecordStore();
  });

  describe("captureAc / getAcRecord", () => {
    it("stores and retrieves an AC record", () => {
      captureAc("AI-1482", {
        verbatimAc: "### AC\n- Foo works\n- Bar passes",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });

      const record = getAcRecord("AI-1482");
      expect(record).not.toBeNull();
      expect(record!.verbatimAc).toBe("### AC\n- Foo works\n- Bar passes");
      expect(record!.capturedBy).toBe("igor");
      expect(record!.source).toBe("description");
    });

    it("returns null for unknown ticket", () => {
      expect(getAcRecord("NONEXISTENT")).toBeNull();
    });

    it("overwrites existing record on re-capture", () => {
      captureAc("AI-1482", {
        verbatimAc: "original AC",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      captureAc("AI-1482", {
        verbatimAc: "updated AC",
        capturedAt: "2026-06-09T21:00:00Z",
        capturedBy: "charles",
        source: "description",
      });

      const record = getAcRecord("AI-1482");
      expect(record!.verbatimAc).toBe("updated AC");
      expect(record!.capturedBy).toBe("charles");
    });
  });

  describe("hasAcRecord", () => {
    it("returns false when no record exists", () => {
      expect(hasAcRecord("AI-1482")).toBe(false);
    });

    it("returns true after capture", () => {
      captureAc("AI-1482", {
        verbatimAc: "AC text",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      expect(hasAcRecord("AI-1482")).toBe(true);
    });
  });

  describe("removeAcRecord", () => {
    it("removes an existing record", () => {
      captureAc("AI-1482", {
        verbatimAc: "AC text",
        capturedAt: "2026-06-09T20:00:00Z",
        capturedBy: "igor",
        source: "description",
      });
      expect(removeAcRecord("AI-1482")).toBe(true);
      expect(getAcRecord("AI-1482")).toBeNull();
    });

    it("returns false when no record exists", () => {
      expect(removeAcRecord("NONEXISTENT")).toBe(false);
    });
  });

  describe("extractAcFromDescription", () => {
    it("extracts AC from ### Acceptance Criteria header", () => {
      const desc = "Some intro text\n\n### Acceptance Criteria\n- Foo works\n- Bar passes\n\n### Notes\nSome notes";
      expect(extractAcFromDescription(desc)).toBe("- Foo works\n- Bar passes");
    });

    it("extracts AC from ### Acceptance header", () => {
      const desc = "## Task\n\n### Acceptance\n- [ ] AC 1\n- [ ] AC 2\n\n## Other";
      expect(extractAcFromDescription(desc)).toBe("- [ ] AC 1\n- [ ] AC 2");
    });

    it("extracts AC from ### AC header", () => {
      const desc = "## Task\n\n### AC\n1. Thing one\n2. Thing two\n\n## Later";
      expect(extractAcFromDescription(desc)).toBe("1. Thing one\n2. Thing two");
    });

    it("extracts AC from ## Acceptance header", () => {
      const desc = "## Acceptance\n- Test passes\n\n## Notes\nblah";
      expect(extractAcFromDescription(desc)).toBe("- Test passes");
    });

    it("returns full description when no AC header found", () => {
      const desc = "Just some text without any AC header";
      expect(extractAcFromDescription(desc)).toBe("Just some text without any AC header");
    });

    it("returns empty string for empty description", () => {
      expect(extractAcFromDescription("")).toBe("");
    });

    it("extracts AC to end of string when no following heading", () => {
      const desc = "## Task\n\n### AC\n- Last item in the doc";
      expect(extractAcFromDescription(desc)).toBe("- Last item in the doc");
    });

    it("is case-insensitive for AC header", () => {
      const desc = "### acceptance criteria\n- Lowercase AC";
      expect(extractAcFromDescription(desc)).toBe("- Lowercase AC");
    });
  });
});
