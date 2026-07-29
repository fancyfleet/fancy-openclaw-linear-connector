/**
 * INF-996 PR-A: per-ticket role-binding store (generalized implementer-store).
 *
 * Covers: multi-role bindings, the back-compat migration of legacy single-body
 * records (existing prior-implementer data must NOT be stranded), the
 * implementer wrappers, per-role removal, and disk persistence/reload.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordBinding,
  getBinding,
  getBindings,
  removeBinding,
  clearTicketBindings,
  recordImplementer,
  getImplementer,
  removeImplementer,
  clearImplementerStore,
} from "./implementer-store.js";

const ISSUE = "issue-uuid-1";

let storePath: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inf996-binding-"));
  storePath = path.join(dir, "implementer-store.json");
  process.env.IMPLEMENTER_STORE_PATH = storePath;
  clearImplementerStore(); // reset in-memory + force reload from the fresh path
});

afterEach(() => {
  clearImplementerStore();
  delete process.env.IMPLEMENTER_STORE_PATH;
});

describe("INF-996 binding store — multi-role", () => {
  it("binds and reads back multiple roles independently", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");

    expect(await getBinding(ISSUE, "implementer")).toBe("igor");
    expect(await getBinding(ISSUE, "reviewer")).toBe("astrid");
    expect(await getBindings(ISSUE)).toEqual({ implementer: "igor", reviewer: "astrid" });
  });

  it("returns null for an unbound role or unknown ticket", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    expect(await getBinding(ISSUE, "reviewer")).toBeNull();
    expect(await getBinding("nope", "implementer")).toBeNull();
    expect(await getBindings("nope")).toBeNull();
  });

  it("re-binding a role overwrites only that role", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");
    await recordBinding(ISSUE, "implementer", "sage", "chore"); // reassign implementer
    expect(await getBindings(ISSUE)).toEqual({ implementer: "sage", reviewer: "astrid" });
  });

  it("removeBinding drops one role and keeps the rest; drops the record when last", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");
    await removeBinding(ISSUE, "reviewer");
    expect(await getBindings(ISSUE)).toEqual({ implementer: "igor" });
    await removeBinding(ISSUE, "implementer");
    expect(await getBindings(ISSUE)).toBeNull();
  });

  it("clearTicketBindings drops the whole ticket", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");
    await clearTicketBindings(ISSUE);
    expect(await getBindings(ISSUE)).toBeNull();
  });
});

describe("INF-996 binding store — implementer back-compat wrappers", () => {
  it("recordImplementer/getImplementer round-trip via the implementer role", async () => {
    await recordImplementer(ISSUE, "igor", "chore");
    expect(await getImplementer(ISSUE)).toBe("igor");
    expect(await getBinding(ISSUE, "implementer")).toBe("igor");
  });

  it("removeImplementer clears the whole ticket (escape/demote semantics preserved)", async () => {
    await recordImplementer(ISSUE, "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");
    await removeImplementer(ISSUE);
    expect(await getBindings(ISSUE)).toBeNull();
  });
});

describe("INF-996 binding store — legacy on-disk migration (no stranded data)", () => {
  it("reads a legacy single-body record as { implementer: <body> }", async () => {
    // Simulate a pre-INF-996 store file written by the old implementer-store.
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [ISSUE]: { bodyId: "felix", workflowId: "dev-impl", recordedAt: "2026-07-01T00:00:00.000Z" },
      }),
      "utf8",
    );
    clearImplementerStore(); // force a fresh load from the legacy file

    // The old prior-implementer read must still resolve.
    expect(await getImplementer(ISSUE)).toBe("felix");
    // And it is now visible under the general API too.
    expect(await getBinding(ISSUE, "implementer")).toBe("felix");
    expect(await getBindings(ISSUE)).toEqual({ implementer: "felix" });
  });

  it("legacy record accepts new role bindings alongside the migrated implementer", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [ISSUE]: { bodyId: "felix", workflowId: "dev-impl", recordedAt: "2026-07-01T00:00:00.000Z" } }),
      "utf8",
    );
    clearImplementerStore();

    await recordBinding(ISSUE, "reviewer", "astrid", "chore");
    expect(await getBindings(ISSUE)).toEqual({ implementer: "felix", reviewer: "astrid" });
  });
});

describe("INF-996 binding store — persistence", () => {
  it("persists bindings to disk and reloads them in a fresh store instance", async () => {
    await recordBinding(ISSUE, "implementer", "igor", "chore");
    await recordBinding(ISSUE, "reviewer", "astrid", "chore");

    // File is written in the new bindings shape.
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(onDisk[ISSUE].bindings).toEqual({ implementer: "igor", reviewer: "astrid" });

    // Simulate a restart: drop in-memory state, reload from disk.
    clearImplementerStore();
    expect(await getBindings(ISSUE)).toEqual({ implementer: "igor", reviewer: "astrid" });
  });
});
