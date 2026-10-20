import { modelSelectionIdentityLabel } from "../../../shared/claude-backend-profiles";
import { watcherAgentLabel } from "../../../shared/watcher-agent-label";
import type { AgentTurn, ModelSelection } from "../../../shared/contracts";
import {
  MAX_WATCHER_FINDING_BYTES,
  type WatcherWakeOutcome,
  type WatcherWakeTrigger,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import { PROVIDER_INFO } from "../../provider/catalog";
import { readWatcherTurnDiff, type WatcherTurnDiffSnapshot } from "../../persistence/watcher-digest-source";
import type { WatcherCursor, WatcherLinkRecord, WatcherTransition } from "../../persistence/watcher-link-repository";
import type { TurnController } from "../turns/turn-controller";
import type { ReadOnlyWatcherViolation } from "../turns/turn-controller-types";
import { publicRuntimeError } from "../../runtime-errors";
import { isHeld } from "../update-hold";
import type { WatcherCheckoutGuard, WatcherGuardOutcome, WatcherGuardWindow } from "./watcher-checkout-guard";
import type { WatcherDeliveryService } from "./watcher-delivery";
import { buildWatcherDigest, type WatcherDigest, type WatcherOpenReply } from "./watcher-digest";
import { watcherInstruction } from "./watcher-instructions";
import type { WatcherLiveProjection } from "./watcher-live-projection";
import { classifyWatcherReply, findingPreview, splitWatcherResolvedLine } from "./watcher-outcome";
import type { WatcherRouteReadiness } from "./watcher-route";
import {
  WATCHER_MAX_PENDING_FINALS,
  type WatcherWakeAttempt,
  type WatcherWakeContext,
  type WatcherWakeScheduler,
} from "./watcher-wake-scheduler";

export const WATCHER_USAGE_LIMIT_DETAIL = "The watcher's own account reached its usage limit. It can resume once its route is ready again.";
export const WATCHER_WRITE_ATTEMPTS_DETAIL = "The watcher tried to edit files twice during one turn of the main chat.";
/**
 * Consecutive wakes that may find the watcher's route unready and retry with
 * the scheduler's backoff before the link pauses with `route-unavailable`.
 */
export const WATCHER_ROUTE_RETRY_LIMIT = 3;
/** Consecutive checks that fail to dispatch before the link pauses with `route-unavailable`. */
export const WATCHER_DISPATCH_FAILURE_LIMIT = 3;
export const WATCHER_FINAL_PASS_MAX_PAGES = 4;
export const WATCHER_FINAL_PASS_RETRY_LIMIT = 2;
export const WATCHER_EARLIER_FINDINGS = 5;

export function watcherRouteUnavailableDetail(selection: ModelSelection, message: string): string {
  return `The watcher's route (${modelSelectionIdentityLabel(selection)}) isn't ready: ${message.trim()} `
    + "Check Settings → Agents; it can resume once the route is ready.";
}

export function watcherDispatchFailedDetail(message: string): string {
  return `The watcher's checks could not start ${WATCHER_DISPATCH_FAILURE_LIMIT} times in a row: ${message.trim()} `
    + "It can resume once the watcher chat can run again.";
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROVIDER_INFO).map(([id, info]) => [id, info.name]),
);

/** Room for a finding preview plus its trailing marker. */
const MAX_REPLY_READ_BYTES = MAX_WATCHER_FINDING_BYTES * 2;
const MAX_RESOLVED_TAIL_BYTES = 2_048;

export type WatcherRunnerTurns = Pick<TurnController, "queue" | "start" | "isActive" | "isClosing" | "cancel" | "failBeforeStart">;

export interface WatcherWakeRunnerDependencies {
  store: RuntimeStore;
  turns: WatcherRunnerTurns;
  route(selection: ModelSelection): Promise<WatcherRouteReadiness>;
  guard: Pick<WatcherCheckoutGuard, "before">;
  live: Pick<WatcherLiveProjection, "begin" | "end">;
  scheduler(): Pick<WatcherWakeScheduler, "wakeFinished" | "pause" | "resume" | "continueWake" | "pendingEvents">;
  /** Republishes the link (`watcher.link.updated`). */
  publish(linkId: string): void;
  /** Refreshes the watcher chat's shell row after a check settles. */
  refreshConversation?(conversationId: string): void;
  detailChanged?(conversationId: string): void;
  turnDiff?(turnId: string): Promise<WatcherTurnDiffSnapshot>;
  delivery?(): Pick<WatcherDeliveryService, "deliver">;
  now(): string;
  id(): string;
}

