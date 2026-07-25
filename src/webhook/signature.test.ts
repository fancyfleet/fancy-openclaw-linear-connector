import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  candidateSignatureNormalizations,
  diagnoseLinearSignatureMismatch,
  matchLinearSignature,
  parseWebhookSecrets,
  resetSignatureRejectDiagnosticBudgetForTests,
  verifyLinearSignature,
  verifyLinearSignatureMulti,
} from "./signature.js";

const SECRET = "test-webhook-secret-abc123";
const PRIVATE_SECRET = "private-team-secret-xyz789";

function makeSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

describe("verifyLinearSignature", () => {
  const body = JSON.stringify({ type: "Issue", action: "create" });
  const rawBody = Buffer.from(body);
  const validSig = makeSignature(body, SECRET);

  it("returns true for a valid signature", () => {
    expect(verifyLinearSignature(rawBody, validSig, SECRET)).toBe(true);
  });

  it("returns false for a wrong signature", () => {
    const badSig = makeSignature(body, "wrong-secret");
    expect(verifyLinearSignature(rawBody, badSig, SECRET)).toBe(false);
  });

  it("returns false for a tampered body", () => {
    const tamperedBody = Buffer.from(
      JSON.stringify({ type: "Issue", action: "remove" })
    );
    expect(verifyLinearSignature(tamperedBody, validSig, SECRET)).toBe(false);
  });

  it("returns false when signature is empty string", () => {
    expect(verifyLinearSignature(rawBody, "", SECRET)).toBe(false);
  });

  it("returns false when secret is empty string", () => {
    expect(verifyLinearSignature(rawBody, validSig, "")).toBe(false);
  });

  it("returns false for a malformed (non-hex) signature", () => {
    expect(verifyLinearSignature(rawBody, "not-hex!!!", SECRET)).toBe(false);
  });

  it("is not susceptible to length mismatch crashing (odd-length hex)", () => {
    expect(verifyLinearSignature(rawBody, "abc", SECRET)).toBe(false);
  });
});

describe("verifyLinearSignatureMulti", () => {
  const body = JSON.stringify({ type: "Issue", action: "create" });
  const rawBody = Buffer.from(body);

  it("returns true when the first secret matches", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(true);
  });

  it("returns true when a later secret matches", () => {
    const sig = makeSignature(body, PRIVATE_SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(true);
  });

  it("returns true when the only secret matches", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET])).toBe(true);
  });

  it("returns false when no secret matches", () => {
    const sig = makeSignature(body, "wrong-secret");
    expect(verifyLinearSignatureMulti(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(false);
  });

  it("returns false for empty secrets array", () => {
    const sig = makeSignature(body, SECRET);
    expect(verifyLinearSignatureMulti(rawBody, sig, [])).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyLinearSignatureMulti(rawBody, "", [SECRET, PRIVATE_SECRET])).toBe(false);
  });

  it("handles 5+ secrets (practical limit for private teams)", () => {
    const secrets = ["s1", "s2", "s3", "s4", "s5"];
    const sig = makeSignature(body, "s4");
    expect(verifyLinearSignatureMulti(rawBody, sig, secrets)).toBe(true);
  });
});

