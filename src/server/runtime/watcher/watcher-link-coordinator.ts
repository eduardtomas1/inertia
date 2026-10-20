import { resolve } from "node:path";

import type { ModelSelection, RuntimeMutationEvent } from "../../../shared/contracts";
import type { WatcherAttachPayload, WatcherUpdatePayload } from "../../../shared/contracts/client-command/watcher";
import {
  MAX_ACTIVE_WATCHERS,
  WATCHER_PRESET_LABELS,
  watcherLinkViewSchema,
  type WatcherFeedItem,
  type WatcherLinkView,
  type WatcherPauseReason,
  type WatcherStatus,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import { watcherLinkDetailView, watcherLinkView } from "../../persistence/watcher-link-codecs";
import {
  WatcherPolicyError,
  type WatcherFeedPage,
  type WatcherLinkRecord,
  type WatcherTransition,
} from "../../persistence/watcher-link-repository";
import { normalizeIdentityPath } from "../../project-identity";
import { RuntimeRequestError } from "../../runtime-errors";
import type { TurnController } from "../turns/turn-controller";
import type { WatcherRouteReadiness } from "./watcher-route";
import { conversationOrNull } from "./watcher-wake-runner";
import type { WatcherWakeScheduler } from "./watcher-wake-scheduler";

export const MAX_WATCHER_TITLE_CHARS = 120;
export const WATCHER_CHAT_ARCHIVED_DETAIL = "The watcher's own chat was archived. Unarchive it to resume the watcher.";
const ATTACHED: readonly WatcherStatus[] = ["watching", "waking", "idle", "paused"];
const ARCHIVE_PAUSES: readonly WatcherPauseReason[] = ["watched-archived", "watcher-archived"];

export interface WatcherFeedResult {
  kind: "watcher.feed";
  linkId: string;
  feedRevision: number;
  items: WatcherFeedItem[];
  next: WatcherFeedPage["next"];
}

/** In-memory lookup of attached links by either side; the database stays authoritative. */
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

  linkIds(): string[] {
    return [...this.#links.keys()];
  }

  clear(): void {
    this.#byWatched.clear();
    this.#byWatcher.clear();
    this.#links.clear();
  }
}

export interface WatcherLinkCoordinatorDependencies {
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
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (flattened.length <= MAX_WATCHER_TITLE_CHARS) return flattened;
  const end = MAX_WATCHER_TITLE_CHARS - 1;
  const last = flattened.charCodeAt(end - 1);
  return `${flattened.slice(0, last >= 0xD800 && last <= 0xDBFF ? end - 1 : end).trimEnd()}…`;
}

export function watcherConversationTitle(preset: WatcherAttachPayload["preset"], watchedTitle: string): string {
  return clipTitle(`Watcher · ${WATCHER_PRESET_LABELS[preset]} · ${watchedTitle.trim() || "Untitled chat"}`);
}

function policyError(error: unknown): unknown {
  return error instanceof WatcherPolicyError ? new RuntimeRequestError(error.message) : error;
}

/**
 * Owns the lifecycle of watcher links: attach (with a Duo-style route
 * preflight and atomic creation of the locked, read-only watcher chat),
 * settings, pause and resume, manual checks, detach, the feed, archive
 * handling and restart reconciliation. Every change is published as
 * `watcher.link.updated` or `watcher.link.removed`.
 */
export class WatcherLinkCoordinator {
  readonly #deps: WatcherLinkCoordinatorDependencies;

  constructor(dependencies: WatcherLinkCoordinatorDependencies) {
    this.#deps = dependencies;
  }

  /**
   * Broadcasts the link's shell view; detached links leave the shell. Returns
   * the command-result view, which also carries the user's instructions.
   */
  publish(linkId: string): WatcherLinkView | null {
    const link = this.#deps.store.watcherLinks.get(linkId);
    if (!link) {
      this.#deps.index.untrack(linkId);
      this.#deps.broadcast({ type: "watcher.link.removed", linkId });
      return null;
    }
    if (link.status === "detached") {
      this.#deps.index.untrack(linkId);
      this.#deps.broadcast({ type: "watcher.link.removed", linkId });
      return watcherLinkDetailView(link);
    }
    const view = watcherLinkView(link);
    if (watcherLinkViewSchema.safeParse(view).success) {
      this.#deps.broadcast({ type: "watcher.link.updated", link: view });
    }
    return watcherLinkDetailView(link);
  }

  async attach(payload: WatcherAttachPayload): Promise<WatcherLinkView> {
    const { store } = this.#deps;
    const existing = store.watcherLinks.get(payload.linkId);
    if (existing) {
      if (existing.watchedConversationId === payload.watchedConversationId && existing.status !== "detached") {
        return watcherLinkDetailView(existing);
      }
      throw new RuntimeRequestError("This watcher already exists.");
    }
    const watched = conversationOrNull(store, payload.watchedConversationId);
    if (!watched) throw new RuntimeRequestError("The chat to watch no longer exists.");
    if (store.project(watched.projectId).workspaceKind === "scratch") {
      throw new RuntimeRequestError("A watcher needs a chat in a project.");
    }
    if (watched.archivedAt !== null) throw new RuntimeRequestError("Unarchive this chat before adding a watcher.");
    const watchedPolicy = store.watcherLinks.policyForConversation(watched.id);
    if (watchedPolicy && watchedPolicy.status !== "detached") {
      throw new RuntimeRequestError("A watcher can't watch another watcher.");
    }
    if (store.watcherLinks.findActiveByWatched(watched.id)) throw new RuntimeRequestError("This chat already has a watcher.");
    if (store.watcherLinks.active().length >= MAX_ACTIVE_WATCHERS) {
      throw new RuntimeRequestError("Inertia already has eight active watchers. Stop one first.");
    }
    const route = await this.#deps.route(payload.modelSelection);
    if (!route.ready) throw new RuntimeRequestError(route.message);
    if (watched.worktreePath !== null) {
      let actual: string;
      try {
        actual = store.conversationPath(watched.id);
      } catch {
        throw new RuntimeRequestError("The watched chat's worktree is unavailable, so a watcher can't share it.");
      }
      if (normalizeIdentityPath(resolve(watched.worktreePath)) !== normalizeIdentityPath(resolve(actual))) {
        throw new RuntimeRequestError("The watched chat's worktree is not the checkout it records.");
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
    if (!created.created) return watcherLinkDetailView(link);
    const latest = store.latestAgentTurnForConversation(watched.id);
    const running = this.#deps.turns.isActive(watched.id);
    if (latest && running) store.watcherLinks.beginWatchedTurn(link.id, latest.id, this.#deps.now());
    this.#deps.index.track(link);
    this.#deps.scheduler.track(link.id, { watchedTurnId: latest?.id ?? null, watchedRunning: running });
    if (payload.initialReview && latest && (latest.status === "completed" || running)) {
      if (!running) {
        store.watcherLinks.beginWatchedTurn(link.id, latest.id, this.#deps.now());
        // The turn ended before the watcher existed: the initial review covers
        // it, so no restart may schedule a final check for it later.
        store.watcherLinks.markFinalPass(link.id, latest.id, this.#deps.now());
      }
      this.#deps.scheduler.requestWake(link.id, "initial");
    }
    this.#deps.broadcastSnapshot();
    return this.publish(link.id) ?? watcherLinkDetailView(link);
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
    return this.publish(linkId) ?? watcherLinkDetailView(updated);
  }

  pause(linkId: string): WatcherLinkView {
    const link = this.#require(linkId);
    if (link.status === "paused") return watcherLinkDetailView(link);
    const paused = this.#deps.store.watcherLinks.transition(
      linkId, ["watching", "waking", "idle"], { status: "paused", reason: "user" }, this.#deps.now(),
    );
    if (!paused) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    this.#deps.scheduler.pause(linkId);
    return this.publish(linkId) ?? watcherLinkDetailView(paused);
  }

  async resume(linkId: string): Promise<WatcherLinkView> {
    const { store } = this.#deps;
    const link = this.#require(linkId);
    if (link.status !== "paused") return watcherLinkDetailView(link);
    if (link.pauseReason === "usage-limit" || link.pauseReason === "route-unavailable") {
      const watcher = store.conversation(link.watcherConversationId);
      const route = await this.#deps.route(watcher.modelSelection);
      if (!route.ready) throw new RuntimeRequestError(`The watcher's route isn't ready yet. ${route.message}`);
    }
    if (link.watchedConversationId !== null
      && (conversationOrNull(store, link.watchedConversationId)?.archivedAt ?? null) !== null) {
      throw new RuntimeRequestError("Unarchive the watched chat before resuming its watcher.");
    }
    if ((conversationOrNull(store, link.watcherConversationId)?.archivedAt ?? null) !== null) {
      throw new RuntimeRequestError("Unarchive the watcher chat before resuming it.");
    }
    const resumed = store.watcherLinks.transition(linkId, ["paused"], { status: "watching" }, this.#deps.now());
    if (!resumed) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    const remaining = resumed.counters.wakeAllowance - resumed.counters.wakesThisTurn;
    const grant = resumed.budgets.wakesPerWatchedTurn - remaining;
    if (grant > 0) store.watcherLinks.grantWakes(linkId, grant, this.#deps.now());
    this.#deps.scheduler.resume(linkId);
    return this.publish(linkId) ?? watcherLinkDetailView(resumed);
  }

  wake(linkId: string): WatcherLinkView {
    const link = this.#require(linkId);
    if (link.status === "paused") throw new RuntimeRequestError("Resume the watcher before asking it to check.");
    if (link.status === "waking") throw new RuntimeRequestError("The watcher is already checking.");
    this.#deps.scheduler.requestWake(linkId, "manual");
    return watcherLinkDetailView(link);
  }

  detach(linkId: string): WatcherLinkView {
    const { store } = this.#deps;
    const link = store.watcherLinks.get(linkId);
    if (!link) throw new RuntimeRequestError("This watcher no longer exists.");
    if (link.status === "detached") return watcherLinkDetailView(link);
    if (this.#deps.turns.isActive(link.watcherConversationId)) this.#deps.turns.cancel(link.watcherConversationId);
    const detached = store.watcherLinks.transition(linkId, ATTACHED, { status: "detached", reason: "user" }, this.#deps.now());
    if (!detached) throw new RuntimeRequestError("This watcher changed meanwhile. Try again.");
    this.#deps.scheduler.forget(linkId);
    this.#deps.forgetLink(linkId);
    this.#deps.index.untrack(linkId);
    this.#deps.broadcastSnapshot();
    return this.publish(linkId) ?? watcherLinkDetailView(detached);
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
      return commandsRun > 0 ? { ...item, commandsRun: Math.min(commandsRun, 10_000) } : item;
    });
    return { kind: "watcher.feed", linkId, feedRevision: page.feedRevision, items, next: page.next };
  }

  /**
   * Attached links a chat takes part in, as watched chat or watcher chat.
   * Read before the chat is deleted: the delete detaches or removes them in
   * SQL, so they can no longer be found by that chat afterwards.
   */
  linksTouching(conversationId: string): string[] {
    const { watcherLinks } = this.#deps.store;
    const ids = new Set<string>();
    const watched = watcherLinks.findActiveByWatched(conversationId);
    if (watched) ids.add(watched.id);
    const watcher = watcherLinks.findByWatcher(conversationId);
    if (watcher && watcher.status !== "detached") ids.add(watcher.id);
    return [...ids];
  }

  /**
   * A chat was archived. The watcher of an archived chat pauses with
   * `watched-archived`; a watcher whose own chat was archived pauses with
   * `watcher-archived`. Either replaces an earlier pause that was not for an
   * archive and cancels a running check, so no check keeps running in a chat
   * the user put away. Both wait for the user to unarchive and resume.
   * Repeating it for a chat that stays archived is a no-op.
   */
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

  /**
   * After startup: tracks every attached link and schedules, at most once, the
   * final pass of a watched turn that ended while Inertia was closed.
   */
  reconcileAfterReady(): void {
    const { store } = this.#deps;
    for (const link of store.watcherLinks.active()) {
      this.#deps.index.track(link);
      const watchedId = link.watchedConversationId;
      const running = watchedId !== null && this.#deps.turns.isActive(watchedId);
      this.#deps.scheduler.track(link.id, { watchedTurnId: link.cursor.turnId, watchedRunning: running });
      if (link.status === "paused") {
        this.#deps.scheduler.pause(link.id, { finalPass: link.pauseReason === "wake-budget" });
      }
      const turnId = link.cursor.turnId;
      if (watchedId === null || turnId === null || running || link.finalPassTurnId === turnId) continue;
      const turn = store.watcherLinks.digest.turn(watchedId, turnId);
      if (!turn || !["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) continue;
      this.#deps.scheduler.onWatchedTurnSettled(link.id, turnId);
    }
  }

  #require(linkId: string): WatcherLinkRecord {
    const link = this.#deps.store.watcherLinks.get(linkId);
    if (!link || link.status === "detached") throw new RuntimeRequestError("This watcher is no longer attached.");
    return link;
  }
}
