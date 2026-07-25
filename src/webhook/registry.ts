/**
 * AI-1986 — Self-service webhook registry.
 *
 * Backs the `/admin/api/webhooks` CRUD surface. The signing secrets are the
 * durable source of truth: they live in the `LINEAR_WEBHOOK_SECRETS` entry of an
 * env file (comma-separated) so `parseWebhookSecrets()` picks them up per request
 * (the AC4 "hot reload"). The env-file path is taken from
 * `process.env.WEBHOOK_ENV_FILE`, falling back to the repo-root `.env` in
 * production — the same env-seam convention as WORKFLOW_DEFS_DIR / ADMIN_WEB_DIST.
 *
 * `LINEAR_WEBHOOK_SECRETS` has no home for the human-facing metadata (url, team
 * label, last-seen), so that is kept in a sidecar JSON file next to the env file,
 * keyed by the webhook id. The id is derived deterministically from the secret so
 * it stays stable across restarts and never leaks the secret itself.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseWebhookSecrets } from "./signature.js";

export interface WebhookRow {
  id: string;
  url: string;
  teamLabel: string;
  secretPreview: string;
  lastSeen: string | null;
}

interface WebhookMeta {
  url: string;
  teamLabel: string;
  lastSeen: string | null;
}

export type AddResult =
  | { ok: true; webhook: WebhookRow }
  | { ok: false; status: number; error: string };

const SECRETS_KEY = "LINEAR_WEBHOOK_SECRETS";

/**
 * INF-615 — minimum interval between `lastSeen` disk writes for a given secret on
 * the delivery hot path. "Last seen within the last minute" is precise enough to
 * spot a drifted/failing webhook while keeping the sidecar off the write path of
 * every single event. A metadata change (new team label) flushes regardless.
 */
const SEEN_THROTTLE_MS = 60_000;

/** Resolve the env file that holds LINEAR_WEBHOOK_SECRETS. */
function envFilePath(): string {
  // dist/webhook/registry.js → ../../.env resolves to the repo root in prod.
  return process.env.WEBHOOK_ENV_FILE ?? fileURLToPath(new URL("../../.env", import.meta.url));
}

/** Sidecar metadata file living beside the env file. */
function metaFilePath(envFile: string): string {
  return path.join(path.dirname(envFile), ".webhooks-metadata.json");
}

/** Deterministic, non-reversible id for a secret — stable and safe to expose. */
function webhookId(secret: string): string {
  return "wh_" + crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

/** Masked preview that exposes only a short suffix, never the full secret. */
export function maskSecret(secret: string): string {
  const suffix = secret.slice(-3);
  const prefixLen = Math.min(7, Math.max(0, secret.length - 6));
  return `${secret.slice(0, prefixLen)}…${suffix}`;
}

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parseEnvValue(contents: string, key: string): string | null {
  for (const line of contents.split("\n")) {
    if (line.startsWith(key + "=")) return line.slice(key.length + 1);
  }
  return null;
}

/** Replace (or append) a `KEY=value` line, preserving every other line. */
function writeEnvValue(file: string, key: string, value: string): void {
  const contents = readFileSafe(file);
  const lines = contents.length ? contents.split("\n") : [];
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(key + "=")) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    while (next.length && next[next.length - 1] === "") next.pop();
    next.push(`${key}=${value}`);
    next.push("");
  }
  fs.writeFileSync(file, next.join("\n"));
}

/**
 * Current secrets from the durable env file (falling back to the in-process env
 * var when the file has no line yet). This is the mutation source of truth so
 * concurrent adds/removes never clobber each other's writes.
 */
function currentSecrets(envFile: string): string[] {
  const fromFile = parseEnvValue(readFileSafe(envFile), SECRETS_KEY);
  const raw = fromFile ?? process.env[SECRETS_KEY] ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function readMeta(envFile: string): Record<string, WebhookMeta> {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFilePath(envFile), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, WebhookMeta>) : {};
  } catch {
    return {};
  }
}

function writeMeta(envFile: string, meta: Record<string, WebhookMeta>): void {
  fs.writeFileSync(metaFilePath(envFile), JSON.stringify(meta, null, 2));
}

/** Persist the secret list to the env file and reflect it in-process (hot reload). */
function persistSecrets(envFile: string, secrets: string[]): void {
  const value = secrets.join(",");
  writeEnvValue(envFile, SECRETS_KEY, value);
  process.env[SECRETS_KEY] = value;
}

