/**
 * INF-615 — the connector admin console showed every webhook row with an empty
 * URL/Team and a permanent "last seen: never". Two causes:
 *
 *   1. Nothing ever wrote `lastSeen` — `listWebhooks` read it but no code path
 *      set it, so it stayed `null` forever.
 *   2. Secrets injected straight into `LINEAR_WEBHOOK_SECRETS` (secret-sync,
 *      bypassing the console's `addWebhook`) had no sidecar metadata at all, so
 *      URL and Team rendered blank.
 *
 * `recordWebhookSeen` is the delivery-path hook that fixes both: it stamps
 * `lastSeen` for the secret that validated an inbound delivery and — when the
 * event carries a team key — backfills the Team label for secrets that never
 * went through the console. These tests grade that behaviour against the
 * `listWebhooks` contract (the same view the admin console renders).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { listWebhooks, recordWebhookSeen } from "./registry.js";

const SECRET = "lin_wh_livewebhook_0001";
const OTHER_SECRET = "lin_wh_livewebhook_0002";

describe("INF-615 — recordWebhookSeen stamps last-seen + backfills team", () => {
  let envDir: string;
  let envFile: string;

  /** Row for a secret as the admin console would see it, or undefined. */
  function rowFor(secret: string) {
    // The console keys rows by opaque id; find the one whose masked preview
    // matches this secret's suffix (secrets end distinctly here).
    const suffix = secret.slice(-3);
    return listWebhooks().find((r) => r.secretPreview.endsWith(suffix));
  }

  beforeEach(() => {
    envDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf615-env-"));
    envFile = path.join(envDir, ".env");
    fs.writeFileSync(envFile, `LINEAR_WEBHOOK_SECRETS=${SECRET},${OTHER_SECRET}\n`);
    process.env.WEBHOOK_ENV_FILE = envFile;
    process.env.LINEAR_WEBHOOK_SECRETS = `${SECRET},${OTHER_SECRET}`;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_ENV_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  it("a secret-synced webhook starts with no metadata (last seen: never, blank team)", () => {
    const row = rowFor(SECRET);
    expect(row).toBeDefined();
    expect(row!.lastSeen).toBeNull();
    expect(row!.teamLabel).toBe("");
  });

  it("stamps lastSeen for the delivering secret", () => {
    const t = Date.UTC(2026, 6, 25, 12, 0, 0);
    recordWebhookSeen(SECRET, { now: t });
    const row = rowFor(SECRET);
    expect(row!.lastSeen).toBe(new Date(t).toISOString());
  });

  it("only stamps the secret that delivered, not its siblings", () => {
    recordWebhookSeen(SECRET, { now: Date.UTC(2026, 6, 25, 12, 0, 0) });
    expect(rowFor(SECRET)!.lastSeen).not.toBeNull();
    expect(rowFor(OTHER_SECRET)!.lastSeen).toBeNull();
  });

  it("backfills the Team label from the delivered team key when none is stored", () => {
    recordWebhookSeen(SECRET, { teamKey: "LSO", now: Date.UTC(2026, 6, 25, 12, 0, 0) });
    expect(rowFor(SECRET)!.teamLabel).toBe("LSO");
  });

  it("never overwrites an operator-supplied team label with the delivered key", () => {
    // Seed a sidecar entry as the console would (team typed by a human).
    const metaFile = path.join(envDir, ".webhooks-metadata.json");
    const id = "wh_" + crypto.createHash("sha256").update(SECRET).digest("hex").slice(0, 16);
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ [id]: { url: "https://x.example/hook", teamLabel: "Human Label", lastSeen: null } }),
    );

    recordWebhookSeen(SECRET, { teamKey: "LSO", now: Date.UTC(2026, 6, 25, 12, 0, 0) });

    const row = rowFor(SECRET)!;
    expect(row.teamLabel).toBe("Human Label");
    expect(row.url).toBe("https://x.example/hook");
    expect(row.lastSeen).not.toBeNull();
  });

  it("throttles lastSeen writes but still advances after the window", () => {
    const t0 = Date.UTC(2026, 6, 25, 12, 0, 0);
    recordWebhookSeen(SECRET, { now: t0 });
    // Within the throttle window: lastSeen must not move.
    recordWebhookSeen(SECRET, { now: t0 + 30_000 });
    expect(rowFor(SECRET)!.lastSeen).toBe(new Date(t0).toISOString());
    // Past the window: it advances.
    const t1 = t0 + 61_000;
    recordWebhookSeen(SECRET, { now: t1 });
    expect(rowFor(SECRET)!.lastSeen).toBe(new Date(t1).toISOString());
  });

  it("flushes a team backfill immediately even inside the throttle window", () => {
    const t0 = Date.UTC(2026, 6, 25, 12, 0, 0);
    recordWebhookSeen(SECRET, { now: t0 }); // stamps lastSeen, no team
    expect(rowFor(SECRET)!.teamLabel).toBe("");
    // A follow-up delivery inside the window that carries a team key must still
    // persist the label (a metadata change is worth a write).
    recordWebhookSeen(SECRET, { teamKey: "BBS", now: t0 + 5_000 });
    expect(rowFor(SECRET)!.teamLabel).toBe("BBS");
  });
});
