/**
 * INF-1212 — dedicated Linear service credential for reconciliation/sweep
 * auth paths, decoupled from any individual agent's OAuth token lifecycle.
 *
 * Every sweep/reconciliation call site previously bottomed out in
 * `getAccessToken("ai")`, so one agent's stale/expired token took down
 * fleet-wide reconciliation simultaneously. This resolver reads a dedicated
 * credential from the environment instead, with its own liveness surfaced
 * independently at /health.
 */

const DEDICATED_ENV_KEYS = [
  "LINEAR_SERVICE_CREDENTIAL",
  "LINEAR_SERVICE_CREDENTIAL_TOKEN",
  "LINEAR_RECONCILIATION_TOKEN",
] as const;

/**
 * Resolves the dedicated service credential for sweep/reconciliation auth.
 * Falls back to the generic (non-agent-specific) env token pair only when no
 * dedicated credential is configured, so existing deployments keep working
 * during rollout.
 */
export function resolveServiceCredential(): string {
  for (const key of DEDICATED_ENV_KEYS) {
    const value = process.env[key];
    if (value) return value;
  }
  return process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
}

export interface ServiceCredentialLiveness {
  active: boolean;
  valid: boolean;
  agent: null;
  source: string | null;
}

/**
 * Independent liveness for the dedicated credential, distinct from any
 * per-agent token status (see getAllTokenStatuses in agents.ts). `agent` is
 * always null — this credential is not tied to an agent identity.
 */
export function getDedicatedCredentialLiveness(): ServiceCredentialLiveness {
  const dedicatedKey = DEDICATED_ENV_KEYS.find((key) => Boolean(process.env[key]));
  const token = resolveServiceCredential();
  const active = Boolean(token);
  return {
    active,
    valid: active,
    agent: null,
    source: dedicatedKey ?? (active ? "env-fallback" : null),
  };
}
