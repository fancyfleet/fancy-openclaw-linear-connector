export const LINEAR_PROXY_PROTOCOL_VERSION = process.env.PROXY_PROTOCOL_VERSION ?? "1";

/**
 * Minimum CLI version required to issue governed workflow mutations.
 *
 * Connector is the source of truth. The CLI reads this via the compatibility
 * endpoint before sending intent-bearing requests; proxy.ts also enforces it
 * server-side so bypasses fail closed.
 */
export function minWorkflowCliVersion(): string {
  return process.env.PROXY_MIN_CLI_VERSION ?? "0.3.0";
}

export function proxyCompatibilityPayload(): {
  protocolVersion: string;
  minCliVersion: string;
} {
  return {
    protocolVersion: LINEAR_PROXY_PROTOCOL_VERSION,
    minCliVersion: minWorkflowCliVersion(),
  };
}
