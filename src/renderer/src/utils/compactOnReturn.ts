import type {
  AppSnapshot,
  ConversationLatestTurnSummary,
  ModelBackendProfileView,
  ModelSelection,
  ProviderInfo,
} from "@shared/contracts";
import type {
  CompactOnReturnRoute,
  ConversationCompactionState,
  PromptCacheFacts,
} from "@shared/compact-on-return";
import { providerIdForHarness, providerNativeBackendProfile } from "../../../shared/model-routing";
import { backendRouteKind } from "./backendRouteState";
import { compactTokenCount } from "./usageDisplay";

const MINUTE_MS = 60_000;

export function compactOnReturnRoute(input: {
  selection: Pick<ModelSelection, "harnessId" | "backendProfileId">;
  profile: Pick<ModelBackendProfileView, "id" | "preset" | "harnessId" | "protocol" | "authenticationMode" | "routeKind" | "promptCacheTtl"> | undefined;
  provider: Pick<ProviderInfo, "accountKind"> | undefined;
}): CompactOnReturnRoute | null {
  const { selection, profile, provider } = input;
  const providerId = providerIdForHarness(selection.harnessId);
  const native = providerId ? providerNativeBackendProfile(providerId) : null;
  if (native && selection.backendProfileId === native.id && (!profile || profile.preset === "native")) {
    return {
      harnessId: selection.harnessId,
      preset: "native",
      protocol: profile?.protocol ?? native.protocol,
      accountKind: provider?.accountKind ?? null,
      routeKind: "account",
      promptCacheTtl: profile?.promptCacheTtl ?? null,
    };
  }
  if (!profile || profile.id !== selection.backendProfileId) return null;
  return {
    harnessId: profile.harnessId,
    preset: profile.preset,
    protocol: profile.protocol,
    accountKind: provider?.accountKind ?? null,
    routeKind: backendRouteKind(profile),
    promptCacheTtl: profile.promptCacheTtl ?? null,
  };
}

export function compactOnReturnTooltip(usedTokens: number): string {
  return `Summarize ${compactTokenCount(usedTokens)} tokens of history, then send`;
}

function durationText(ms: number, round: (value: number) => number): string {
  const minutes = Math.max(1, round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

export function promptCacheStatus(
  facts: Pick<PromptCacheFacts, "lastRequestStartedAt" | "lifetimeMs">,
  now: number,
): string | null {
  if (facts.lastRequestStartedAt === null || facts.lifetimeMs === null) return null;
  const startedAt = Date.parse(facts.lastRequestStartedAt);
  if (!Number.isFinite(startedAt)) return null;
  const remaining = startedAt + facts.lifetimeMs - now;
  if (remaining > 0) return `Cache warm, expires in ${durationText(remaining, Math.ceil)}`;
  if (-remaining < MINUTE_MS) return "Cache expired just now";
  return `Cache expired ${durationText(-remaining, Math.floor)} ago`;
}

export function compactOnReturnChatState(
  snapshot: Pick<AppSnapshot, "conversations" | "watchers"> | null | undefined,
  conversationId: string | null | undefined,
): { compaction: ConversationCompactionState | null; watcherChat: boolean } {
  if (!snapshot || !conversationId) return { compaction: null, watcherChat: false };
  const shell = snapshot.conversations.find(({ id }) => id === conversationId);
  return {
    compaction: shell?.compaction ?? null,
    watcherChat: snapshot.watchers?.some((link) => link.watcherConversationId === conversationId) ?? false,
  };
}

const REFUSED_FAILURE_KINDS: ReadonlySet<string> = new Set(["billing", "authentication", "rate-limited"]);

export function compactOnReturnRefusedAfter(
  turn: Pick<ConversationLatestTurnSummary, "status" | "usageLimited" | "failureKind"> | null,
): boolean {
  return turn?.usageLimited === true
    || (turn?.status === "failed" && turn.failureKind !== undefined && REFUSED_FAILURE_KINDS.has(turn.failureKind));
}
