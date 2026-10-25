import type { TurnFailureKind } from "../../../shared/turn-lifecycle";
import type { ProviderRunFailure } from "../../provider/contracts";

const CLAUDE_ASSISTANT_FAILURE_KINDS: Readonly<Record<string, TurnFailureKind>> = {
  "assistant/billing_error": "billing",
  "assistant/authentication_failed": "authentication",
  "assistant/oauth_org_not_allowed": "authentication",
  "assistant/rate_limit": "rate-limited",
  "assistant/model_not_found": "model-not-found",
};

export function turnFailureKind(
  failure: Pick<ProviderRunFailure, "failureKind" | "usageLimited" | "phase" | "terminalEvent"> | undefined,
): TurnFailureKind | undefined {
  if (!failure) return undefined;
  if (failure.failureKind) return failure.failureKind;
  if (failure.usageLimited) return "rate-limited";
  if (failure.terminalEvent && Object.hasOwn(CLAUDE_ASSISTANT_FAILURE_KINDS, failure.terminalEvent)) {
    return CLAUDE_ASSISTANT_FAILURE_KINDS[failure.terminalEvent];
  }
  return failure.phase === "auth" ? "authentication" : undefined;
}