describe("matchLinearSignature (INF-617 — attribute delivery to a secret)", () => {
  const body = JSON.stringify({ type: "Issue", action: "create" });
  const rawBody = Buffer.from(body);

  it("returns the matching secret when the first secret matches", () => {
    const sig = makeSignature(body, SECRET);
    expect(matchLinearSignature(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(SECRET);
  });

  it("returns the matching secret when a later secret matches", () => {
    const sig = makeSignature(body, PRIVATE_SECRET);
    expect(matchLinearSignature(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBe(PRIVATE_SECRET);
  });

  it("returns null when no secret matches", () => {
    const sig = makeSignature(body, "wrong-secret");
    expect(matchLinearSignature(rawBody, sig, [SECRET, PRIVATE_SECRET])).toBeNull();
  });

  it("returns null for an empty secrets array", () => {
    const sig = makeSignature(body, SECRET);
    expect(matchLinearSignature(rawBody, sig, [])).toBeNull();
  });

  it("returns null for an empty signature", () => {
    expect(matchLinearSignature(rawBody, "", [SECRET, PRIVATE_SECRET])).toBeNull();
  });

  it("agrees with verifyLinearSignatureMulti on the match/no-match verdict", () => {
    const sig = makeSignature(body, PRIVATE_SECRET);
    const secrets = [SECRET, PRIVATE_SECRET];
    expect(matchLinearSignature(rawBody, sig, secrets) !== null).toBe(
      verifyLinearSignatureMulti(rawBody, sig, secrets),
    );
  });
});

describe("diagnoseLinearSignatureMismatch (INF-586)", () => {
  const originalEnv = process.env;
  let diagnosticDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    diagnosticDir = fs.mkdtempSync(path.join(os.tmpdir(), "inf586-signature-diagnostic-"));
    process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_DIR = diagnosticDir;
    resetSignatureRejectDiagnosticBudgetForTests();
  });

  afterEach(() => {
    fs.rmSync(diagnosticDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetSignatureRejectDiagnosticBudgetForTests();
  });

  it("provides the requested twelve candidate normalizations", () => {
    expect(candidateSignatureNormalizations(Buffer.from("a\n"))).toHaveLength(12);
  });

  it("is off by default", () => {
    delete process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_BUDGET;
    const rawBody = Buffer.from(JSON.stringify({ type: "Comment" }));
    const signature = makeSignature(rawBody.toString("utf8"), SECRET);

    expect(diagnoseLinearSignatureMismatch(rawBody, signature, [SECRET])).toEqual({
      armed: false,
      remainingBudget: 0,
      testedTransforms: 0,
      testedSecrets: 0,
      match: null,
    });
    expect(fs.readdirSync(diagnosticDir)).toEqual([]);
  });

  it("reports a deterministic transform match without persisting the raw body", () => {
    process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_BUDGET = "2";
    const originalBody = JSON.stringify({ type: "Comment", action: "create" });
    const rawBody = Buffer.from(`${originalBody}\n`);
    const signature = makeSignature(originalBody, PRIVATE_SECRET);

    const result = diagnoseLinearSignatureMismatch(rawBody, signature, [SECRET, PRIVATE_SECRET]);

    expect(result).toMatchObject({
      armed: true,
      remainingBudget: 1,
      testedTransforms: 12,
      testedSecrets: 2,
      match: {
        transform: "trim-one-lf",
        secretIndex: 1,
        secretFingerprint: "z789",
        originalLength: rawBody.length,
        candidateLength: Buffer.byteLength(originalBody),
      },
    });
    expect(result.rawBodyPath).toBeUndefined();
    expect(fs.readdirSync(diagnosticDir)).toEqual([]);
  });

  it("persists the raw body only when no transform matches", () => {
    process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_BUDGET = "1";
    const rawBody = Buffer.from(JSON.stringify({ type: "Comment", body: "sensitive-ish test payload" }));
    const signature = makeSignature("different body", PRIVATE_SECRET);

    const result = diagnoseLinearSignatureMismatch(rawBody, signature, [SECRET, PRIVATE_SECRET]);

    expect(result.match).toBeNull();
    expect(result.rawBodyPath).toBeDefined();
    expect(fs.readFileSync(result.rawBodyPath!, "utf8")).toBe(rawBody.toString("utf8"));
  });

  it("auto-disarms after the configured budget is consumed", () => {
    process.env.LINEAR_WEBHOOK_REJECT_DIAGNOSTIC_BUDGET = "1";
    const rawBody = Buffer.from("body\n");
    const signature = makeSignature("body", SECRET);

    const first = diagnoseLinearSignatureMismatch(rawBody, signature, [SECRET]);
    const second = diagnoseLinearSignatureMismatch(rawBody, signature, [SECRET]);

    expect(first.armed).toBe(true);
    expect(first.remainingBudget).toBe(0);
    expect(second.armed).toBe(false);
  });
});

describe("parseWebhookSecrets", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns single secret from LINEAR_WEBHOOK_SECRET", () => {
    process.env.LINEAR_WEBHOOK_SECRET = "only-secret";
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    expect(parseWebhookSecrets()).toEqual(["only-secret"]);
  });

  it("returns parsed comma-separated secrets from LINEAR_WEBHOOK_SECRETS", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "secret-a, secret-b, secret-c";
    delete process.env.LINEAR_WEBHOOK_SECRET;
    expect(parseWebhookSecrets()).toEqual(["secret-a", "secret-b", "secret-c"]);
  });

  it("prefers LINEAR_WEBHOOK_SECRETS and includes LINEAR_WEBHOOK_SECRET as first entry", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "private-1, private-2";
    process.env.LINEAR_WEBHOOK_SECRET = "org-secret";
    expect(parseWebhookSecrets()).toEqual(["org-secret", "private-1", "private-2"]);
  });

  it("deduplicates if LINEAR_WEBHOOK_SECRET is already in LINEAR_WEBHOOK_SECRETS", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "org-secret, private-1";
    process.env.LINEAR_WEBHOOK_SECRET = "org-secret";
    expect(parseWebhookSecrets()).toEqual(["org-secret", "private-1"]);
  });

  it("trims whitespace and filters empty entries", () => {
    process.env.LINEAR_WEBHOOK_SECRETS = "  a  , , b ,  ";
    delete process.env.LINEAR_WEBHOOK_SECRET;
    expect(parseWebhookSecrets()).toEqual(["a", "b"]);
  });

  it("returns empty array when neither is set", () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRETS;
    expect(parseWebhookSecrets()).toEqual([]);
  });
});
