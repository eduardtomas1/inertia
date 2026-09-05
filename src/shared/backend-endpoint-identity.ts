import { sha256 } from "./sha256";

export function canonicalBackendEndpointUrl(baseUrl: string): string {
  return new URL(baseUrl).toString().replace(/\/$/u, "");
}

/** Canonical identity for a custom-backend URL. */
export function backendEndpointIdentity(baseUrl: string): string {
  return `endpoint:${sha256(canonicalBackendEndpointUrl(baseUrl))}`;
}

export function backendEndpointIdentityMatches(
  baseUrl: string | null,
  endpointIdentity: string | null,
): boolean {
  if (baseUrl === null || endpointIdentity === null) return false;
  try {
    return endpointIdentity === backendEndpointIdentity(baseUrl);
  } catch {
    return false;
  }
}