interface RunningWake {
  linkId: string;
  wakeId: string;
  watcherConversationId: string;
  window: WatcherGuardWindow;
  digest: WatcherDigest;
  /** The cursor the digest was built from; the stored cursor moves only while its turn still holds. */
  start: WatcherCursor;
  /** The final pass's turn, or null for a mid-turn check. */
  finalTurnId: string | null;
  finalPage: number;
  request: Extract<WatcherWakeTrigger, "manual" | "initial"> | null;
  requestPage: number;
  lastPage: boolean;
  restore: WatcherTransition;
  violations: ReadOnlyWatcherViolation[];
  pause: WatcherTransition | null;
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

class TurnMemory<T> {
  readonly #links = new Map<string, Array<{ turnId: string; value: T }>>();

  get(linkId: string, turnId: string | null): T | undefined {
    return this.#links.get(linkId)?.find((entry) => entry.turnId === turnId)?.value;
  }

  set(linkId: string, turnId: string, value: T): void {
    const kept = (this.#links.get(linkId) ?? []).filter((entry) => entry.turnId !== turnId);
    kept.push({ turnId, value });
    this.#links.set(linkId, kept.slice(-WATCHER_MAX_PENDING_FINALS));
  }

  delete(linkId: string, turnId: string): void {
    const kept = this.#links.get(linkId)?.filter((entry) => entry.turnId !== turnId) ?? [];
    if (kept.length > 0) this.#links.set(linkId, kept);
    else this.#links.delete(linkId);
  }

  forget(linkId: string): void {
    this.#links.delete(linkId);
  }

  clear(): void {
    this.#links.clear();
  }
}

/** The check read past where it started; a continuation that did not would read the same page again. */
function advanced({ start, digest }: Pick<RunningWake, "start" | "digest">): boolean {
  return digest.cursor.turnId !== start.turnId
    || digest.cursor.activityAt !== start.activityAt
    || digest.cursor.activityId !== start.activityId;
}

const VIOLATION_OUTCOMES: ReadonlyArray<[ReadOnlyWatcherViolation["kind"][], WatcherWakeOutcome]> = [
  [["write-attempt"], "write-attempt"],
  [["command-attempt"], "command-attempt"],
  [["input", "approval-limit"], "permission-declined"],
];

/**
 * Runs and settles watcher checks. A check claims the link (`watching` →
 * `waking`), builds the digest, opens the checkout guard window, records the
 * check and queues a plan-mode, supervised watcher turn that claims it. On
 * settlement it classifies the reply, applies read-only violations and the
 * guard result, moves the cursor only for silent and finding outcomes, and
 * decides whether the link pauses.
 */
export class WatcherWakeRunner {
  readonly #deps: WatcherWakeRunnerDependencies;
  readonly #running = new Map<string, RunningWake>();
  readonly #planKeys = new Map<string, string | null>();
  readonly #routeFailures = new Map<string, number>();
  readonly #dispatchFailures = new Map<string, number>();
  /** Coverage of a watched turn whose final pass is still due after the next turn began. */
  readonly #priorCursors = new TurnMemory<WatcherCursor>();
  readonly #openReplies = new TurnMemory<WatcherOpenReply>();
  readonly #finalPages = new Map<string, { turnId: string; pages: number }>();
  readonly #finalFailures = new Map<string, { turnId: string; failures: number }>();
  readonly #requestPages = new Map<string, number>();

  constructor(dependencies: WatcherWakeRunnerDependencies) {
    this.#deps = dependencies;
  }

