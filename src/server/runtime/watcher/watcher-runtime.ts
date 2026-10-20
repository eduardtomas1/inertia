import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type {
  AgentTurn,
  ProviderInfo,
  RuntimeMutationEvent,
  ServerEvent,
} from "../../../shared/contracts";
import type { WatcherPrivateConnect } from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import type { CheckoutFingerprint, CheckoutFingerprintOptions } from "../../git/checkout-fingerprint";
import type { ProviderHostToolBridge } from "../../provider/contracts";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { RuntimeCommandHandler } from "../commands/command-router";
import type { TurnInteractionCommandDependencies } from "../commands/turn-interaction-commands";
import { createWatcherCommandHandler } from "../commands/watcher-commands";
import type { HiddenProviderInstruction } from "../turns/request-context";
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
import type { WatcherTurnPolicy, WatcherTurnSource } from "./watcher-turn-policy";
import { WatcherWakeRunner } from "./watcher-wake-runner";
import {
  WatcherWakeScheduler,
  type WatcherWakeSchedulerDependencies,
} from "./watcher-wake-scheduler";

export { createWatcherTurnPolicy, type WatcherTurnPolicy } from "./watcher-turn-policy";

/** Watched output is written to the link at most this often; the quiet marker needs no finer grain. */
export const WATCHER_OUTPUT_RECORD_MS = 15_000;
/** Pending-event counts are republished at most this often per link. */
export const WATCHER_PENDING_PUBLISH_MS = 1_000;
export const WATCHER_BUDGET_PAUSE_DETAIL =
  "The watcher used its checks for this turn. It still makes its final check when the turn ends.";

export type WatcherRuntimeTurns = Pick<
  TurnController,
  | "queue" | "start" | "isActive" | "isClosing" | "cancel" | "failBeforeStart"
  | "acquireFollowUpAdmission" | "steer" | "activeConversationIds"
>;

export interface WatcherRuntimeDependencies {
  store: RuntimeStore;
  turns: WatcherRuntimeTurns;
  providers: Pick<TurnProviderRuntime, "resolveModelRoute">;
  backendProfileController: Pick<BackendProfileController, "validateSelection" | "readiness">;
  providerInfo(): readonly ProviderInfo[];
  policy: WatcherTurnPolicy;
  /** Message command dependencies for delivering a note as the watched chat's next turn. */
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
  /** Test-only overrides of the wake scheduler's timing. */
  wakeTiming?: Pick<
    WatcherWakeSchedulerDependencies,
    "settleDelayMs" | "stallTickMs" | "quietAfterMs" | "retryBaseMs" | "retryMaxMs" | "recheckMs"
  >;
}

export interface WatcherRuntime {
  observe(event: RuntimeMutationEvent): void;
  onTurnSettled(turn: AgentTurn): Promise<void>;
  onReadOnlyViolation(turn: AgentTurn, violation: ReadOnlyWatcherViolation): void;
  hostToolsForTurn(input: WatcherTurnSource): ProviderHostToolBridge | null;
  harnessInstructionsFor(input: Pick<WatcherTurnSource, "conversation">): readonly HiddenProviderInstruction[] | null;
  isWatcherConversation(conversationId: string): boolean;
  watcherPolicy: WatcherTurnPolicy;
  /** The Private Connect parent of an attached watcher conversation. */
  watcherParent(conversationId: string): { watchedConversationId: string | null; privateConnect: WatcherPrivateConnect } | null;
  onWatchedArchived(conversationId: string): void;
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

/**
 * Composes the watcher runtime: wake scheduling from the watched chat's
 * events, checks, the checkout guard, live phases, note delivery and the nine
 * watcher commands. The TurnController and the context tool stay
 * watcher-agnostic; they reach this module only through injected hooks.
 */
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
        linkId, ["watching", "idle"], { status: "paused", reason: "wake-budget", detail: WATCHER_BUDGET_PAUSE_DETAIL }, now(),
      );
      if (!paused) return;
      wakeScheduler.pause(linkId, { finalPass: true });
      publish(linkId);
    },
    cooldownMs: (linkId) => (store.watcherLinks.get(linkId)?.budgets.cooldownSeconds ?? 45) * 1_000,
    onError: () => undefined,
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
      resume: (linkId) => wakeScheduler.resume(linkId),
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
      const begun = store.watcherLinks.beginWatchedTurn(linkId, event.turnId, now());
      if (!begun) {
        forget(linkId);
        return;
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
        if (event.type === "conversation.message.persisted" && event.message.role === "user" && event.message.watcherNote) {
          delivery.noteDelivered(event.message.watcherNote, event.message.id);
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
        // Watcher bookkeeping never interrupts the runtime's own broadcast.
      }
    },
    async onTurnSettled(turn) {
      if (disposed) return;
      policy.forgetTurn(turn.id);
      if (await runner.settle(turn)) return;
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
    hostToolsForTurn: (input) => policy.hostToolsForTurn(input),
    harnessInstructionsFor: (input) => policy.harnessInstructionsFor(input),
    isWatcherConversation: (conversationId) => policy.isWatcherConversation(conversationId),
    watcherPolicy: policy,
    watcherParent(conversationId) {
      const link = store.watcherLinks.findByWatcher(conversationId);
      return link && link.status !== "detached"
        ? { watchedConversationId: link.watchedConversationId, privateConnect: link.privateConnect }
        : null;
    },
    onWatchedArchived: (conversationId) => coordinator.onWatchedArchived(conversationId),
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