/** AC1 — every runtime secret rendered as a row with masked preview + metadata. */
export function listWebhooks(): WebhookRow[] {
  const envFile = envFilePath();
  const meta = readMeta(envFile);
  return parseWebhookSecrets().map((secret) => {
    const id = webhookId(secret);
    const m = meta[id];
    return {
      id,
      url: m?.url ?? "",
      teamLabel: m?.teamLabel ?? "",
      secretPreview: maskSecret(secret),
      lastSeen: m?.lastSeen ?? null,
    };
  });
}

/**
 * INF-615 — stamp a "last seen" timestamp (and backfill the team label) for the
 * secret that just validated an inbound delivery.
 *
 * This is the piece that was missing: `listWebhooks` always read `lastSeen` from
 * the sidecar, but nothing ever wrote it, so every row showed "never". It also
 * closes the URL/Team-empty gap for secrets that were injected straight into
 * `LINEAR_WEBHOOK_SECRETS` (secret-sync) and so never went through `addWebhook`:
 * the first delivery creates their sidecar stub, and — when the delivered event
 * carries a team key — labels the row with the team it actually belongs to. An
 * operator-supplied `teamLabel` is never overwritten; the URL stays whatever the
 * console stored (it isn't recoverable from a delivery, so orphans keep it blank).
 *
 * Called on the hot delivery path, so writes are throttled: `lastSeen` is only
 * re-persisted once per `SEEN_THROTTLE_MS` per secret unless there is also a
 * metadata change (a fresh team label) worth flushing. Best-effort by design —
 * the caller swallows failures so a metadata write can never fail a delivery.
 */
export function recordWebhookSeen(
  secret: string,
  opts: { teamKey?: string; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const teamKey = typeof opts.teamKey === "string" ? opts.teamKey.trim() : "";

  const envFile = envFilePath();
  const id = webhookId(secret);
  const meta = readMeta(envFile);
  const existing = meta[id];

  // Backfill the team label only when we have one and none is stored yet — never
  // clobber a label the operator typed in the console.
  const nextTeamLabel = existing?.teamLabel || teamKey;
  const teamChanged = nextTeamLabel !== (existing?.teamLabel ?? "");

  const prevSeen = existing?.lastSeen ? Date.parse(existing.lastSeen) : NaN;
  const seenFresh = !Number.isNaN(prevSeen) && now - prevSeen < SEEN_THROTTLE_MS;
  if (seenFresh && !teamChanged) return; // nothing worth a disk write

  meta[id] = {
    url: existing?.url ?? "",
    teamLabel: nextTeamLabel,
    lastSeen: new Date(now).toISOString(),
  };
  writeMeta(envFile, meta);
}

/** AC2 + AC4 — validate, persist the secret, store metadata, echo the new row. */
export function addWebhook(input: {
  url?: unknown;
  secret?: unknown;
  teamLabel?: unknown;
}): AddResult {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  const teamLabelRaw = typeof input.teamLabel === "string" ? input.teamLabel.trim() : "";

  if (!secret) return { ok: false, status: 400, error: "A signing secret is required." };
  if (!url) return { ok: false, status: 400, error: "A webhook URL is required." };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, error: "The webhook URL is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, status: 400, error: "The webhook URL must use HTTPS." };
  }

  const envFile = envFilePath();
  const secrets = currentSecrets(envFile);
  if (!secrets.includes(secret)) secrets.push(secret);
  persistSecrets(envFile, secrets);

  const id = webhookId(secret);
  const meta = readMeta(envFile);
  const teamLabel = teamLabelRaw || parsed.hostname;
  meta[id] = { url, teamLabel, lastSeen: meta[id]?.lastSeen ?? null };
  writeMeta(envFile, meta);

  return {
    ok: true,
    webhook: { id, url, teamLabel, secretPreview: maskSecret(secret), lastSeen: meta[id].lastSeen },
  };
}

/** AC3 — remove the secret from the env file + runtime and drop its metadata. */
export function removeWebhook(id: string): { ok: boolean; status: number } {
  const envFile = envFilePath();
  const secrets = currentSecrets(envFile);
  const idx = secrets.findIndex((s) => webhookId(s) === id);
  if (idx === -1) return { ok: false, status: 404 };

  secrets.splice(idx, 1);
  persistSecrets(envFile, secrets);

  const meta = readMeta(envFile);
  if (meta[id]) {
    delete meta[id];
    writeMeta(envFile, meta);
  }
  return { ok: true, status: 200 };
}
