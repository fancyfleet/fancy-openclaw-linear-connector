import { getAccessToken, getAgents } from "./agents.js";
import { resolveBodiesForRole } from "./escalation-gate.js";

export const STEWARD_ROLE = "steward";

function configuredBody(envName: string): string | undefined {
  const value = process.env[envName]?.trim();
  return value || undefined;
}

export async function resolveFirstBodyForRole(roleId: string): Promise<string | undefined> {
  const bodies = await resolveBodiesForRole(roleId);
  return bodies[0];
}

export async function resolveStewardBody(): Promise<string | undefined> {
  return configuredBody("LINEAR_CONNECTOR_STEWARD_BODY") ?? await resolveFirstBodyForRole(STEWARD_ROLE);
}

export async function resolveServiceBody(): Promise<string | undefined> {
  return configuredBody("LINEAR_CONNECTOR_SERVICE_BODY") ?? await resolveStewardBody();
}

export async function getAccessTokenForRole(roleId: string): Promise<string | undefined> {
  const bodies = await resolveBodiesForRole(roleId);
  for (const body of bodies) {
    const token = getAccessToken(body);
    if (token) return token;
  }
  return undefined;
}

export async function getServiceAccessToken(): Promise<string | undefined> {
  const configured = configuredBody("LINEAR_CONNECTOR_SERVICE_BODY");
  if (configured) {
    const token = getAccessToken(configured);
    if (token) return token;
  }
  const roleToken = await getAccessTokenForRole(STEWARD_ROLE);
  return roleToken ?? getAgents().find((agent) => agent.status !== "off-linear" && agent.accessToken)?.accessToken;
}

export function fallbackAccessToken(): string | undefined {
  return process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
}

export async function getConnectorAuthToken(): Promise<string | undefined> {
  try {
    return await getServiceAccessToken() ?? fallbackAccessToken();
  } catch {
    return fallbackAccessToken() ?? getAgents().find((agent) => agent.status !== "off-linear" && agent.accessToken)?.accessToken;
  }
}

export function getConfiguredServiceBody(): string | undefined {
  return configuredBody("LINEAR_CONNECTOR_SERVICE_BODY") ?? configuredBody("LINEAR_CONNECTOR_STEWARD_BODY");
}

export function getConnectorAuthTokenSync(): string | undefined {
  const configured = getConfiguredServiceBody();
  return (configured ? getAccessToken(configured) : undefined) ??
    fallbackAccessToken() ??
    getAgents().find((agent) => agent.status !== "off-linear" && agent.accessToken)?.accessToken;
}

export function getServiceAgentConfigSync() {
  const configured = getConfiguredServiceBody();
  return configured ? getAgents().find((agent) => agent.name === configured) : undefined;
}

export async function getServiceAgentConfig() {
  const body = await resolveServiceBody();
  return body ? getAgents().find((agent) => agent.name === body) : undefined;
}

export async function resolveWakeFallbackBody(): Promise<string | undefined> {
  return await resolveServiceBody() ?? getAgents().find((agent) => agent.status !== "off-linear")?.name;
}

export function resolveWakeFallbackBodySync(): string | undefined {
  return getConfiguredServiceBody() ?? getAgents().find((agent) => agent.status !== "off-linear")?.name;
}
