import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
 * Like {@link verifyLinearSignatureMulti}, but returns the secret that matched
 * (or `null` if none did) so the caller can attribute the delivery to a
 * specific registered webhook — e.g. to stamp its last-seen metadata.
 *
 * Comparison is still constant-time per secret. The identity of the matched
 * secret is used only server-side (never returned to the HTTP caller), so this
 * does not weaken the "don't leak which secret matched" property of the
 * request/response surface.
 */
export function matchLinearSignature(
  rawBody: Buffer,
  signature: string,
  secrets: string[]
): string | null {
  if (!signature || secrets.length === 0) {
    return null;
  }

  for (const secret of secrets) {
    if (verifyLinearSignature(rawBody, signature, secret)) {
      return secret;
    }
  }
  return null;
}

export interface SignatureMismatchTransformMatch {
  transform: string;
  secretIndex: number;
  secretFingerprint: string;
  originalLength: number;
  candidateLength: number;
}

export interface SignatureMismatchDiagnostic {
  armed: boolean;
  remainingBudget: number;
  testedTransforms: number;
  testedSecrets: number;
  match: SignatureMismatchTransformMatch | null;
  rawBodyPath?: string;
}

interface CandidateBody {
  transform: string;
  body: Buffer;
}

let rejectDiagnosticBudget: number | null = null;

function parseRejectDiagnosticBudget(): number {
  const raw = process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_BUDGET;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function resetSignatureRejectDiagnosticBudgetForTests(): void {
  rejectDiagnosticBudget = null;
}

function consumeRejectDiagnosticBudget(): { armed: boolean; remainingBudget: number } {
  if (rejectDiagnosticBudget === null) {
    rejectDiagnosticBudget = parseRejectDiagnosticBudget();
  }
  if (rejectDiagnosticBudget <= 0) {
    return { armed: false, remainingBudget: 0 };
  }
  rejectDiagnosticBudget -= 1;
  return { armed: true, remainingBudget: rejectDiagnosticBudget };
}

function secretFingerprint(secret: string): string {
  return secret.slice(-4);
}

function nfc(rawBody: Buffer): Buffer {
  return Buffer.from(rawBody.toString("utf8").normalize("NFC"), "utf8");
}

function nfd(rawBody: Buffer): Buffer {
  return Buffer.from(rawBody.toString("utf8").normalize("NFD"), "utf8");
}

function latin1ToUtf8(rawBody: Buffer): Buffer {
  return Buffer.from(rawBody.toString("latin1"), "utf8");
}

function utf8ToLatin1(rawBody: Buffer): Buffer {
  return Buffer.from(rawBody.toString("utf8"), "latin1");
}

export function candidateSignatureNormalizations(rawBody: Buffer): CandidateBody[] {
  const text = rawBody.toString("utf8");
  return [
    { transform: "trim-one-lf", body: rawBody.at(-1) === 0x0a ? rawBody.subarray(0, -1) : rawBody },
    {
      transform: "trim-one-crlf",
      body: rawBody.length >= 2 && rawBody.at(-2) === 0x0d && rawBody.at(-1) === 0x0a
        ? rawBody.subarray(0, -2)
        : rawBody,
    },
    { transform: "trim-trailing-ascii-whitespace", body: Buffer.from(text.replace(/[ \t\r\n]+$/u, ""), "utf8") },
    { transform: "append-lf", body: Buffer.concat([rawBody, Buffer.from("\n")]) },
    { transform: "append-crlf", body: Buffer.concat([rawBody, Buffer.from("\r\n")]) },
    { transform: "lf-to-crlf", body: Buffer.from(text.replace(/(?<!\r)\n/gu, "\r\n"), "utf8") },
    { transform: "crlf-to-lf", body: Buffer.from(text.replace(/\r\n/gu, "\n"), "utf8") },
    { transform: "remove-utf8-bom", body: rawBody.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? rawBody.subarray(3) : rawBody },
    { transform: "utf8-nfc-reencode", body: nfc(rawBody) },
    { transform: "utf8-nfd-reencode", body: nfd(rawBody) },
    { transform: "latin1-to-utf8", body: latin1ToUtf8(rawBody) },
    { transform: "utf8-to-latin1", body: utf8ToLatin1(rawBody) },
  ];
}

function persistRejectedRawBody(rawBody: Buffer): string {
  const baseDir = process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_DIR
    ?? path.join(os.tmpdir(), "openclaw-linear-webhook-rejects");
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const filename = `inf586-reject-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.body`;
  const target = path.join(baseDir, filename);
  fs.writeFileSync(target, rawBody, { mode: 0o600 });
  return target;
}

export function diagnoseLinearSignatureMismatch(
  rawBody: Buffer,
  signature: string,
  secrets: string[],
): SignatureMismatchDiagnostic {
  const budget = consumeRejectDiagnosticBudget();
  if (!budget.armed) {
    return {
      armed: false,
      remainingBudget: 0,
      testedTransforms: 0,
      testedSecrets: 0,
      match: null,
    };
  }

  const candidates = candidateSignatureNormalizations(rawBody);
  for (const candidate of candidates) {
    for (let i = 0; i < secrets.length; i += 1) {
      if (verifyLinearSignature(candidate.body, signature, secrets[i])) {
        return {
          armed: true,
          remainingBudget: budget.remainingBudget,
          testedTransforms: candidates.length,
          testedSecrets: secrets.length,
          match: {
            transform: candidate.transform,
            secretIndex: i,
            secretFingerprint: secretFingerprint(secrets[i]),
            originalLength: rawBody.length,
            candidateLength: candidate.body.length,
          },
        };
      }
    }
  }

  return {
    armed: true,
    remainingBudget: budget.remainingBudget,
    testedTransforms: candidates.length,
    testedSecrets: secrets.length,
    match: null,
    rawBodyPath: persistRejectedRawBody(rawBody),
  };
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
