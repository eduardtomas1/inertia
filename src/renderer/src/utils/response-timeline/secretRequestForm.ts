import { AGENT_SECRET_SAVE_ERRORS, AGENT_SECRET_VALUE_ISSUES } from "@shared/agent-secret-save-errors";

export const SECRET_REQUEST_PLACEHOLDER = "Paste the secret";
export const SECRET_REQUEST_SAVE_FAILED = "The secret could not be saved. Try again.";
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

export function secretValueIssue(value: string): string | null {
  const secret = value.trim();
  if (secret.length === 0) return null;
  return secret.length < 4 ? SECRET_REQUEST_MIN_LENGTH_ISSUE : null;
}
