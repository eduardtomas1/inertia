import type { z } from "zod";

import { modelBackendProfileUpdateSchema } from "../../../shared/backend-profile-settings";
import { validateBackendProfileDraft } from "../../../shared/backend-profile-validation";

const UNREADABLE_SETTINGS = "The backend settings could not be read.";
const MAX_MESSAGE_LENGTH = 1_000;

function joinedMessages(messages: readonly string[]): string {
  const unique = [...new Set(messages.map((message) => message.trim()).filter(Boolean))];
  const joined = unique.join(" ");
  return joined.length > MAX_MESSAGE_LENGTH
    ? `${joined.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`
    : joined;
}

export function backendProfileDraftFailure(draft: unknown): string | null {
  const issues = validateBackendProfileDraft(draft);
  return issues.length === 0
    ? null
    : joinedMessages(issues.map(({ message }) => message));
}

export function backendProfileIssueFailure(issues: readonly z.core.$ZodIssue[]): string {
  return joinedMessages(issues.map((issue) => (
    issue.code === "custom" || issue.code === "too_small" || issue.code === "too_big"
      ? issue.message
      : UNREADABLE_SETTINGS
  )));
}

export function backendProfileUpdateFailure(update: unknown): string | null {
  const result = modelBackendProfileUpdateSchema.safeParse(update);
  return result.success ? null : backendProfileIssueFailure(result.error.issues);
}
