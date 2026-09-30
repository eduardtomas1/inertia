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
  const withheld = recovery.withheldMessageCount
    ? "Earlier messages from another model endpoint were not restored"
    : "";
  const outcome = restored > 0
    ? `${restored} earlier ${restored === 1 ? "message" : "messages"} restored${omitted > 0 ? ` · ${omitted} omitted` : ""}`
    : omitted > 0
      ? "Earlier messages did not fit and were not restored"
      : withheld || "Earlier messages were not restored automatically";
  const reason = turn.continuationReasonCode
    ? REASONS[turn.continuationReasonCode]
    : undefined;
  const detail = withheld && outcome !== withheld ? `${outcome} · ${withheld}` : outcome;
  return reason ? `${reason} · ${detail}` : detail;
}
