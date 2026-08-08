import crypto from "crypto";

/**
 * Verifies the HMAC-SHA256 signature for a single secret.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyLinearSignature(
  rawBody: Buffer,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Verifies a Linear webhook signature against multiple secrets.
 *
 * Each Linear webhook (org-level or team-level) has its own signing secret.
 * This function tries each secret until one matches, using constant-time
 * comparison per attempt to avoid leaking which secret matched.
 *
 * @param rawBody   - The raw (unparsed) request body buffer.
 * @param signature - The value of the `x-linear-signature` header.
 * @param secrets   - Array of signing secrets to try.
 * @returns `true` if any secret validates the signature, `false` otherwise.
 */
export function verifyLinearSignatureMulti(
  rawBody: Buffer,
  signature: string,
  secrets: string[]
): boolean {
  if (!signature || secrets.length === 0) {
    return false;
  }

  return secrets.some(secret => verifyLinearSignature(rawBody, signature, secret));
}

/**
 * Parses the webhook secrets from environment variables.
 *
 * Supports two formats:
 * - `LINEAR_WEBHOOK_SECRETS` — comma-separated list (new, preferred)
 * - `LINEAR_WEBHOOK_SECRET` — single secret (legacy, backward compatible)
 *
 * If both are set, `LINEAR_WEBHOOK_SECRETS` takes precedence and
 * `LINEAR_WEBHOOK_SECRET` is included as the first entry.
 */
export function parseWebhookSecrets(): string[] {
  // INF-1330: partition webhook ingress secret by CONNECTOR_ENV.
  // Staging MUST NOT read any production/shared secret variables — when
  // CONNECTOR_ENV=staging the ONLY sources are LINEAR_WEBHOOK_SECRET_STAGING
  // and LINEAR_WEBHOOK_SECRETS_STAGING (AC1: wholly separate ingress secret,
  // no shared ingress path with prod). Production reads only
  // LINEAR_WEBHOOK_SECRET / LINEAR_WEBHOOK_SECRETS.
  const isStaging = process.env.CONNECTOR_ENV?.toLowerCase() === "staging";
  if (isStaging) {
    const stagingSingle = process.env.LINEAR_WEBHOOK_SECRET_STAGING;
    const stagingMulti = process.env.LINEAR_WEBHOOK_SECRETS_STAGING;
    if (stagingMulti) {
      const secrets = stagingMulti.split(",").map(s => s.trim()).filter(Boolean);
      if (stagingSingle && !secrets.includes(stagingSingle)) {
        secrets.unshift(stagingSingle);
      }
      return secrets;
    }
    return stagingSingle ? [stagingSingle] : [];
  }

  const multi = process.env.LINEAR_WEBHOOK_SECRETS;
  const single = process.env.LINEAR_WEBHOOK_SECRET;

  if (multi) {
    const secrets = multi.split(",").map(s => s.trim()).filter(Boolean);
    // Include legacy single secret if set and not already in the list
    if (single && !secrets.includes(single)) {
      secrets.unshift(single);
    }
    return secrets;
  }

  return single ? [single] : [];
}
