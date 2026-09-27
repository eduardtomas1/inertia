import type { AgentTurn, SubagentTrace } from "@shared/contracts";

import { requestComposerPrefill } from "./composerPrefill";
import { canFollowUpSubagentTrace } from "./subagentDisclosure";

export function requestSubagentFollowUp(
  conversationId: string,
  trace: SubagentTrace,
  turns: readonly AgentTurn[],
): void {
  if (!canFollowUpSubagentTrace(trace, turns)) return;
  const task = trace.description ?? trace.providerRole ?? "delegated task";
  requestComposerPrefill({
    conversationId,
    text: `Please follow up on the delegated task “${task}” and incorporate its latest result.`,
  });
}
