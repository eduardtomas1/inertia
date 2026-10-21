import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type {
  AgentTurn,
  ProviderInfo,
  RuntimeMutationEvent,
  ServerEvent,
} from "../../../shared/contracts";
import { WATCHER_BUDGET_LIMITS, type WatcherPrivateConnect } from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import type { CheckoutFingerprint, CheckoutFingerprintOptions } from "../../git/checkout-fingerprint";
import type { WatcherTurnDiffSnapshot } from "../../persistence/watcher-digest-source";
import type { WatcherLinkRecord } from "../../persistence/watcher-link-repository";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { RuntimeCommandHandler } from "../commands/command-router";
import type { TurnInteractionCommandDependencies } from "../commands/turn-interaction-commands";
import { RuntimeRequestError } from "../../runtime-errors";
import { createWatcherCommandHandler } from "../commands/watcher-commands";
import type { TurnController } from "../turns/turn-controller";
import { defaultTurnScheduler } from "../turns/turn-controller-support";
import type {
  ReadOnlyWatcherViolation,
  TurnProviderRuntime,
  TurnTimerScheduler,
} from "../turns/turn-controller-types";
import { WatcherCheckoutGuard } from "./watcher-checkout-guard";
import { WatcherDeliveryService, type WatcherNoteQueue } from "./watcher-delivery";
import { WatcherLinkCoordinator, WatcherLinkIndex } from "./watcher-link-coordinator";
import { WatcherLiveProjection } from "./watcher-live-projection";
import { watcherRouteReadiness } from "./watcher-route";
import type { WatcherTurnPolicy } from "./watcher-turn-policy";
import { WatcherWakeRunner } from "./watcher-wake-runner";
import {
  WatcherWakeScheduler,
  type WatcherWakeSchedulerDependencies,
} from "./watcher-wake-scheduler";

const WATCHER_OUTPUT_RECORD_MS = 15_000;
export const WATCHER_PENDING_PUBLISH_MS = 1_000;
const WATCHER_DELETE_REFUSAL = "The watcher is still working. Wait for it to finish or choose Stop watching…, then delete this chat.";
const WATCHER_BUDGET_PAUSE_DETAIL =
  "The watcher used its checks for this turn. It still makes the final check, and resumes when the next turn starts or when you choose Resume.";

type WatcherRuntimeTurns = Pick<
  TurnController,
  | "queue" | "start" | "isActive" | "isClosing" | "cancel" | "failBeforeStart"
  | "acquireFollowUpAdmission" | "steer" | "activeConversationIds"
>;

interface WatcherRuntimeDependencies {
  store: RuntimeStore;
  turns: WatcherRuntimeTurns;
  providers: Pick<TurnProviderRuntime, "resolveModelRoute">;
  backendProfileController: Pick<BackendProfileController, "validateSelection" | "readiness">;
  providerInfo(): readonly ProviderInfo[];
  policy: WatcherTurnPolicy;
  interaction?: TurnInteractionCommandDependencies;
  queuedMessages?: WatcherNoteQueue;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  broadcastConversationShell?(conversationId: string): void;
  send(socket: WebSocket, event: ServerEvent): void;
  scheduler?: TurnTimerScheduler;
  clock?: () => number;
  id?: () => string;
  captureFingerprint?: (path: string, options: CheckoutFingerprintOptions) => Promise<CheckoutFingerprint>;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  turnDiff?(turnId: string): Promise<WatcherTurnDiffSnapshot>;
  wakeTiming?: Pick<
    WatcherWakeSchedulerDependencies,
    "settleDelayMs" | "stallTickMs" | "quietAfterMs" | "retryBaseMs" | "retryMaxMs" | "recheckMs"
  >;
}

