import {
  PRIVATE_CONNECT_LIMITS,
  PRIVATE_CONNECT_PROTOCOL_VERSION,
  privateConnectInvitationSchema,
  type PrivateConnectInvitation,
} from "./protocol";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function createPrivateConnectInvitation(
  hostId: string,
  now = new Date(),
): PrivateConnectInvitation {
  const invitation = {
    protocolVersion: PRIVATE_CONNECT_PROTOCOL_VERSION,
    hostId,
    invitationId: globalThis.crypto.randomUUID(),
    pairingSecret: randomBytesBase64Url(32),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PRIVATE_CONNECT_LIMITS.pairingTtlMs).toISOString(),
  };
  return privateConnectInvitationSchema.parse(invitation);
}

export function createPrivateConnectPairingLink(
  origin: string,
  invitation: PrivateConnectInvitation,
): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Private Connect links require a clean HTTPS origin.");
  }
  const encoded = base64UrlEncode(JSON.stringify(invitation));
  return `${url.toString()}#pair=${encoded}`;
}

export function parsePrivateConnectPairingFragment(
  fragment: string,
): PrivateConnectInvitation | null {
  if (!fragment.startsWith("#pair=")) return null;
  const encoded = fragment.slice("#pair=".length);
  if (!encoded || encoded.length > 8_192 || !BASE64URL.test(encoded)) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
    return privateConnectInvitationSchema.parse(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
}

function randomBytesBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
