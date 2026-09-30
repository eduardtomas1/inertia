import type { AgentTurn } from "@shared/contracts";

const REASONS: Partial<Record<NonNullable<AgentTurn["continuationReasonCode"]>, string>> = {
  "provider-installation-changed": "Provider updated",
  "provider-installation-unverified": "Provider could not be verified",
  "stale-provider-session": "Saved session no longer available",
  "incompatible-model-changed": "Model changed",
  "incompatible-performance-mode-changed": "Response speed changed",
  "backend-profile-changed": "Model backend changed",
  "backend-configuration-changed": "Model backend reconfigured",
  "backend-endpoint-changed": "Model backend endpoint changed",
};

export function sessionRecoveryDetail(
  turn: Pick<AgentTurn, "continuationReasonCode" | "sessionRecovery">,
): string | null {
  const recovery = turn.sessionRecovery;
  if (!recovery) return null;
  const { restoredMessageCount: restored, omittedMessageCount: omitted } = recovery;
  const outcome = recovery.historyWithheld === "endpoint-changed"
    ? "Earlier messages were not restored because the model endpoint changed"
    : restored > 0
    ? `${restored} earlier ${restored === 1 ? "message" : "messages"} restored${omitted > 0 ? ` · ${omitted} omitted` : ""}`
    : omitted > 0
      ? "Earlier messages did not fit and were not restored"
      : "Earlier messages were not restored automatically";
  const reason = turn.continuationReasonCode
    ? REASONS[turn.continuationReasonCode]
    : undefined;
  return reason ? `${reason} · ${outcome}` : outcome;
}