export interface WatcherRuntime {
  observe(event: RuntimeMutationEvent): void;
  onTurnSettled(turn: AgentTurn): Promise<void>;
  onReadOnlyViolation(turn: AgentTurn, violation: ReadOnlyWatcherViolation): void;
  isWatcherConversation(conversationId: string): boolean;
  watcherParent(conversationId: string): { watchedConversationId: string | null; privateConnect: WatcherPrivateConnect } | null;
  onConversationArchived(conversationId: string): void;
  assertConversationDeletable(conversationId: string): void;
  beforeConversationDelete(conversationId: string): () => void;
  beforeProjectRemove(projectId: string): () => void;
  handler: RuntimeCommandHandler;
  coordinator: WatcherLinkCoordinator;
  delivery: WatcherDeliveryService;
  resume(): void;
  dispose(): void;
}

function eventConversationId(event: RuntimeMutationEvent): string | null {
  switch (event.type) {
    case "agent.started":
    case "agent.text":
    case "agent.text.replaced":
    case "agent.reasoning":
      return event.conversationId;
    case "agent.commentary.persisted":
      return event.message.conversationId;
    case "agent.activity":
      return event.activity.conversationId;
    case "agent.plan.updated":
      return event.plan.conversationId;
    case "agent.subagent.updated":
      return event.trace.conversationId;
    default:
      return null;
  }
}

