import type { PrivateConnectRequest, PrivateConnectResponse } from "../../../shared/private-connect/protocol";

export interface PairingInvitation {
  protocolVersion: 1;
  hostId: string;
  invitationId: string;
  pairingSecret: string;
  createdAt: string;
  expiresAt: string;
}

export function parsePairingFragment(fragment: string | null): PairingInvitation | null {
  if (!fragment?.startsWith("#pair=")) return null;
  const encoded = fragment.slice(6);
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const json = atob(encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const value = JSON.parse(json) as unknown;
    if (!plainObject(value)
      || value.protocolVersion !== 1
      || typeof value.hostId !== "string"
      || typeof value.invitationId !== "string"
      || typeof value.pairingSecret !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.expiresAt !== "string") return null;
    return value as unknown as PairingInvitation;
  } catch {
    return null;
  }
}

export function browserDeviceId(): string {
  const key = "inertia-private-connect-device-id";
  const existing = window.localStorage.getItem(key);
  if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing;
  const value = crypto.randomUUID();
  window.localStorage.setItem(key, value);
  return value;
}

export async function jsonRequest<T>(path: string, body: unknown, csrf?: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-Inertia-Private-Connect-CSRF": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(value.message ?? "Private Connect request failed.");
  return value;
}

export async function apiRequest(request: PrivateConnectRequest, csrf: string): Promise<PrivateConnectResponse> {
  return await jsonRequest<PrivateConnectResponse>("/api/request", request, csrf);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
