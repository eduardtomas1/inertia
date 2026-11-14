import {
  COMPACT_ON_RETURN_TOKEN_THRESHOLD,
  compactOnReturnEligibility,
  IDLE_COMPACTION_LEAD_MS,
  IDLE_COMPACTION_SAFETY_MS,
  idleCompactionWindow,
  PROMPT_CACHE_LIFETIMES_MS,
  promptCacheLifetimeFor,
  type CompactOnReturnRoute,
  type CompactOnReturnSetting,
} from "../../shared/compact-on-return";
import type { IdleCompactionCandidate } from "../persistence/idle-compaction-candidate-repository";
import {
  compactIdleConversation,
  compactionRouteForConversation,
  type ConversationCompactionCommandDependencies,
  type IdleCompactionExpectation,
} from "./commands/conversation-compaction-commands";

export const IDLE_COMPACTION_SWEEP_MS = 60_000;
export const MAX_CONCURRENT_IDLE_COMPACTIONS = 3;
const MAX_REMEMBERED_ATTEMPTS = 256;

export interface IdleCompactionSchedulerDependencies {
  settings(): { compactOnReturn: CompactOnReturnSetting; compactBeforeCacheExpires: boolean };
  candidates(input: { startedSince: string; startedBefore: string; minimumTokens: number }): readonly IdleCompactionCandidate[];
  route(conversationId: string): CompactOnReturnRoute | null;
  busyConversations(): (conversationId: string) => boolean;
  compact(conversationId: string, expected: IdleCompactionExpectation): Promise<unknown>;
  now(): number;
  onFailure?(conversationId: string, error: unknown): void;
}

export interface IdleCompactionScheduler {
  start(): void;
  stop(): void;
  sweep(): number;
  settled(): Promise<void>;
}

export function createIdleCompactionScheduler(
  dependencies: IdleCompactionSchedulerDependencies,
  intervalMs = IDLE_COMPACTION_SWEEP_MS,
): IdleCompactionScheduler {
  const attempted = new Map<string, string>();
  const running = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const remember = (conversationId: string, startedAt: string): void => {
    attempted.delete(conversationId);
    attempted.set(conversationId, startedAt);
    while (attempted.size > MAX_REMEMBERED_ATTEMPTS) {
      const oldest = attempted.keys().next().value;
      if (oldest === undefined) break;
      attempted.delete(oldest);
    }
  };

  const sweep = (): number => {
    const settings = dependencies.settings();
    if (!settings.compactBeforeCacheExpires || settings.compactOnReturn === "never") return 0;
    const now = dependencies.now();
    const candidates = dependencies.candidates({
      startedSince: new Date(now - PROMPT_CACHE_LIFETIMES_MS.anthropic1h + IDLE_COMPACTION_SAFETY_MS).toISOString(),
      startedBefore: new Date(now - PROMPT_CACHE_LIFETIMES_MS.anthropic1h + IDLE_COMPACTION_LEAD_MS).toISOString(),
      minimumTokens: COMPACT_ON_RETURN_TOKEN_THRESHOLD,
    });
    const busy = dependencies.busyConversations();
    let started = 0;
    for (const candidate of candidates) {
      if (running.size >= MAX_CONCURRENT_IDLE_COMPACTIONS) break;
      const { conversationId } = candidate;
      const startedAt = candidate.promptCache.lastRequestStartedAt;
      if (startedAt === null || running.has(conversationId) || attempted.get(conversationId) === startedAt) continue;
      if (busy(conversationId)) continue;
      const route = dependencies.route(conversationId);
      if (!route) continue;
      const eligibility = compactOnReturnEligibility(route);
      const window = idleCompactionWindow({
        enabled: settings.compactBeforeCacheExpires,
        setting: settings.compactOnReturn,
        harnessId: route.harnessId,
        eligible: eligibility.eligible,
        lifetimeMs: promptCacheLifetimeFor(candidate.promptCache, eligibility),
        usedTokens: candidate.usedTokens,
        lastRequestStartedAt: startedAt,
        now,
      });
      if (!window || now < window.opensAt) continue;
      remember(conversationId, startedAt);
      started += 1;
      const operation = Promise.resolve()
        .then(() => dependencies.compact(conversationId, {
          lastRequestStartedAt: startedAt,
          closesAt: window.closesAt,
          now: dependencies.now,
        }))
        .then(() => undefined, (error: unknown) => {
          dependencies.onFailure?.(conversationId, error);
        })
        .finally(() => {
          running.delete(conversationId);
        });
      running.set(conversationId, operation);
    }
    return started;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          sweep();
        } catch (error) {
          dependencies.onFailure?.("", error);
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    sweep,
    settled: async () => {
      await Promise.all(running.values());
    },
  };
}

export function startIdleCompaction(
  dependencies: ConversationCompactionCommandDependencies,
  runtime: {
    signal: AbortSignal;
    track<T>(operation: () => Promise<T>): Promise<T>;
    onFailure?(conversationId: string, error: unknown): void;
    intervalMs?: number;
  },
): IdleCompactionScheduler {
  const scheduler = createIdleCompactionScheduler({
    settings: () => dependencies.store.settings(),
    candidates: (input) => dependencies.store.idleCompactionCandidates.candidates(input),
    route: (conversationId) => compactionRouteForConversation(dependencies, conversationId),
    busyConversations: () => {
      const queued = new Set(dependencies.store.queuedMessages.pendingConversationIds());
      return (conversationId) => queued.has(conversationId)
        || dependencies.turns.isActive(conversationId)
        || dependencies.isolatedRuns.has(conversationId)
        || dependencies.providerTerminalResumes.isActive(conversationId)
        || dependencies.compactions?.isCompacting(conversationId) === true;
    },
    compact: (conversationId, expected) => runtime.track(() => compactIdleConversation(dependencies, conversationId, expected)),
    now: () => Date.now(),
    ...(runtime.onFailure ? { onFailure: runtime.onFailure } : {}),
  }, runtime.intervalMs);
  if (!dependencies.enableProviders || runtime.signal.aborted) return scheduler;
  scheduler.start();
  runtime.signal.addEventListener("abort", () => scheduler.stop(), { once: true });
  return scheduler;
}
