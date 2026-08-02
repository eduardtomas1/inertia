import {
  remotePairingInvitationSchema,
  type RemotePairingInvitation,
} from "./remote-protocol";

const PAIRING_FRAGMENT_PREFIX = "#pair=";
const MAX_PAIRING_FRAGMENT_CHARACTERS = 8_192;

export function createRemotePairingLink(
  companionUrl: string,
  invitation: RemotePairingInvitation,
): string {
  const url = new URL(companionUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Companion URLs cannot contain credentials, query strings, or fragments.",
    );
  }
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(
      remotePairingInvitationSchema.parse(invitation),
    )),
  );
  url.hash = `pair=${payload}`;
  return url.toString();
}

export function parseRemotePairingFragment(
  fragment: string,
): RemotePairingInvitation | null {
  if (!fragment) return null;
  if (
    !fragment.startsWith(PAIRING_FRAGMENT_PREFIX)
    || fragment.length > MAX_PAIRING_FRAGMENT_CHARACTERS
  ) throw new Error("The pairing link is invalid.");
  const encoded = fragment.slice(PAIRING_FRAGMENT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("The pairing link is invalid.");
  }
  try {
    return remotePairingInvitationSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(encoded)),
    ));
  } catch {
    throw new Error("The pairing link is invalid or incompatible.");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${
    "=".repeat((4 - (value.length % 4)) % 4)
  }`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