export function createWatcherRuntime(dependencies: WatcherRuntimeDependencies): WatcherRuntime {
  const { store, turns, policy } = dependencies;
  const timers = dependencies.scheduler ?? defaultTurnScheduler();
  const clock = dependencies.clock ?? Date.now;
  const now = (): string => new Date(clock()).toISOString();
  const id = dependencies.id ?? randomUUID;
  const index = new WatcherLinkIndex();
  const outputRecordedAt = new Map<string, number>();
  const quietLinks = new Set<string>();
  const pendingPublish = new Map<string, unknown>();
  let disposed = false;
  const route = (selection: Parameters<typeof watcherRouteReadiness>[1]) => watcherRouteReadiness({
    backendProfiles: dependencies.backendProfileController,
    providers: dependencies.providers,
    providerInfo: dependencies.providerInfo,
  }, selection);

  const guard = new WatcherCheckoutGuard({
    store,
    turns,
    clock,
    ...(dependencies.captureFingerprint ? { capture: dependencies.captureFingerprint } : {}),
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    ...(dependencies.platform ? { platform: dependencies.platform } : {}),
  });
  const live = new WatcherLiveProjection({ scheduler: timers, clock, broadcast: (event) => dependencies.broadcast(event) });
  let coordinator: WatcherLinkCoordinator;
  const publish = (linkId: string): void => {
    if (!disposed) coordinator.publish(linkId);
  };
  const runner = new WatcherWakeRunner({
    store,
    turns,
    route,
    guard,
    live,
    scheduler: () => wakeScheduler,
    publish,
    refreshConversation: (conversationId) => dependencies.broadcastConversationShell?.(conversationId),
    detailChanged: (conversationId) => dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId }),
    ...(dependencies.turnDiff ? { turnDiff: dependencies.turnDiff } : {}),
    delivery: () => delivery,
    now,
    id,
  });
  const remaining = (linkId: string): number => {
    const link = store.watcherLinks.get(linkId);
    return link ? link.counters.wakeAllowance - link.counters.wakesThisTurn : 0;
  };
  const wakeScheduler: WatcherWakeScheduler = new WatcherWakeScheduler({
    scheduler: timers,
    clock,
    ...dependencies.wakeTiming,
    onWake: async (linkId, trigger, context) => {
      const attempt = await runner.run(linkId, trigger, context);
      if (attempt === "skipped") {
        const link = store.watcherLinks.get(linkId);
        if (!link || link.status === "detached") forget(linkId);
      }
      return attempt;
    },
    onQuiet: (linkId) => {
      if (!store.watcherLinks.markQuiet(linkId, now())) return;
      quietLinks.add(linkId);
      publish(linkId);
    },
    isBusy: (linkId) => runner.isRunning(linkId) || store.watcherLinks.get(linkId)?.status === "waking",
    allowance: remaining,
    onBudgetExhausted: (linkId) => {
      const paused = store.watcherLinks.transition(
        linkId, ["watching"], { status: "paused", reason: "wake-budget", detail: WATCHER_BUDGET_PAUSE_DETAIL }, now(),
      );
      if (!paused) return;
      wakeScheduler.pause(linkId, { finalPass: true });
      publish(linkId);
    },
    onPendingChanged: (linkId) => {
      if (store.watcherLinks.notePendingEvents(linkId, wakeScheduler.pendingEvents(linkId), now())) publish(linkId);
    },
    cooldownMs: (linkId) => (store.watcherLinks.get(linkId)?.budgets.cooldownSeconds ?? WATCHER_BUDGET_LIMITS.cooldownSeconds.default) * 1_000,
  });
  const forget = (linkId: string): void => {
    wakeScheduler.forget(linkId);
    runner.forget(linkId);
    live.end(linkId);
    index.untrack(linkId);
    outputRecordedAt.delete(linkId);
    quietLinks.delete(linkId);
    const timer = pendingPublish.get(linkId);
    if (timer !== undefined) timers.clearTimeout(timer);
    pendingPublish.delete(linkId);
  };
  coordinator = new WatcherLinkCoordinator({
    store,
    turns,
    route,
    scheduler: {
      track: (linkId, options) => {
        wakeScheduler.track(linkId, options);
        const watcherId = store.watcherLinks.get(linkId)?.watcherConversationId;
        if (watcherId) wakeScheduler.deferWhile(linkId, () => turns.isActive(watcherId));
      },
      requestWake: (linkId, trigger) => wakeScheduler.requestWake(linkId, trigger),
      pause: (linkId, options) => wakeScheduler.pause(linkId, options),
      resume: (linkId) => {
        runner.resumed(linkId);
        wakeScheduler.resume(linkId);
      },
      forget: (linkId) => wakeScheduler.forget(linkId),
      onWatchedTurnSettled: (linkId, turnId) => wakeScheduler.onWatchedTurnSettled(linkId, turnId),
    },
    forgetLink: forget,
    index,
    broadcast: (event) => dependencies.broadcast(event),
    broadcastSnapshot: () => dependencies.broadcastSnapshot(),
    now,
  });
  const delivery = new WatcherDeliveryService({
    store,
    turns,
    interaction: () => dependencies.interaction,
    queue: () => dependencies.queuedMessages,
    providerLabels: () => Object.fromEntries(dependencies.providerInfo().map(({ id, label }) => [id, label])),
    now,
    changed: publish,
  });

  const schedulePendingPublish = (linkId: string): void => {
    if (pendingPublish.has(linkId)) return;
    pendingPublish.set(linkId, timers.setTimeout(() => {
      pendingPublish.delete(linkId);
      if (disposed) return;
      if (store.watcherLinks.notePendingEvents(linkId, wakeScheduler.pendingEvents(linkId), now())) publish(linkId);
    }, WATCHER_PENDING_PUBLISH_MS));
  };

  const observeWatched = (linkId: string, event: RuntimeMutationEvent): void => {
    if (event.type === "agent.started") {
      const prior = store.watcherLinks.get(linkId);
      if (prior) runner.watchedTurnChanging(prior, event.turnId);
      const begun = store.watcherLinks.beginWatchedTurn(linkId, event.turnId, now());
      if (!begun) {
        forget(linkId);
        return;
      }
      if (prior?.status === "paused" && prior.pauseReason === "wake-budget" && begun.status === "watching") {
        runner.resumed(linkId);
        wakeScheduler.resume(linkId);
      }
      publish(linkId);
    }
    const at = clock();
    const wasQuiet = quietLinks.delete(linkId);
    if (wasQuiet || at - (outputRecordedAt.get(linkId) ?? Number.NEGATIVE_INFINITY) >= WATCHER_OUTPUT_RECORD_MS) {
      outputRecordedAt.set(linkId, at);
      store.watcherLinks.recordWatchedOutput(linkId, new Date(at).toISOString());
      if (wasQuiet) publish(linkId);
    }
    if (wakeScheduler.observe(linkId, event)) schedulePendingPublish(linkId);
  };

  const publishRemoved = (links: readonly WatcherLinkRecord[]) => (): void => {
    if (disposed) return;
    for (const link of links) {
      forget(link.id);
      coordinator.publish(link.id, link);
    }
  };

  const handler = createWatcherCommandHandler({ coordinator, delivery, send: dependencies.send });
  for (const link of store.watcherLinks.active()) {
    index.track(link);
    if (link.quietSince !== null) quietLinks.add(link.id);
  }

  return {
    observe(event) {
      if (disposed || event.type.startsWith("watcher.")) return;
      try {
        guard.observe(event);
        if (event.type === "conversation.shell.updated") {
          const { id, archivedAt } = event.conversation;
          if (archivedAt !== null && (index.forWatched(id) !== null || index.forWatcher(id) !== null)) {
            coordinator.onConversationArchived(id);
          }
          return;
        }
        if (event.type === "conversation.message.persisted" && event.message.role === "user" && event.message.watcherNote) {
          delivery.noteDelivered(event.message.watcherNote, event.message);
          return;
        }
        const conversationId = eventConversationId(event);
        if (conversationId === null) return;
        const watcherLink = index.forWatcher(conversationId);
        if (watcherLink !== null) {
          if (event.type === "agent.activity") live.observe(watcherLink, event.activity);
          return;
        }
        const watchedLink = index.forWatched(conversationId);
        if (watchedLink !== null) observeWatched(watchedLink, event);
      } catch {
      }
    },
    async onTurnSettled(turn) {
      if (disposed) return;
      policy.forgetTurn(turn.id);
      let settledCheck: boolean;
      try {
        settledCheck = await runner.settle(turn);
      } catch {
        return;
      }
      if (settledCheck) return;
      const watcherLink = index.forWatcher(turn.conversationId);
      if (watcherLink !== null) {
        wakeScheduler.poke(watcherLink);
        return;
      }
      const watchedLink = index.forWatched(turn.conversationId);
      if (watchedLink !== null) wakeScheduler.onWatchedTurnSettled(watchedLink, turn.id);
    },
    onReadOnlyViolation(turn, violation) {
      if (!disposed) runner.onViolation(turn, violation);
    },
    isWatcherConversation: (conversationId) => policy.isWatcherConversation(conversationId),
    watcherParent(conversationId) {
      if (disposed || index.forWatcher(conversationId) === null) return null;
      return store.watcherLinks.parentForWatcher(conversationId);
    },
    onConversationArchived: (conversationId) => coordinator.onConversationArchived(conversationId),
    assertConversationDeletable(conversationId) {
      const link = store.watcherLinks.findActiveByWatched(conversationId);
      if (!link) return;
      if (turns.isActive(link.watcherConversationId) || store.watcherLinks.watcherTurnActiveFor(conversationId)) {
        throw new RuntimeRequestError(WATCHER_DELETE_REFUSAL);
      }
    },
    beforeConversationDelete(conversationId) {
      const links = (disposed ? [] : coordinator.linksTouching(conversationId)).flatMap((linkId) => {
        const link = store.watcherLinks.get(linkId);
        return link ? [link] : [];
      });
      return publishRemoved(links);
    },
    beforeProjectRemove(projectId) {
      return publishRemoved(disposed ? [] : store.watcherLinks.active().filter((link) => link.projectId === projectId));
    },
    handler,
    coordinator,
    delivery,
    resume() {
      if (!disposed) coordinator.reconcileAfterReady();
    },
    dispose() {
      disposed = true;
      wakeScheduler.dispose();
      live.dispose();
      guard.dispose();
      runner.dispose();
      for (const timer of pendingPublish.values()) timers.clearTimeout(timer);
      pendingPublish.clear();
      index.clear();
    },
  };
}
