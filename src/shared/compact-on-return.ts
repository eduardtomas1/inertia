import type { ContextCompactionTrigger } from "./context-compaction";
import type { HarnessId, ModelBackendProtocol } from "./model-routing";

export const COMPACT_ON_RETURN_TOKEN_THRESHOLD = 200_000;

export const PROMPT_CACHE_LIFETIMES_MS = Object.freeze({
  anthropic5m: 5 * 60_000,
  anthropic1h: 60 * 60_000,
  openai: 30 * 60_000,
});

export const COMPACT_ON_RETURN_SETTINGS = ["offer", "never"] as const;
export type CompactOnReturnSetting = (typeof COMPACT_ON_RETURN_SETTINGS)[number];
export const DEFAULT_COMPACT_ON_RETURN: CompactOnReturnSetting = "offer";

export const PROMPT_CACHE_TTLS = ["5m", "1h"] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];
export const PROMPT_CACHE_TTL_UNAVAILABLE_MESSAGE =
  "Prompt cache length can be set only on Claude Agent SDK backends that use Anthropic Messages.";

export const PROMPT_CACHE_FACT_SOURCES = ["reported", "configured", "assumed"] as const;
export type PromptCacheFactSource = (typeof PROMPT_CACHE_FACT_SOURCES)[number];

export interface PromptCacheFacts {
  lastRequestStartedAt: string | null;
  lifetimeMs: number | null;
  source: PromptCacheFactSource;
}

export const CONVERSATION_COMPACTION_STATES = ["idle", "compacting"] as const;
export type ConversationCompactionStateKind = (typeof CONVERSATION_COMPACTION_STATES)[number];

export interface ConversationCompactionState {
  state: ConversationCompactionStateKind;
  trigger: ContextCompactionTrigger | null;
  startedAt: string | null;
}

export const IDLE_CONVERSATION_COMPACTION: Readonly<ConversationCompactionState> = Object.freeze({
  state: "idle",
  trigger: null,
  startedAt: null,
});

export interface CompactOnReturnRoute {
  harnessId: HarnessId;
  preset: string | null;
  protocol: ModelBackendProtocol | string;
  accountKind?: string | null;
  routeKind?: "account" | "api-key";
  promptCacheTtl?: PromptCacheTtl | null;
}

export interface CompactOnReturnEligibility {
  eligible: boolean;
  lifetimeMs: number | null;
  reason?: string;
}

export interface CompactOnReturnOfferInput {
  eligible: boolean;
  lifetimeMs: number | null;
  usedTokens: number | null;
  lastRequestStartedAt: string | null;
  now: number;
  setting: CompactOnReturnSetting;
  compactionState: ConversationCompactionStateKind;
  turnActive: boolean;
}

export interface CompactOnReturnOffer {
  offer: boolean;
  usedTokens: number | null;
  idleMs: number | null;
}

const API_KEYS_ONLY = "Compact on return is available only for chats on an Anthropic or OpenAI API key.";
const KIMI_EXCLUDED = "Kimi manages its own context, so compact on return is not offered.";
const CUSTOM_EXCLUDED = "Custom gateways do not publish a prompt cache lifetime, so compact on return is not offered.";
const CLAUDE_ACCOUNT_EXCLUDED = "Claude chats are compacted on return only when signed in with a Console API key.";

export function promptCacheTtlAllowed(route: {
  harnessId: HarnessId;
  protocol: ModelBackendProtocol | string;
  preset?: string | null;
}): boolean {
  return route.harnessId === "claude-agent-sdk"
    && route.protocol === "anthropic-messages"
    && route.preset !== "kimi-code";
}

function ineligible(reason: string): CompactOnReturnEligibility {
  return { eligible: false, lifetimeMs: null, reason };
}

function anthropicLifetime(ttl: PromptCacheTtl | null | undefined): CompactOnReturnEligibility {
  return {
    eligible: true,
    lifetimeMs: ttl === "1h" ? PROMPT_CACHE_LIFETIMES_MS.anthropic1h : PROMPT_CACHE_LIFETIMES_MS.anthropic5m,
  };
}

export function compactOnReturnEligibility(route: CompactOnReturnRoute): CompactOnReturnEligibility {
  if (route.preset === "kimi-code") return ineligible(KIMI_EXCLUDED);
  if (route.preset === "custom") return ineligible(CUSTOM_EXCLUDED);
  if (route.harnessId === "claude-agent-sdk" && route.protocol === "anthropic-messages") {
    if (route.preset === "anthropic-api-key") return anthropicLifetime(route.promptCacheTtl);
    const native = route.preset === "native" || (route.preset === null && route.routeKind === "account");
    if (!native) return ineligible(API_KEYS_ONLY);
    return route.accountKind === "Console API key"
      ? anthropicLifetime(route.promptCacheTtl)
      : ineligible(CLAUDE_ACCOUNT_EXCLUDED);
  }
  if (
    route.harnessId === "codex-app-server"
    && route.protocol === "openai-responses"
    && route.preset === "openai-api-key"
  ) {
    return { eligible: true, lifetimeMs: PROMPT_CACHE_LIFETIMES_MS.openai };
  }
  return ineligible(API_KEYS_ONLY);
}

function idleSince(lastRequestStartedAt: string | null, now: number): number | null {
  if (lastRequestStartedAt === null) return null;
  const startedAt = Date.parse(lastRequestStartedAt);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null;
}

export function compactOnReturnOffer(input: CompactOnReturnOfferInput): CompactOnReturnOffer {
  const idleMs = idleSince(input.lastRequestStartedAt, input.now);
  const offer = input.setting === "offer"
    && input.eligible
    && input.lifetimeMs !== null
    && input.usedTokens !== null
    && input.usedTokens >= COMPACT_ON_RETURN_TOKEN_THRESHOLD
    && !input.turnActive
    && input.compactionState === "idle"
    && idleMs !== null
    && idleMs >= input.lifetimeMs;
  return { offer, usedTokens: input.usedTokens, idleMs };
}
