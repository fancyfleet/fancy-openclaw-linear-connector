/**
 * INF-617 — the admin webhooks table showed "Last seen: never" for every row
 * because nothing on the verification path ever attributed a delivery to a
 * secret. These tests grade `recordWebhookSeen`, the writer that closes that
 * gap, and its round-trip through `listWebhooks`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWebhook, listWebhooks, recordWebhookSeen } from "./registry.js";

const VALID_URL = "https://linear-webhook.fancymatt.com/webhook";
const VALID_SECRET = "lin_wh_inf617_abcdef1234567890";
const VALID_TEAM = "Private Team A";

describe("INF-617 — recordWebhookSeen populates the admin table's last-seen", () => {
  let envDir: string;
  let envFile: string;

  function setSecrets(...secrets: string[]): void {
    process.env.LINEAR_WEBHOOK_SECRETS = secrets.join(",");
  }

  beforeEach(() => {
    envDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf617-env-"));
    envFile = path.join(envDir, ".env");
    fs.writeFileSync(envFile, "");
    process.env.WEBHOOK_ENV_FILE = envFile;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_ENV_FILE;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    delete process.env.LINEAR_WEBHOOK_SECRET;
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  it("stamps last-seen on a form-added webhook without losing its url/team", () => {
    const added = addWebhook({ url: VALID_URL, secret: VALID_SECRET, teamLabel: VALID_TEAM });
    expect(added.ok).toBe(true);

    const before = listWebhooks().find((r) => r.url === VALID_URL)!;
    expect(before.lastSeen).toBeNull();

    recordWebhookSeen(VALID_SECRET, "2026-07-25T12:00:00.000Z");

    const after = listWebhooks().find((r) => r.url === VALID_URL)!;
    expect(after.lastSeen).toBe("2026-07-25T12:00:00.000Z");
    // Metadata entered at creation must survive a last-seen stamp.
    expect(after.url).toBe(VALID_URL);
    expect(after.teamLabel).toBe(VALID_TEAM);
  });

  it("populates last-seen for an env-seeded secret that never went through the form", () => {
    // The incident-response case: an org/team secret set directly in
    // LINEAR_WEBHOOK_SECRETS has no metadata entry, so url/team are blank — but
    // last-seen must still reflect real traffic instead of "never".
    setSecrets(VALID_SECRET);
    expect(listWebhooks()[0].lastSeen).toBeNull();

    recordWebhookSeen(VALID_SECRET, "2026-07-25T13:30:00.000Z");

    const row = listWebhooks()[0];
    expect(row.lastSeen).toBe("2026-07-25T13:30:00.000Z");
    expect(row.url).toBe("");
    expect(row.teamLabel).toBe("");
  });

  it("advances last-seen on repeat deliveries", () => {
    setSecrets(VALID_SECRET);
    recordWebhookSeen(VALID_SECRET, "2026-07-25T10:00:00.000Z");
    recordWebhookSeen(VALID_SECRET, "2026-07-25T11:00:00.000Z");
    expect(listWebhooks()[0].lastSeen).toBe("2026-07-25T11:00:00.000Z");
  });

  it("defaults to an ISO-8601 now when no timestamp is supplied", () => {
    setSecrets(VALID_SECRET);
    recordWebhookSeen(VALID_SECRET);
    const seen = listWebhooks()[0].lastSeen;
    expect(seen).not.toBeNull();
    expect(new Date(seen as string).toISOString()).toBe(seen);
  });

  it("only stamps the secret that was seen, leaving other rows untouched", () => {
    const other = "lin_wh_inf617_second_secret_0002";
    setSecrets(VALID_SECRET, other);

    recordWebhookSeen(VALID_SECRET, "2026-07-25T14:00:00.000Z");

    const rows = listWebhooks();
    const seenRow = rows.find((r) => r.lastSeen === "2026-07-25T14:00:00.000Z");
    expect(seenRow).toBeDefined();
    expect(rows.filter((r) => r.lastSeen !== null).length).toBe(1);
  });
});
