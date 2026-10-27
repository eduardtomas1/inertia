import { backendEndpointIdentity } from "./backend-endpoint-identity";

export const OFFICIAL_API_KEY_ENDPOINTS = [
  { harnessId: "claude-agent-sdk", baseUrl: "https://api.anthropic.com" },
  { harnessId: "codex-app-server", baseUrl: "https://api.openai.com/v1" },
] as const;

export function officialApiKeyEndpoint(
  harnessId: string,
  endpointIdentity: string | null,
): boolean {
  if (endpointIdentity === null) return false;
  return OFFICIAL_API_KEY_ENDPOINTS.some((endpoint) =>
    endpoint.harnessId === harnessId
    && backendEndpointIdentity(endpoint.baseUrl) === endpointIdentity);
}
