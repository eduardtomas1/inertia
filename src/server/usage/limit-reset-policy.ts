import type { AgentTurn, Conversation } from "../../shared/contracts";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import type { UsageAccount } from "../../shared/provider-usage-limits";
import type { NativeUsageAccount } from "./subscription-io";

export function sameReportedReset(left: string, right: string): boolean {
  return Math.abs(Date.parse(left) - Date.parse(right)) <= 2_000;
}
export const MAX_RESET_WAIT_MS = 31 * 86_400_000;
export const MISSED_RESUME_AFTER_MS = 60 * 60_000;
export function matchesFailedNativeTurn(conversation: Conversation, turn: AgentTurn | null): boolean {
  return conversation.archivedAt === null && conversation.settledAt === null && turn?.status === "failed"
    && conversation.providerId === turn.providerId
    && conversation.modelSelection.backendProfileId === providerNativeBackendProfile(conversation.providerId).id
    && conversation.modelSelection.backendProfileId === turn.modelSelection.backendProfileId
    && conversation.modelSelection.harnessId === turn.modelSelection.harnessId
    && (!conversation.model || conversation.model === turn.model)
    && (!conversation.reasoningEffort || conversation.reasoningEffort === turn.reasoningEffort)
    && conversation.interactionMode === turn.interactionMode && conversation.accessMode === turn.accessMode;
}
export function resumeAccountIdentity(account: NativeUsageAccount): string | null {
  return account.credentialFingerprint ?? account.identityKey ?? null;
}
export type ResetQuota = { kind: "unknown" } | { kind: "available" } | { kind: "exhausted"; resetsAt: string };
export function resetQuota(account: UsageAccount, model: string, now = Date.now()): ResetQuota {
  const updatedAt = Date.parse(account.updatedAt ?? "");
  if (account.status !== "ready" || !Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > 180_000) return { kind: "unknown" };
  const relevant = account.windows.filter((window) => {
    if (account.providerId === "codex") return window.id === "codex:primary" || window.id === "codex:secondary";
    if (account.providerId === "cursor") {
      if (window.id === "cursor:totalPercentUsed") return true;
      if (model === "auto" || model === "provider-default") return ["cursor:autoPercentUsed", "cursor:apiPercentUsed"].includes(window.id);
      return window.id === (model.startsWith("composer") ? "cursor:autoPercentUsed" : "cursor:apiPercentUsed");
    }
    if (account.providerId === "opencode") return model.startsWith("opencode-go/") && /^opencode:go_(rolling|weekly|monthly)$/u.test(window.id);
    if (account.providerId === "kimi") return /^kimi:(weekly|window_\d+)$/u.test(window.id);
    if (account.providerId !== "claude") return false;
    if (["claude:five_hour", "claude:seven_day", "claude:seven_day_oauth_apps"].includes(window.id)) return true;
    return (window.id === "claude:seven_day_opus" && model.includes("opus"))
      || (window.id === "claude:seven_day_sonnet" && model.includes("sonnet"));
  });
  const unrelated = new Set(["cursor:autoPercentUsed", "cursor:apiPercentUsed", "claude:seven_day_opus", "claude:seven_day_sonnet", "claude:seven_day_overage_included"]);
  if (account.windows.some((window) => window.remainingPercent === 0 && !relevant.includes(window) && !unrelated.has(window.id))) return { kind: "unknown" };
  if (!relevant.length || relevant.some(({ remainingPercent }) => remainingPercent === null
    || !Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100)) return { kind: "unknown" };
  const exhausted = relevant.filter((window) => window.remainingPercent === 0);
  if (!exhausted.length) return { kind: "available" };
  const resets = exhausted.map(({ resetsAt }) => Date.parse(resetsAt ?? ""));
  if (resets.some((reset) => !Number.isFinite(reset) || reset <= now || reset > now + MAX_RESET_WAIT_MS)) return { kind: "unknown" };
  return { kind: "exhausted", resetsAt: new Date(Math.max(...resets)).toISOString() };
}
