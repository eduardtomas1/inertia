import type { ChatMessage, ServerEvent } from "@shared/contracts";
import type { SecretRequestReference, SecretRequestStatus, SecretRequestStorage } from "@shared/agent-secrets";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type SecretRequestMessage = ChatMessage & { turnId: string; secretRequest: SecretRequestReference };

export type SecretRequestCommand = Extract<CommandWithoutId, { type: `secret-request.${string}` }>;

export type SecretRequestCommandRunner = (
  key: SecretRequestCommand["type"],
  command: SecretRequestCommand,
) => Promise<ServerEvent>;

export const SECRET_REQUEST_LABEL = "Asking for a secret";
export const SECRET_REQUEST_PLACEHOLDER = "Paste the secret";
export const SECRET_REQUEST_SAVE_FAILED = "The secret could not be saved. Try again.";
export const SECRET_REQUEST_MIN_LENGTH_ISSUE = "The secret must be at least 4 characters long.";
export const SECRET_REQUEST_READ_ONLY = "Waiting for your answer in the main window";

const SETTLED_COPY: Readonly<Record<Exclude<SecretRequestStatus, "pending" | "saved">, string>> = {
  declined: "Declined",
  ended: "Request ended",
  expired: "Expired",
  revoked: "Revoked",
};

const ANNOUNCEMENTS: Readonly<Partial<Record<SecretRequestStatus, string>>> = {
  saved: "Secret saved",
  declined: "Declined",
  ended: "Request ended",
  expired: "Secret expired",
  revoked: "Secret revoked",
};

const KNOWN_FAILURES = [
  "Paste the secret as text.",
  "The secret is longer than 16,384 characters.",
  "Paste the secret. Only spaces or line breaks were entered.",
  "Paste the secret itself. The masked placeholder cannot be saved.",
  "The secret must be on a single line.",
  SECRET_REQUEST_MIN_LENGTH_ISSUE,
  "That secret request is no longer pending.",
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function isSecretRequestMessage(message: ChatMessage): message is SecretRequestMessage {
  const reference = message.secretRequest;
  return message.role === "system"
    && typeof message.turnId === "string"
    && typeof reference === "object"
    && reference !== null
    && typeof reference.requestId === "string"
    && typeof reference.title === "string"
    && typeof reference.status === "string";
}

export function pendingSecretRequest(messages: readonly ChatMessage[]): SecretRequestMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isSecretRequestMessage(message) && message.secretRequest.status === "pending") return message;
  }
  return null;
}

export function secretRequestElementId(requestId: string): string {
  return `secret-request-${requestId}`;
}

export function secretRequestFootnote(ttlHours: number): string {
  const hours = Number.isSafeInteger(ttlHours) && ttlHours > 0 ? ttlHours : 24;
  return `Kept out of chat, in a private file this agent's commands can read for ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function secretRequestExpiry(expiresAt: string | null, now: number): string {
  const remaining = (expiresAt ? Date.parse(expiresAt) : Number.NaN) - now;
  if (!Number.isFinite(remaining)) return "expiry unknown";
  if (remaining <= 0) return "expiring now";
  if (remaining >= HOUR_MS) return `expires in ${Math.floor(remaining / HOUR_MS)}h`;
  return `expires in ${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
}

export function secretRequestSavedAgo(answeredAt: string, now: number): string {
  const elapsed = now - Date.parse(answeredAt);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE_MS) return "Saved just now";
  if (elapsed < HOUR_MS) return `Saved ${Math.floor(elapsed / MINUTE_MS)}m ago`;
  return `Saved ${Math.floor(elapsed / HOUR_MS)}h ago`;
}

export function secretRequestStorageLabel(storage: SecretRequestStorage | null): string {
  return storage === "memory" ? "Until Inertia quits" : "System keychain";
}

export function secretRequestStatusText(reference: SecretRequestReference, now: number): string {
  if (reference.status === "pending") return SECRET_REQUEST_READ_ONLY;
  if (reference.status === "saved") {
    const saved = `Saved · ${secretRequestExpiry(reference.expiresAt, now)}`;
    return reference.storage === "memory" ? `${saved} · kept until Inertia quits` : saved;
  }
  return SETTLED_COPY[reference.status];
}

export function secretRequestAnnouncement(status: SecretRequestStatus): string {
  return ANNOUNCEMENTS[status] ?? "";
}

export function secretSaveFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return KNOWN_FAILURES.find((known) => message.endsWith(known)) ?? SECRET_REQUEST_SAVE_FAILED;
}

export function secretValueIssue(value: string): string | null {
  const secret = value.trim();
  if (secret.length === 0) return null;
  return secret.length < 4 ? SECRET_REQUEST_MIN_LENGTH_ISSUE : null;
}

export const SECRET_REQUEST_SETTLED_HEIGHT = 36;

export function estimateSecretRequestHeight(reference: SecretRequestReference, columns: number): number {
  if (reference.status !== "pending") return SECRET_REQUEST_SETTLED_HEIGHT + 8;
  const width = Math.max(24, columns);
  const lines = reference.description.split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0);
  return 172 + lines * 20;
}
