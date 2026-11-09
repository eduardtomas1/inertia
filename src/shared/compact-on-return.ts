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

export const DEFAULT_COMPACT_BEFORE_CACHE_EXPIRES = false;
export const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;
export const IDLE_COMPACTION_SAFETY_MS = 30_000;
export const IDLE_COMPACTION_MIN_LIFETIME_MS = PROMPT_CACHE_LIFETIMES_MS.anthropic1h;

export const AUTO_COMPACT_TOKENS_MIN = 100_000;
export const AUTO_COMPACT_TOKENS_MAX = 1_000_000;
export const CLAUDE_AUTO_COMPACT_WINDOWS = [200_000, 300_000, 400_000, 600_000] as const;
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 400_000;

export const CODEX_AUTO_COMPACT_LIMITS = [200_000, 300_000, 400_000] as const;
export const DEFAULT_CODEX_AUTO_COMPACT_LIMIT = 300_000;
export const CODEX_AUTO_COMPACT_WINDOW_SHARE = 0.9;

export function codexAutoCompactTokenLimit(setting: number | null, contextWindow: number | null): number | null {
  if (setting === null || contextWindow === null || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
  const limit = Math.min(setting, Math.floor(contextWindow * CODEX_AUTO_COMPACT_WINDOW_SHARE));
  return limit >= AUTO_COMPACT_TOKENS_MIN ? limit : null;
}

export function validAutoCompactTokenCount(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= AUTO_COMPACT_TOKENS_MIN
      && value <= AUTO_COMPACT_TOKENS_MAX);
}

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

const API_KEYS_ONLY = "Compact on return is available only on Claude Code's own sign-in, an Anthropic API key or an OpenAI API key.";
const KIMI_EXCLUDED = "Kimi manages its own context, so compact on return is not offered.";
const CUSTOM_EXCLUDED = "Custom gateways do not publish a prompt cache lifetime, so compact on return is not offered.";
const CLAUDE_SIGN_IN_UNKNOWN = "Inertia could not confirm how Claude is signed in, so compact on return is not offered.";

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
    if (route.accountKind === "Console API key") return anthropicLifetime(route.promptCacheTtl);
    if (route.accountKind === "Claude account") {
      return route.promptCacheTtl
        ? anthropicLifetime(route.promptCacheTtl)
        : { eligible: true, lifetimeMs: PROMPT_CACHE_LIFETIMES_MS.anthropic1h };
    }
    return ineligible(CLAUDE_SIGN_IN_UNKNOWN);
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

export interface IdleCompactionWindowInput {
  enabled: boolean;
  setting: CompactOnReturnSetting;
  harnessId: HarnessId;
  eligible: boolean;
  lifetimeMs: number | null;
  usedTokens: number | null;
  lastRequestStartedAt: string | null;
  now: number;
}

export interface IdleCompactionWindow {
  opensAt: number;
  closesAt: number;
}

export function idleCompactionWindow(input: IdleCompactionWindowInput): IdleCompactionWindow | null {
  if (!input.enabled || input.setting !== "offer" || !input.eligible) return null;
  if (input.harnessId !== "claude-agent-sdk") return null;
  if (input.lifetimeMs === null || input.lifetimeMs < IDLE_COMPACTION_MIN_LIFETIME_MS) return null;
  if (input.usedTokens === null || input.usedTokens < COMPACT_ON_RETURN_TOKEN_THRESHOLD) return null;
  if (input.lastRequestStartedAt === null) return null;
  const startedAt = Date.parse(input.lastRequestStartedAt);
  if (!Number.isFinite(startedAt)) return null;
  const expiresAt = startedAt + input.lifetimeMs;
  const window = { opensAt: expiresAt - IDLE_COMPACTION_LEAD_MS, closesAt: expiresAt - IDLE_COMPACTION_SAFETY_MS };
  return input.now < window.closesAt ? window : null;
}

export function promptCacheLifetimeFor(
  facts: Pick<PromptCacheFacts, "lifetimeMs" | "source"> | null | undefined,
  eligibility: Pick<CompactOnReturnEligibility, "lifetimeMs"> | null | undefined,
): number | null {
  if (facts && facts.source !== "assumed" && facts.lifetimeMs !== null) return facts.lifetimeMs;
  return eligibility?.lifetimeMs ?? facts?.lifetimeMs ?? null;
}
