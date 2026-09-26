import type { ClientCommand } from "@shared/contracts";

type SendPayload = Extract<ClientCommand, { type: "message.send" }>["payload"];
interface StoredIdentity { fingerprint: string; requestId: string }
const keyFor = (conversationId: string) => `inertia:message-delivery:v1:${conversationId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function read(storage: Storage, conversationId: string): StoredIdentity[] {
  const value: unknown = JSON.parse(storage.getItem(keyFor(conversationId)) ?? "[]");
  if (!Array.isArray(value) || value.length > 100 || value.some((item) =>
    !item || typeof item !== "object" || typeof item.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(item.fingerprint) || typeof item.requestId !== "string" || !uuid.test(item.requestId))) {
    throw new Error("Saved message delivery identities could not be read.");
  }
  return value as StoredIdentity[];
}

/** Store only the digest and UUID, so reloading cannot turn a lost receipt into a new send. */
export async function prepareTextSendIdentity(storage: Storage, payload: SendPayload, candidate: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const identities = read(storage, payload.conversationId);
  const previous = identities.find((item) => item.fingerprint === fingerprint);
  if (previous) return previous.requestId;
  if (identities.length >= 100) throw new Error("Check earlier unconfirmed messages before sending more work in this chat.");
  storage.setItem(keyFor(payload.conversationId), JSON.stringify([...identities, { fingerprint, requestId: candidate }]));
  return candidate;
}

export function clearTextSendIdentity(storage: Storage, conversationId: string, requestId: string): void {
  const identities = read(storage, conversationId).filter((item) => item.requestId !== requestId);
  if (identities.length) storage.setItem(keyFor(conversationId), JSON.stringify(identities));
  else storage.removeItem(keyFor(conversationId));
}
