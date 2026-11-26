import { AGENT_SECRET_SAVE_ERRORS, AGENT_SECRET_VALUE_ISSUES } from "@shared/agent-secret-save-errors";
import { AGENT_SECRET_MAX_LENGTH, AGENT_SECRET_MIN_LENGTH } from "@shared/agent-secrets";

export const SECRET_REQUEST_PLACEHOLDER = "Paste the secret";
export const SECRET_REQUEST_SAVE_FAILED = "The secret could not be saved. Try again.";
export const SECRET_REQUEST_DECLINE_FAILED = "Couldn't decline. Try again.";
export const SECRET_REQUEST_MIN_LENGTH_ISSUE = AGENT_SECRET_VALUE_ISSUES.tooShort;

const KNOWN_FAILURES: readonly string[] = [
  ...Object.values(AGENT_SECRET_VALUE_ISSUES),
  ...Object.values(AGENT_SECRET_SAVE_ERRORS),
];

export function secretRequestFootnote(ttlHours: number): string {
  const hours = Number.isSafeInteger(ttlHours) && ttlHours > 0 ? ttlHours : 24;
  return `Kept out of chat, in a private file this agent's commands can read for ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function secretSaveFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return KNOWN_FAILURES.find((known) => message.endsWith(known)) ?? SECRET_REQUEST_SAVE_FAILED;
}

export function secretDeclineFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.endsWith(AGENT_SECRET_SAVE_ERRORS.notPending)
    ? AGENT_SECRET_SAVE_ERRORS.notPending
    : SECRET_REQUEST_DECLINE_FAILED;
}

export function secretValueIssue(value: string): string | null {
  if (value.length > AGENT_SECRET_MAX_LENGTH) return AGENT_SECRET_VALUE_ISSUES.tooLong;
  const secret = value.trim();
  if (secret.length === 0) return null;
  return secret.length < AGENT_SECRET_MIN_LENGTH ? SECRET_REQUEST_MIN_LENGTH_ISSUE : null;
}
