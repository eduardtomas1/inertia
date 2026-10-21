import { resolve } from "node:path";

import { clipCodeUnits } from "../../../shared/code-units";
import type { ModelSelection, RuntimeMutationEvent } from "../../../shared/contracts";
import type { WatcherAttachPayload, WatcherUpdatePayload } from "../../../shared/contracts/client-command/watcher";
import { isAgentTurnTerminalStatus } from "../../../shared/turn-lifecycle";
import {
  MAX_ACTIVE_WATCHERS,
  MAX_WATCHER_COMMANDS_RUN,
  WATCHER_PRESET_LABELS,
  watcherFlattenLine,
  watcherLinkViewSchema,
  type WatcherFeedItem,
  type WatcherLinkView,
  type WatcherPauseReason,
  type WatcherStatus,
  type WatcherUsage,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import { watcherLinkDetailView, watcherLinkView } from "../../persistence/watcher-link-codecs";
import {
  WATCHER_ARCHIVED_REFUSAL,
  WATCHER_LIMIT_REFUSAL,
  WATCHER_OF_WATCHER_REFUSAL,
  WatcherPolicyError,
  type WatcherFeedPage,
  type WatcherLinkRecord,
  type WatcherTransition,
} from "../../persistence/watcher-link-repository";
import { normalizeIdentityPath } from "../../project-identity";
import { RuntimeRequestError } from "../../runtime-errors";
import type { TurnController } from "../turns/turn-controller";
import type { WatcherRouteReadiness } from "./watcher-route";
import type { WatcherWakeScheduler } from "./watcher-wake-scheduler";

const MAX_WATCHER_CHAT_TITLE_CHARS = 120;
const WATCHER_CHAT_ARCHIVED_DETAIL = "The watcher chat was archived. Unarchive it to resume the watcher.";
const ATTACHED: readonly WatcherStatus[] = ["watching", "waking", "paused"];
const ARCHIVE_PAUSES: readonly WatcherPauseReason[] = ["watched-archived", "watcher-archived"];

export interface WatcherFeedResult {
  kind: "watcher.feed";
  linkId: string;
  feedRevision: number;
  items: WatcherFeedItem[];
  next: WatcherFeedPage["next"];
  usage?: WatcherUsage;
}

export function conversationOrNull(
  store: Pick<RuntimeStore, "conversation">,
  conversationId: string,
): ReturnType<RuntimeStore["conversation"]> | null {
  try {
    return store.conversation(conversationId);
  } catch {
    return null;
  }
}

export class WatcherLinkIndex {
  readonly #byWatched = new Map<string, string>();
  readonly #byWatcher = new Map<string, string>();
  readonly #links = new Map<string, { watched: string | null; watcher: string }>();

  track(link: Pick<WatcherLinkRecord, "id" | "watchedConversationId" | "watcherConversationId" | "status">): void {
    this.untrack(link.id);
    if (link.status === "detached") return;
    this.#links.set(link.id, { watched: link.watchedConversationId, watcher: link.watcherConversationId });
    if (link.watchedConversationId) this.#byWatched.set(link.watchedConversationId, link.id);
    this.#byWatcher.set(link.watcherConversationId, link.id);
  }

  untrack(linkId: string): void {
    const known = this.#links.get(linkId);
    if (!known) return;
    this.#links.delete(linkId);
    if (known.watched && this.#byWatched.get(known.watched) === linkId) this.#byWatched.delete(known.watched);
    if (this.#byWatcher.get(known.watcher) === linkId) this.#byWatcher.delete(known.watcher);
  }

  forWatched(conversationId: string): string | null {
    return this.#byWatched.get(conversationId) ?? null;
  }

  forWatcher(conversationId: string): string | null {
    return this.#byWatcher.get(conversationId) ?? null;
  }

  clear(): void {
    this.#byWatched.clear();
    this.#byWatcher.clear();
    this.#links.clear();
  }
}

type WatcherLinkSides = Pick<WatcherLinkRecord, "watcherConversationId" | "watchedConversationId">;

interface WatcherLinkCoordinatorDependencies {
  store: RuntimeStore;
  turns: Pick<TurnController, "isActive" | "cancel">;
  route(selection: ModelSelection): Promise<WatcherRouteReadiness>;
  scheduler: Pick<
    WatcherWakeScheduler,
    "track" | "requestWake" | "pause" | "resume" | "forget" | "onWatchedTurnSettled"
  >;
  forgetLink(linkId: string): void;
  index: WatcherLinkIndex;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  now(): string;
}

function clipTitle(value: string): string {
  const flattened = watcherFlattenLine(value);
  if (flattened.length <= MAX_WATCHER_CHAT_TITLE_CHARS) return flattened;
  return `${clipCodeUnits(flattened, MAX_WATCHER_CHAT_TITLE_CHARS - 1).trimEnd()}…`;
}

function watcherConversationTitle(preset: WatcherAttachPayload["preset"], watchedTitle: string): string {
  return clipTitle(`Watcher · ${WATCHER_PRESET_LABELS[preset]} · ${watchedTitle.trim() || "Untitled chat"}`);
}

function policyError(error: unknown): unknown {
  return error instanceof WatcherPolicyError ? new RuntimeRequestError(error.message) : error;
}

export class WatcherLinkCoordinator {
  readonly #deps: WatcherLinkCoordinatorDependencies;

  constructor(dependencies: WatcherLinkCoordinatorDependencies) {
    this.#deps = dependencies;
  }

  publish(linkId: string, sides?: WatcherLinkSides): WatcherLinkRecord | null {
    const link = this.#deps.store.watcherLinks.get(linkId);
    if (!link || link.status === "detached") {
      this.#deps.index.untrack(linkId);
      const known = sides ?? link;
      this.#deps.broadcast(known
        ? {
            type: "watcher.link.removed",
            linkId,
            watcherConversationId: known.watcherConversationId,
            watchedConversationId: known.watchedConversationId,
          }
        : { type: "watcher.link.removed", linkId });
      return link;
    }
    const view = watcherLinkView(link);
    if (watcherLinkViewSchema.safeParse(view).success) {
      this.#deps.broadcast({ type: "watcher.link.updated", link: view });
    }
    return link;
  }

  #detail(link: WatcherLinkRecord): WatcherLinkView {
    return watcherLinkDetailView(link, this.#deps.store.watcherLinks.usageTotals(link.id));
  }

  async attach(payload: WatcherAttachPayload): Promise<WatcherLinkView> {
    const { store } = this.#deps;
    const existing = store.watcherLinks.get(payload.linkId);
    if (existing) {
      if (existing.watchedConversationId === payload.watchedConversationId && existing.status !== "detached") {
        return this.#detail(existing);
      }
      throw new RuntimeRequestError("This watcher already exists.");
    }
    const watched = conversationOrNull(store, payload.watchedConversationId);
    if (!watched) throw new RuntimeRequestError("The chat to watch no longer exists.");
    if (store.project(watched.projectId).workspaceKind === "scratch") {
      throw new RuntimeRequestError("Chats without a project can't be watched.");
    }
    if (watched.archivedAt !== null) throw new RuntimeRequestError(WATCHER_ARCHIVED_REFUSAL);
    const watchedPolicy = store.watcherLinks.policyForConversation(watched.id);
    if (watchedPolicy && watchedPolicy.status !== "detached") {
      throw new RuntimeRequestError(WATCHER_OF_WATCHER_REFUSAL);
    }
    if (store.watcherLinks.findActiveByWatched(watched.id)) throw new RuntimeRequestError("This chat already has a watcher.");
    if (store.watcherLinks.active().length >= MAX_ACTIVE_WATCHERS) {
      throw new RuntimeRequestError(WATCHER_LIMIT_REFUSAL);
    }
    const route = await this.#deps.route(payload.modelSelection);
    if (!route.ready) throw new RuntimeRequestError(route.message);
    if (watched.worktreePath !== null) {
      let actual: string;
      try {
        actual = store.conversationPath(watched.id);
      } catch {
        throw new RuntimeRequestError("The main chat's worktree is unavailable, so a watcher can't share it.");
      }
      if (normalizeIdentityPath(resolve(watched.worktreePath)) !== normalizeIdentityPath(resolve(actual))) {
        throw new RuntimeRequestError("The main chat's worktree is not the checkout it records.");
      }
    }
    const current = store.conversation(watched.id);
    let created: ReturnType<RuntimeStore["watcherLinks"]["createWithConversation"]>;
    try {
      created = store.watcherLinks.createWithConversation({
        link: {
          id: payload.linkId,
          watchedConversationId: watched.id,
          preset: payload.preset,
          instructions: payload.instructions,
          sharing: payload.sharing,
          budgets: payload.budgets,
          privateConnect: payload.privateConnect,
          delivery: payload.delivery,
        },
        conversation: {
          projectId: current.projectId,
          title: watcherConversationTitle(payload.preset, current.title),
          options: {
            providerId: route.providerId,
            modelSelection: route.selection,
            interactionMode: "plan",
            accessMode: "supervised",
            branch: current.branch,
            worktreePath: current.worktreePath,
            activate: false,
          },
        },
      }, this.#deps.now());
    } catch (error) {
      throw policyError(error);
    }
    const { link } = created;
    if (!created.created) return this.#detail(link);
    const latest = store.latestAgentTurnForConversation(watched.id);
    const running = this.#deps.turns.isActive(watched.id);
    if (latest && running) store.watcherLinks.beginWatchedTurn(link.id, latest.id, this.#deps.now());
    this.#deps.index.track(link);
    this.#deps.scheduler.track(link.id, { watchedTurnId: latest?.id ?? null, watchedRunning: running });
    if (payload.initialReview && latest && (latest.status === "completed" || running)) {
      if (!running) {
        store.watcherLinks.beginWatchedTurn(link.id, latest.id, this.#deps.now());
        store.watcherLinks.markFinalPass(link.id, latest.id, this.#deps.now());
      }
      this.#deps.scheduler.requestWake(link.id, "initial");
    }
    this.#deps.broadcastSnapshot();
    return this.#detail(this.publish(link.id) ?? link);
  }

  update(payload: WatcherUpdatePayload): WatcherLinkView {
    const { linkId, ...patch } = payload;
    let updated: WatcherLinkRecord | null;
    try {
      updated = this.#deps.store.watcherLinks.updateSettings(linkId, patch, this.#deps.now());
    } catch (error) {
      throw policyError(error);
    }
    if (!updated) throw new RuntimeRequestError("This watcher is no longer attached.");
    return this.#detail(this.publish(linkId) ?? updated);
  }

  pause(linkId: string): WatcherLinkView {
    const link = this.#require(linkId);
    if (link.status === "paused") return this.#detail(link);
    const paused = this.#deps.store.watcherLinks.transition(
      linkId, ["watching", "waking"], { status: "paused", reason: "user" }, this.#deps.now(),
    );
    if (!paused) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    this.#deps.scheduler.pause(linkId);
    return this.#detail(this.publish(linkId) ?? paused);
  }

  async resume(linkId: string): Promise<WatcherLinkView> {
    const { store } = this.#deps;
    const link = this.#require(linkId);
    if (link.status !== "paused") return this.#detail(link);
    if (link.pauseReason === "usage-limit" || link.pauseReason === "route-unavailable") {
      const watcher = store.conversation(link.watcherConversationId);
      const route = await this.#deps.route(watcher.modelSelection);
      if (!route.ready) throw new RuntimeRequestError(route.message);
    }
    if (link.watchedConversationId !== null
      && (conversationOrNull(store, link.watchedConversationId)?.archivedAt ?? null) !== null) {
      throw new RuntimeRequestError("Unarchive the main chat to resume its watcher.");
    }
    if ((conversationOrNull(store, link.watcherConversationId)?.archivedAt ?? null) !== null) {
      throw new RuntimeRequestError("Unarchive the watcher chat to resume it.");
    }
    const resumed = store.watcherLinks.transition(linkId, ["paused"], { status: "watching" }, this.#deps.now());
    if (!resumed) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    const remaining = resumed.counters.wakeAllowance - resumed.counters.wakesThisTurn;
    const grant = resumed.budgets.wakesPerWatchedTurn - remaining;
    if (grant > 0) store.watcherLinks.grantWakes(linkId, grant, this.#deps.now());
    this.#deps.scheduler.resume(linkId);
    return this.#detail(this.publish(linkId) ?? resumed);
  }

  wake(linkId: string): WatcherLinkView {
    const link = this.#require(linkId);
    if (link.status === "paused") throw new RuntimeRequestError("Resume the watcher before asking it to check.");
    if (link.status === "waking") throw new RuntimeRequestError("The watcher is already checking.");
    this.#deps.scheduler.requestWake(linkId, "manual");
    return this.#detail(link);
  }

  review(linkId: string): WatcherLinkView {
    const { store } = this.#deps;
    const link = this.#require(linkId);
    if (link.status === "paused") throw new RuntimeRequestError("Resume the watcher before asking it to review the last turn.");
    if (link.status === "waking") throw new RuntimeRequestError("The watcher is already checking.");
    const latest = link.watchedConversationId === null ? null : store.latestAgentTurnForConversation(link.watchedConversationId);
    if (!latest) throw new RuntimeRequestError("The main chat has no turn to review yet.");
    const now = this.#deps.now();
    if (link.cursor.turnId !== latest.id) {
      store.watcherLinks.beginWatchedTurn(linkId, latest.id, now);
      if (!this.#deps.turns.isActive(link.watchedConversationId!)) store.watcherLinks.markFinalPass(linkId, latest.id, now);
    }
    const rewound = store.watcherLinks.rewindCursor(linkId, latest.id, now);
    if (!rewound) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    this.#deps.scheduler.requestWake(linkId, "initial");
    return this.#detail(this.publish(linkId) ?? rewound);
  }

  detach(linkId: string): WatcherLinkView {
    const { store } = this.#deps;
    const link = store.watcherLinks.get(linkId);
    if (!link) throw new RuntimeRequestError("This watcher no longer exists.");
    if (link.status === "detached") return this.#detail(link);
    if (this.#deps.turns.isActive(link.watcherConversationId)) this.#deps.turns.cancel(link.watcherConversationId);
    const detached = store.watcherLinks.transition(linkId, ATTACHED, { status: "detached", reason: "user" }, this.#deps.now());
    if (!detached) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    this.#deps.scheduler.forget(linkId);
    this.#deps.forgetLink(linkId);
    this.#deps.index.untrack(linkId);
    this.#deps.broadcastSnapshot();
    return this.#detail(this.publish(linkId) ?? detached);
  }

  feed(linkId: string, beforeSequence?: number): WatcherFeedResult {
    const { store } = this.#deps;
    const page = store.watcherLinks.feed(linkId, beforeSequence);
    if (!page) throw new RuntimeRequestError("This watcher no longer exists.");
    const link = store.watcherLinks.get(linkId);
    const turnIds = page.items.flatMap((item) =>
      item.watcherTurnId !== null && item.state === "settled" ? [item.watcherTurnId] : []);
    const counts = link ? store.watcherLinks.digest.settledCommandCounts(link.watcherConversationId, turnIds) : new Map<string, number>();
    const items = page.items.map((item) => {
      const commandsRun = item.watcherTurnId !== null && item.state === "settled" ? counts.get(item.watcherTurnId) ?? 0 : 0;
      return commandsRun > 0 ? { ...item, commandsRun: Math.min(commandsRun, MAX_WATCHER_COMMANDS_RUN) } : item;
    });
    return {
      kind: "watcher.feed", linkId, feedRevision: page.feedRevision, items, next: page.next,
      usage: store.watcherLinks.usageTotals(linkId),
    };
  }

  linksTouching(conversationId: string): string[] {
    const { watcherLinks } = this.#deps.store;
    const ids = new Set<string>();
    const watched = watcherLinks.findActiveByWatched(conversationId);
    if (watched) ids.add(watched.id);
    const watcher = watcherLinks.findByWatcher(conversationId);
    if (watcher && watcher.status !== "detached") ids.add(watcher.id);
    return [...ids];
  }

  onConversationArchived(conversationId: string): void {
    const { watcherLinks } = this.#deps.store;
    const watched = watcherLinks.findActiveByWatched(conversationId);
    if (watched) this.#pauseForArchive(watched, { status: "paused", reason: "watched-archived" });
    const watcher = watcherLinks.findByWatcher(conversationId);
    if (watcher && watcher.status !== "detached") {
      this.#pauseForArchive(watcher, { status: "paused", reason: "watcher-archived", detail: WATCHER_CHAT_ARCHIVED_DETAIL });
    }
  }

  #pauseForArchive(link: WatcherLinkRecord, pause: Extract<WatcherTransition, { status: "paused" }>): void {
    if (link.pauseReason !== null && ARCHIVE_PAUSES.includes(link.pauseReason)) return;
    const paused = this.#deps.store.watcherLinks.transition(link.id, ATTACHED, pause, this.#deps.now());
    if (!paused) return;
    this.#deps.scheduler.pause(link.id);
    if (this.#deps.turns.isActive(link.watcherConversationId)) this.#deps.turns.cancel(link.watcherConversationId);
    this.publish(link.id);
  }

  reconcileAfterReady(): void {
    const { store } = this.#deps;
    for (const link of store.watcherLinks.active()) {
      this.#deps.index.track(link);
      if (store.watcherLinks.notePendingEvents(link.id, 0, this.#deps.now())) this.publish(link.id);
      const watchedId = link.watchedConversationId;
      const running = watchedId !== null && this.#deps.turns.isActive(watchedId);
      this.#deps.scheduler.track(link.id, { watchedTurnId: link.cursor.turnId, watchedRunning: running });
      if (link.status === "paused") {
        this.#deps.scheduler.pause(link.id, { finalPass: link.pauseReason === "wake-budget" });
      }
      const turnId = link.cursor.turnId;
      if (watchedId === null || turnId === null || link.finalPassTurnId === turnId) continue;
      const turn = store.watcherLinks.digest.turn(watchedId, turnId);
      if (!turn) continue;
      const previous = store.watcherLinks.digest.turnBefore(watchedId, turn);
      if (previous && link.finalPassTurnId !== previous.id && isAgentTurnTerminalStatus(previous.status)
        && previous.completedAt !== null && previous.completedAt > link.createdAt) {
        this.#deps.scheduler.onWatchedTurnSettled(link.id, previous.id);
      }
      if (running || !isAgentTurnTerminalStatus(turn.status)) continue;
      this.#deps.scheduler.onWatchedTurnSettled(link.id, turnId);
    }
  }

  #require(linkId: string): WatcherLinkRecord {
    const link = this.#deps.store.watcherLinks.get(linkId);
    if (!link || link.status === "detached") throw new RuntimeRequestError("This watcher is no longer attached.");
    return link;
  }
}
