import { notify } from "../alerts/alert-bus.js";
import type { RegisteredWebhookDescriptor } from "./registry.js";

export interface RejectedWebhookDiagnostic {
  webhookId: string | null;
  organizationId: string | null;
  teamKey: string | null;
  type: string | null;
  action: string | null;
  parseStatus: "parsed" | "malformed" | "empty";
}

export interface WebhookSecretDriftRecord {
  diagnostic: RejectedWebhookDiagnostic;
  secretCount: number;
  /**
   * INF-667 — the registry snapshot at reject time, so the alert can name the
   * actionable registration (wh_ id + teamLabel + url + preview) instead of the
   * unactionable Linear webhookId UUID. Optional so callers/tests without a
   * registry still work.
   */
  registered?: RegisteredWebhookDescriptor[];
  occurredAt?: Date;
}

/**
 * INF-667 — correlate a rejected delivery to the registration it *should* have
 * matched, by the `?team=` key surfaced on each registered url. Returns the
 * suspect registration (its secret is missing/rotated relative to Linear) or
 * null when the team can't be matched to a single registration.
 */
export function correlateRegistration(
  diagnostic: RejectedWebhookDiagnostic,
  registered: RegisteredWebhookDescriptor[] | undefined,
): RegisteredWebhookDescriptor | null {
  if (!registered || !diagnostic.teamKey) return null;
  const matches = registered.filter((r) => r.teamKey === diagnostic.teamKey);
  return matches.length === 1 ? matches[0] : null;
}

interface DriftBucket {
  firstAt: number;
  lastAt: number;
  count: number;
  alerted: boolean;
}

export interface WebhookSecretDriftTrackerOptions {
  threshold?: number;
  windowMs?: number;
  now?: () => Date;
}

const DEFAULT_DRIFT_THRESHOLD = 3;
const DEFAULT_DRIFT_WINDOW_MS = 60 * 60_000;

function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function extractRejectedWebhookDiagnostic(rawBody: Buffer | undefined): RejectedWebhookDiagnostic {
  if (!rawBody || rawBody.length === 0) {
    return { webhookId: null, organizationId: null, teamKey: null, type: null, action: null, parseStatus: "empty" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { webhookId: null, organizationId: null, teamKey: null, type: null, action: null, parseStatus: "malformed" };
  }

  const root = objectValue(payload);
  if (!root) {
    return { webhookId: null, organizationId: null, teamKey: null, type: null, action: null, parseStatus: "parsed" };
  }
  const data = objectValue(root.data);
  const team = objectValue(data?.team);

  return {
    webhookId: stringValue(root.webhookId),
    organizationId: stringValue(root.organizationId),
    teamKey: stringValue(root.teamKey) ?? stringValue(data?.teamKey) ?? stringValue(team?.key),
    type: stringValue(root.type),
    action: stringValue(root.action),
    parseStatus: "parsed",
  };
}

export function webhookDriftKey(diagnostic: RejectedWebhookDiagnostic): string | null {
  if (!diagnostic.webhookId && !diagnostic.teamKey) return null;
  return `${diagnostic.teamKey ?? "unknown-team"}|${diagnostic.webhookId ?? "unknown-webhook"}`;
}

export class WebhookSecretDriftTracker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly buckets = new Map<string, DriftBucket>();

  constructor(options: WebhookSecretDriftTrackerOptions = {}) {
    this.threshold = options.threshold ?? envPositiveInt("LINEAR_WEBHOOK_DRIFT_ALERT_THRESHOLD", DEFAULT_DRIFT_THRESHOLD);
    this.windowMs = options.windowMs ?? envPositiveInt("LINEAR_WEBHOOK_DRIFT_WINDOW_MS", DEFAULT_DRIFT_WINDOW_MS);
    this.now = options.now ?? (() => new Date());
  }

  record(record: WebhookSecretDriftRecord): void {
    const key = webhookDriftKey(record.diagnostic);
    if (!key) return;

    const nowMs = (record.occurredAt ?? this.now()).getTime();
    const current = this.buckets.get(key);
    const bucket =
      current && nowMs - current.firstAt <= this.windowMs
        ? current
        : { firstAt: nowMs, lastAt: nowMs, count: 0, alerted: false };

    bucket.count += 1;
    bucket.lastAt = nowMs;
    this.buckets.set(key, bucket);

    if (bucket.alerted || bucket.count < this.threshold) return;
    bucket.alerted = true;

    const team = record.diagnostic.teamKey ?? "unknown team";
    const webhook = record.diagnostic.webhookId ?? "unknown webhook";
    // INF-667 — resolve the unactionable Linear UUID to the registry's own
    // human-facing metadata so the operator knows exactly which registration to
    // fix. The suspect is the single registration whose `?team=` matches; the
    // full table is attached as a fallback when no single suspect is found.
    const suspect = correlateRegistration(record.diagnostic, record.registered);
    const remediation = suspect
      ? `The registered webhook for team ${team} is "${suspect.teamLabel}" (${suspect.id}) → ${suspect.url}, ` +
        `last matched ${suspect.lastSeen ?? "never"}. ` +
        "Its signing secret does not match what Linear signs with — re-copy the signing secret from " +
        "Linear → Settings → API → Webhooks into the helm Webhook UI for that team (or rotate on both sides)."
      : "Its signing secret is missing or rotated; add/regenerate it through /admin/api/webhooks " +
        "(see registeredWebhooks below for the registered secrets and their last-matched times).";
    notify({
      severity: "warning",
      source: "webhook-secret-drift",
      title: `Linear webhook secret drift: team ${team} / webhook ${webhook}`,
      detail: {
        teamKey: record.diagnostic.teamKey,
        webhookId: record.diagnostic.webhookId,
        organizationId: record.diagnostic.organizationId,
        type: record.diagnostic.type,
        action: record.diagnostic.action,
        rejectCount: bucket.count,
        windowMs: this.windowMs,
        loadedHmacCount: record.secretCount,
        suspectRegistration: suspect,
        registeredWebhooks: record.registered ?? null,
        message:
          `Team ${team} / webhook ${webhook} sent ${bucket.count} events in the drift window ` +
          `that matched none of the ${record.secretCount} loaded Linear webhook secrets. ` +
          remediation,
      },
      dedupKey: `webhook-secret-drift|${key}`,
    });
  }
}