  /** True while a check of this link is running in this process. */
  isRunning(linkId: string): boolean {
    for (const wake of this.#running.values()) if (wake.linkId === linkId) return true;
    return false;
  }

  forget(linkId: string): void {
    this.#planKeys.delete(linkId);
    this.#routeFailures.delete(linkId);
    this.#dispatchFailures.delete(linkId);
    this.#priorCursors.forget(linkId);
    this.#openReplies.forget(linkId);
    this.#finalPages.delete(linkId);
    this.#finalFailures.delete(linkId);
    this.#requestPages.delete(linkId);
  }

  /** A resumed link starts its route and dispatch retries afresh. */
  resumed(linkId: string): void {
    this.#routeFailures.delete(linkId);
    this.#dispatchFailures.delete(linkId);
  }

  /**
   * The watched chat started a new turn. Keeps how far the previous turn was
   * covered when its final pass has not run yet, so that pass reviews only
   * what is new in that turn.
   */
  watchedTurnChanging(link: Pick<WatcherLinkRecord, "id" | "cursor" | "finalPassTurnId">, nextTurnId: string): void {
    const { cursor } = link;
    if (cursor.turnId === null || cursor.turnId === nextTurnId || link.finalPassTurnId === cursor.turnId) return;
    this.#priorCursors.set(link.id, cursor.turnId, cursor);
  }

  async run(linkId: string, trigger: WatcherWakeTrigger, context: WatcherWakeContext): Promise<WatcherWakeAttempt> {
    const { store, turns } = this.#deps;
    const link = store.watcherLinks.get(linkId);
    if (!link || link.status === "detached" || link.watchedConversationId === null) return "skipped";
    const budgetFinalPass = context.final && link.status === "paused" && link.pauseReason === "wake-budget";
    if (link.status !== "watching" && link.status !== "idle" && !budgetFinalPass) return "skipped";
    if (turns.isClosing() || isHeld()) return "transient";
    const watcher = conversationOrNull(store, link.watcherConversationId);
    const watched = conversationOrNull(store, link.watchedConversationId);
    if (!watcher || !watched) return "skipped";
    if (turns.isActive(watcher.id)) return "transient";
    const route = await this.#deps.route(watcher.modelSelection);
    if (!route.ready) return this.#routeUnavailable(linkId, watcher.modelSelection, route.message, budgetFinalPass);
    this.#routeFailures.delete(linkId);

    const claimed = store.watcherLinks.transition(
      linkId,
      budgetFinalPass ? ["paused"] : ["watching", "idle"],
      { status: "waking" },
      this.#deps.now(),
    );
    if (!claimed) return this.#claimLost(linkId);
    this.#deps.publish(linkId);
    const restore: WatcherTransition = budgetFinalPass
      ? { status: "paused", reason: "wake-budget", detail: link.pauseDetail }
      : { status: "watching" };
    const release = (attempt: WatcherWakeAttempt): WatcherWakeAttempt => {
      const checkTurnId = context.final ? context.watchedTurnId : claimed.cursor.turnId;
      if (!this.#release(linkId, restore, checkTurnId)) return attempt === "skipped" ? this.#claimLost(linkId) : attempt;
      this.#deps.publish(linkId);
      return attempt;
    };
    let window: WatcherGuardWindow | null = null;
    try {
      if (context.final && context.watchedTurnId !== null && claimed.finalPassTurnId === context.watchedTurnId) {
        return release("skipped");
      }
      // The final pass reviews its own turn, even when the next one already began.
      const finalTurnId = context.final ? context.watchedTurnId : null;
      const staleTurn = finalTurnId !== null && claimed.cursor.turnId !== null && claimed.cursor.turnId !== finalTurnId;
      const cursor: WatcherCursor = !staleTurn
        ? claimed.cursor
        : this.#priorCursors.get(linkId, finalTurnId)
          ?? { turnId: finalTurnId, activityAt: null, activityId: null, messageAt: null, pendingRunningIds: [] };
      const request = trigger === "manual" || trigger === "initial" ? trigger : null;
      const review = trigger === "initial" && !context.continued;
      const previousPlanKey = !staleTurn && !review && this.#planKeys.has(linkId) ? this.#planKeys.get(linkId)! : undefined;
      const remaining = claimed.counters.wakeAllowance - claimed.counters.wakesThisTurn;
      const consumesAllowance = trigger !== "manual" && trigger !== "initial" && remaining > 0;
      const drained = this.#finalPages.get(linkId);
      const finalPage = finalTurnId === null ? 0 : drained?.turnId === finalTurnId ? drained.pages + 1 : 1;
      const spare = staleTurn ? 0 : remaining - (consumesAllowance ? 1 : 0);
      const requestPage = request === null ? 0 : context.continued ? (this.#requestPages.get(linkId) ?? 0) + 1 : 1;
      const lastPage = (finalTurnId !== null && finalPage >= WATCHER_FINAL_PASS_MAX_PAGES && spare <= 0)
        || requestPage >= WATCHER_FINAL_PASS_MAX_PAGES;
      const digestTurnId = finalTurnId ?? cursor.turnId;
      const turnDiff = this.#deps.turnDiff;
      const diff = finalTurnId !== null && claimed.sharing.changedFiles && turnDiff
        ? { diff: await readWatcherTurnDiff(turnDiff, finalTurnId) }
        : {};
      const digest = buildWatcherDigest(store.watcherLinks.digest, { ...claimed, cursor }, {
        final: context.final,
        requested: request !== null,
        sessionFresh: watcher.providerSessionId === null,
        now: this.#deps.now(),
        watchedTitle: watched.title,
        watchedAgent: watcherAgentLabel(watched, PROVIDER_NAMES),
        sequence: claimed.counters.wakesTotal + 1,
        ...(previousPlanKey === undefined ? {} : { previousPlanKey }),
        ...(finalTurnId === null ? {} : { turnId: finalTurnId }),
        openReply: review ? null : this.#openReplies.get(linkId, cursor.turnId) ?? null,
        lastPage,
        contextAccess: route.contextAccess !== false && claimed.budgets.contextReadsPerWake !== 0,
        earlierFindings: digestTurnId === null ? [] : store.watcherLinks.findingsForTurn(linkId, digestTurnId, WATCHER_EARLIER_FINDINGS),
        ...diff,
      });
      if (!digest) return release("skipped");
      window = await this.#deps.guard.before(watcher.id);
      // The guard can take seconds; the user may have started a watcher-chat turn meanwhile.
      if (turns.isActive(watcher.id) || turns.isClosing()) {
        window.dispose();
        return release("transient");
      }
      const wake = store.watcherLinks.createWake({
        id: this.#deps.id(),
        linkId,
        watchedTurnId: digest.turnId,
        trigger,
        eventsCovered: digest.stats.eventsCovered,
        itemsTruncated: digest.stats.itemsTruncated,
        itemsOmitted: digest.stats.itemsOmitted,
        digestBytes: digest.stats.bytes,
        consumesAllowance,
      }, this.#deps.now());
      if (!wake) {
        window.dispose();
        return release("skipped");
      }
      let queuedTurnId: string;
      try {
        queuedTurnId = turns.queue({
          conversationId: watcher.id,
          content: digest.content,
          internalInstructions: [watcherInstruction(claimed, { title: watched.title, id: watched.id }, {
            contextAccess: route.contextAccess,
          })],
          activateConversation: false,
          skills: [],
          authorizedWatcherWakeId: wake.wakeId,
        }).turn.id;
      } catch (error) {
        window.dispose();
        store.watcherLinks.settleWake(wake.wakeId, "failed", null, null, this.#deps.now());
        if (this.#dispatchFailed(linkId, error)) return "paused";
        release("transient");
        throw error;
      }
      this.#dispatchFailures.delete(linkId);
      if (store.watcherLinks.attachWakeTurn(wake.wakeId, queuedTurnId, this.#deps.now())) {
        this.#deps.detailChanged?.(watcher.id);
      }
      this.#running.set(queuedTurnId, {
        linkId, wakeId: wake.wakeId, watcherConversationId: watcher.id, window, digest,
        start: cursor, finalTurnId, finalPage, request, requestPage, lastPage, restore, violations: [], pause: null,
      });
      if (!staleTurn) this.#planKeys.set(linkId, digest.planKey);
      this.#deps.live.begin(linkId, watcher.id, queuedTurnId);
      this.#deps.publish(linkId);
      if (!turns.start(queuedTurnId) && !turns.isClosing()) {
        turns.failBeforeStart(watcher.id, "The watcher check could not start.");
      }
      return "started";
    } catch (error) {
      if (window && ![...this.#running.values()].some((running) => running.window === window)) window.dispose();
      if (store.watcherLinks.get(linkId)?.status === "waking" && !this.isRunning(linkId)) release("transient");
      throw error;
    }
  }

  #claimLost(linkId: string): WatcherWakeAttempt {
    const status = this.#deps.store.watcherLinks.get(linkId)?.status;
    if (status === "paused") return "paused";
    return status === "watching" || status === "idle" ? "transient" : "skipped";
  }

  /**
   * A wake whose route is not ready (the same preflight as attach) retries as
   * transient up to the limit, then pauses the link with `route-unavailable`.
   * Resuming that pause requires a ready route.
   */
  #routeUnavailable(
    linkId: string,
    selection: ModelSelection,
    message: string,
    budgetFinalPass: boolean,
  ): WatcherWakeAttempt {
    const failures = (this.#routeFailures.get(linkId) ?? 0) + 1;
    if (failures <= WATCHER_ROUTE_RETRY_LIMIT) {
      this.#routeFailures.set(linkId, failures);
      return "transient";
    }
    this.#routeFailures.delete(linkId);
    const paused = this.#deps.store.watcherLinks.transition(
      linkId,
      budgetFinalPass ? ["paused"] : ["watching", "idle"],
      { status: "paused", reason: "route-unavailable", detail: watcherRouteUnavailableDetail(selection, message) },
      this.#deps.now(),
    );
    if (!paused) return "skipped";
    this.#deps.scheduler().pause(linkId);
    this.#deps.publish(linkId);
    return "paused";
  }

  /**
   * Counts a check that failed to dispatch. The limit-th consecutive failure
   * pauses the link with `route-unavailable` instead of retrying forever;
   * returns true when it paused.
   */
  #dispatchFailed(linkId: string, error: unknown): boolean {
    const failures = (this.#dispatchFailures.get(linkId) ?? 0) + 1;
    if (failures < WATCHER_DISPATCH_FAILURE_LIMIT) {
      this.#dispatchFailures.set(linkId, failures);
      return false;
    }
    this.#dispatchFailures.delete(linkId);
    const paused = this.#deps.store.watcherLinks.transition(
      linkId,
      ["waking"],
      { status: "paused", reason: "route-unavailable", detail: watcherDispatchFailedDetail(publicRuntimeError(error)) },
      this.#deps.now(),
    );
    if (!paused) return false;
    this.#deps.scheduler().pause(linkId);
    this.#deps.publish(linkId);
    return true;
  }

  #finalPassDone(linkId: string, turnId: string): void {
    this.#deps.store.watcherLinks.markFinalPass(linkId, turnId, this.#deps.now());
    this.#priorCursors.delete(linkId, turnId);
    this.#openReplies.delete(linkId, turnId);
    if (this.#finalPages.get(linkId)?.turnId === turnId) this.#finalPages.delete(linkId);
    if (this.#finalFailures.get(linkId)?.turnId === turnId) this.#finalFailures.delete(linkId);
  }

  #finalPassDue(linkId: string, turnId: string, outcome: WatcherWakeOutcome): boolean {
    if (outcome === "usage-limited") return true;
    if (outcome !== "failed") return false;
    const known = this.#finalFailures.get(linkId);
    const failures = (known?.turnId === turnId ? known.failures : 0) + 1;
    if (failures > WATCHER_FINAL_PASS_RETRY_LIMIT) return false;
    this.#finalFailures.set(linkId, { turnId, failures });
    return true;
  }

  /**
   * Ends the `waking` claim. A final pass made while paused for the wake
   * budget returns to that pause, unless the watched chat started its next
   * turn meanwhile: the budget is per turn, so the link watches again.
   */
  #release(linkId: string, restore: WatcherTransition, checkTurnId: string | null): boolean {
    const { store } = this.#deps;
    const budgetPause = restore.status === "paused" && restore.reason === "wake-budget";
    const current = budgetPause ? store.watcherLinks.get(linkId) : null;
    const nextTurn = current !== null && current.cursor.turnId !== null && current.cursor.turnId !== checkTurnId;
    const target: WatcherTransition = nextTurn ? { status: "watching" } : restore;
    if (!store.watcherLinks.transition(linkId, ["waking"], target, this.#deps.now())) return false;
    if (nextTurn) this.#deps.scheduler().resume(linkId);
    return true;
  }

  /**
   * Records a read-only violation of a watcher turn. A second write attempt
   * in the same watched turn pauses the link and stops the check.
   */
  onViolation(turn: AgentTurn, violation: ReadOnlyWatcherViolation): void {
    const { store, turns } = this.#deps;
    const link = store.watcherLinks.get(violation.linkId);
    if (!link || link.status === "detached" || link.watcherConversationId !== turn.conversationId) return;
    let pause: WatcherTransition | null = null;
    if (violation.kind === "write-attempt") {
      const attempts = store.watcherLinks.recordWriteAttempt(link.id, this.#deps.now());
      if (attempts >= 2) pause = { status: "paused", reason: "write-attempts", detail: WATCHER_WRITE_ATTEMPTS_DETAIL };
    }
    const running = this.#running.get(turn.id);
    if (running) {
      running.violations.push(violation);
      if (pause) running.pause = pause;
    } else if (pause && store.watcherLinks.transition(link.id, ["watching", "idle"], pause, this.#deps.now())) {
      this.#deps.scheduler().pause(link.id);
      this.#deps.publish(link.id);
    }
    if (pause && !violation.stopped) {
      const conversationId = turn.conversationId;
      queueMicrotask(() => { turns.cancel(conversationId); });
    }
  }

  /**
   * Settles the check a watcher turn ran; false when the turn ran no check.
   * Whatever fails while settling, the `waking` claim is released and the
   * scheduler hears `wakeFinished`, so a link never stays wedged.
   */
  async settle(turn: AgentTurn): Promise<boolean> {
    const { store } = this.#deps;
    const wake = store.watcherLinks.wakeForTurn(turn.id);
    const running = this.#running.get(turn.id) ?? null;
    if (!wake) {
      if (running) running.window.dispose();
      this.#running.delete(turn.id);
      return false;
    }
    this.#running.delete(turn.id);
    const linkId = wake.linkId;
    let pause: WatcherTransition | null = null;
    let outcome: WatcherWakeOutcome = "failed";
    let settled = false;
    let continues = false;
    let found = false;
    try {
      this.#deps.live.end(linkId);
      let guard: WatcherGuardOutcome | null = null;
      try {
        guard = running ? await running.window.after(turn.id) : null;
      } catch {
        guard = { state: "unavailable", paths: [], pauseDetail: null };
      }
      const usageLimited = turn.usageLimited === true || store.limitResets.usageLimited(turn.id);
      let finding: string | null = null;
      let resolved: number[] = [];
      if (turn.status === "cancelled") outcome = "cancelled";
      else if (usageLimited) outcome = "usage-limited";
      else if (turn.status !== "completed") outcome = "failed";
      else {
        const messageId = turn.terminalAssistantMessageId;
        const read = messageId
          ? store.watcherLinks.digest.messageText(messageId, MAX_REPLY_READ_BYTES)
          : { content: "", truncated: false };
        const reply = read.truncated && messageId
          ? {
              text: read.content.trim(),
              resolved: splitWatcherResolvedLine(
                store.watcherLinks.digest.messageTextAfter(messageId, 0, MAX_RESOLVED_TAIL_BYTES).content,
              ).resolved,
            }
          : splitWatcherResolvedLine(read.content);
        resolved = reply.resolved;
        outcome = classifyWatcherReply(reply.text, turn.status);
        if (outcome === "finding") finding = findingPreview(reply.text);
      }
      const violations = running?.violations ?? [];
      const stopped = violations.some((violation) => violation.stopped) || (running?.pause ?? null) !== null;
      const override = VIOLATION_OUTCOMES.find(([kinds]) =>
        violations.some((violation) => kinds.includes(violation.kind)))?.[1];
      if (override && stopped) {
        outcome = override;
        finding = null;
      }
      if (guard?.state === "changed") {
        outcome = "write-detected";
        finding = null;
      }
      const now = this.#deps.now();
      if (running && (outcome === "silent" || outcome === "finding")) {
        continues = this.#advance(linkId, running, now) && running.digest.stats.moreFollows && advanced(running)
          && !running.lastPage;
      }
      const record = store.watcherLinks.settleWake(
        wake.wakeId,
        outcome,
        guard ? { state: guard.state, paths: guard.paths } : null,
        finding,
        now,
        violations.filter(({ kind }) => kind === "command-attempt").length,
      );
      settled = true;
      found = record?.outcome === "finding";
      pause = guard?.state === "changed"
        ? { status: "paused", reason: "write-detected", detail: guard.pauseDetail }
        : running?.pause
          ?? (usageLimited ? { status: "paused", reason: "usage-limit", detail: WATCHER_USAGE_LIMIT_DETAIL } : null);
      if (outcome === "silent" || outcome === "finding") {
        for (const earlier of store.watcherLinks.findingsBySequence(linkId, resolved)) {
          store.watcherLinks.markResolved(earlier.wakeId, wake.sequence, now);
        }
      }
    } finally {
      const now = this.#deps.now();
      if (!settled) {
        try {
          store.watcherLinks.settleWake(wake.wakeId, "failed", null, null, now);
        } catch {
          // Restart recovery fails a check that stayed unsettled.
        }
      }
      const scheduler = this.#deps.scheduler();
      const finalTurnId = running?.finalTurnId ?? null;
      try {
        if (continues && !pause) {
          // More of the same watched turn waits: check it without waiting for new events.
          if (finalTurnId !== null && running) this.#finalPages.set(linkId, { turnId: finalTurnId, pages: running.finalPage });
          if (running?.request) this.#requestPages.set(linkId, running.requestPage);
          scheduler.continueWake(linkId, finalTurnId, running?.request ?? null);
          store.watcherLinks.notePendingEvents(linkId, scheduler.pendingEvents(linkId), now);
        } else if (finalTurnId !== null && this.#finalPassDue(linkId, finalTurnId, settled ? outcome : "failed")) {
          scheduler.continueWake(linkId, finalTurnId);
        } else if (finalTurnId !== null) {
          this.#finalPassDone(linkId, finalTurnId);
        }
      } catch {
        // A continuation that could not be queued leaves the rest to the next check.
      }
      try {
        if (pause) {
          if (store.watcherLinks.transition(linkId, ["waking", "watching", "idle"], pause, now)) scheduler.pause(linkId);
        } else {
          this.#release(linkId, running?.restore ?? { status: "watching" }, running?.digest.turnId ?? wake.watchedTurnId);
        }
      } catch {
        // The claim is released below whatever the transition did.
      } finally {
        scheduler.wakeFinished(linkId);
      }
      try {
        this.#deps.publish(linkId);
        this.#deps.refreshConversation?.(turn.conversationId);
        this.#deps.detailChanged?.(turn.conversationId);
      } catch {
        // Publishing is best effort; the next snapshot carries the state.
      }
    }
    if (found) this.#autoDeliver(linkId, wake.wakeId, wake.watchedTurnId);
    return true;
  }

  #autoDeliver(linkId: string, wakeId: string, watchedTurnId: string | null): void {
    const { store } = this.#deps;
    const delivery = this.#deps.delivery?.();
    if (!delivery || store.watcherLinks.get(linkId)?.delivery !== "auto") return;
    const startedBy = watchedTurnId === null ? null : this.#turnUserMessage(watchedTurnId);
    if (startedBy === null || store.watcherLinks.digest.watcherNoteOrigin(startedBy) !== null) return;
    void delivery.deliver(linkId, wakeId, "queue", this.#deps.id(), true).catch(() => undefined);
  }

  #turnUserMessage(turnId: string): string | null {
    try {
      return this.#deps.store.agentTurn(turnId).userMessageId;
    } catch {
      return null;
    }
  }

  /**
   * Moves the link's coverage after a silent or finding check. A check of a
   * turn the link no longer follows keeps that turn's coverage for its final
   * pass instead of rewinding the cursor. True when the check's coverage was
   * kept, in the stored cursor or for that final pass.
   */
  #advance(linkId: string, running: RunningWake, now: string): boolean {
    const { digest } = running;
    const link = this.#deps.store.watcherLinks.advanceCursor(
      linkId, digest.cursor, digest.stats.eventsCovered, now, running.start.turnId,
    );
    if (!link) return false;
    if (link.cursor.turnId !== digest.turnId) {
      if (link.finalPassTurnId === digest.turnId) return false;
      this.#priorCursors.set(linkId, digest.turnId, digest.cursor);
    }
    if (digest.openReply) this.#openReplies.set(linkId, digest.turnId, digest.openReply);
    else this.#openReplies.delete(linkId, digest.turnId);
    return true;
  }

  dispose(): void {
    for (const running of this.#running.values()) running.window.dispose();
    this.#running.clear();
    this.#planKeys.clear();
    this.#routeFailures.clear();
    this.#dispatchFailures.clear();
    this.#priorCursors.clear();
    this.#openReplies.clear();
    this.#finalPages.clear();
    this.#finalFailures.clear();
    this.#requestPages.clear();
  }
}
