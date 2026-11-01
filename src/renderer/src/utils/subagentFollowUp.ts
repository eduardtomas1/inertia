import type { AgentTurn, SubagentTrace } from "@shared/contracts";

import { requestComposerPrefill } from "./composerPrefill";
import { canFollowUpSubagentTrace } from "./subagentDisclosure";

/** Shown when no message box for the chat is open to receive the follow-up. */
export const SUBAGENT_FOLLOW_UP_UNAVAILABLE = "Open this chat's message box to add the follow-up.";

/**
 * Adds a follow-up request for a live delegated task to the chat's message
 * box. Reports "unavailable" when no message box for the chat received it.
 */
export function requestSubagentFollowUp(
  conversationId: string,
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): "delivered" | "not-applicable" | "unavailable" {
  if (!canFollowUpSubagentTrace(trace, turns)) return "not-applicable";
  const task = trace.description ?? trace.providerRole ?? "delegated task";
  return requestComposerPrefill({
    conversationId,
    text: `Please follow up on the delegated task “${task}” and incorporate its latest result.`,
  }) ? "delivered" : "unavailable";
}
