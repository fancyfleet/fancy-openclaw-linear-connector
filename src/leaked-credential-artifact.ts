/**
 * INF-529: leaked-credential rotation gate — shared artifact detection.
 *
 * Origin: GEN-328 (Jul 24). A known-leaked `GEMINI_API_KEY` sat harvestable in
 * pushed git history because the rotation ticket (AI-2372) was closed *Invalid*
 * without the rotation ever happening — silence read as resolution, and a
 * $300+/day external-harvest bill followed.
 *
 * This module is the single source of truth for two questions, shared by both
 * enforcement layers so they can never disagree:
 *   1. Does an issue carry the rotation-required label?  (`SEC_LEAKED_CREDENTIAL_LABEL`)
 *   2. Is a rotation-confirmation artifact present on the issue? (`hasRotationConfirmation`)
 *
 * Layer 1 (proxy gate, `leaked-credential-gate.ts`) blocks an *agent* close of a
 * labelled ticket that lacks the artifact. Layer 2 (reopen sweep,
 * `leaked-credential-sweep.ts`) re-opens a labelled ticket a *human* closed in
 * the Linear UI (which never traverses the proxy) without the artifact.
 *
 * The non-negotiable outcome (per the ticket): a leaked-credential ticket cannot
 * silently resolve without the key actually being rotated and the old value
 * revoked.
 */

/** Label that marks a ticket as "rotation required before it may close". */
export const SEC_LEAKED_CREDENTIAL_LABEL = "sec:leaked-credential";

/**
 * Structured attestation marker an agent (or human) posts to confirm rotation.
 * Mirrors the `artifact-disclosure:` marker convention already used elsewhere.
 *
 *   <!-- rotation-confirmed: {"credential":"GEMINI_API_KEY","revoked":true} -->
 *
 * The JSON payload MUST assert `revoked: true` — rotating a key while leaving the
 * old value live does not neutralize an already-pushed secret, so a mere
 * "rotated" claim without revocation does not satisfy the gate.
 */
const ROTATION_MARKER_RE = /<!--\s*rotation-confirmed:\s*(\{.*?\})\s*-->/i;

/**
 * Plain-text fallback so the attestation is writable without HTML — a line that
 * begins with `ROTATION-CONFIRMED` and, somewhere in the same comment, asserts
 * revocation/disablement of the old value.
 *
 *   ROTATION-CONFIRMED: rotated GEMINI_API_KEY, old value revoked in console.
 */
const ROTATION_PLAINTEXT_RE = /(^|\n)\s*ROTATION-CONFIRMED\b/i;
const REVOCATION_RE = /\b(revoke[d]?|revocation|disabled|deleted|deactivat(?:e|ed))\b/i;

/**
 * True when a single comment body constitutes a valid rotation confirmation.
 *
 * Accepts either:
 *   • the structured marker with a JSON payload asserting `revoked: true`, or
 *   • a `ROTATION-CONFIRMED` plaintext line that also asserts revocation.
 *
 * Both forms require an affirmative revocation signal — the whole point is that
 * the old, already-pushed value is dead, not merely superseded.
 */
export function commentConfirmsRotation(body: string): boolean {
  if (!body) return false;

  const marker = ROTATION_MARKER_RE.exec(body);
  if (marker) {
    try {
      const payload = JSON.parse(marker[1]) as Record<string, unknown>;
      if (payload.revoked === true) return true;
    } catch {
      // A corrupt marker must not be treated as a valid attestation; fall
      // through to the plaintext check rather than silently accepting it.
    }
  }

  if (ROTATION_PLAINTEXT_RE.test(body) && REVOCATION_RE.test(body)) return true;

  return false;
}

/**
 * True when any comment in the supplied set confirms rotation. Callers pass the
 * bodies they fetched (proxy gate scans recent comments; sweep scans the same),
 * keeping the transport concern out of this pure predicate so it is trivially
 * testable.
 */
export function anyCommentConfirmsRotation(bodies: Iterable<string>): boolean {
  for (const body of bodies) {
    if (commentConfirmsRotation(body)) return true;
  }
  return false;
}
