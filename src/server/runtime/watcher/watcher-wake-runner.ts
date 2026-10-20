import type { AgentTurn, ModelSelection } from "../../../shared/contracts";
import {
  MAX_WATCHER_FINDING_BYTES,
  type WatcherWakeOutcome,
  type WatcherWakeTrigger,
} from "../../../shared/watcher";
import type { RuntimeStore } from "../../database";
import type { WatcherTransition } from "../../persistence/watcher-link-repository";
import type { TurnController } from "../turns/turn-controller";
import type { ReadOnlyWatcherViolation } from "../turns/turn-controller-types";
import { isHeld } from "../update-hold";
import type { WatcherCheckoutGuard, WatcherGuardOutcome, WatcherGuardWindow } from "./watcher-checkout-guard";
import { buildWatcherDigest, type WatcherDigest } from "./watcher-digest";
import { watcherInstruction } from "./watcher-instructions";
import type { WatcherLiveProjection } from "./watcher-live-projection";
import { classifyWatcherReply, findingPreview } from "./watcher-outcome";
import type { WatcherRouteReadiness } from "./watcher-route";
import type { WatcherWakeAttempt, WatcherWakeContext, WatcherWakeScheduler } from "./watcher-wake-scheduler";

export const WATCHER_USAGE_LIMIT_DETAIL = "The watcher's own account reached its usage limit. It can resume once its route is ready again.";
export const WATCHER_WRITE_ATTEMPTS_DETAIL = "The watcher tried to edit files twice during one turn of the main chat.";
/** Room for a finding preview plus its trailing marker. */
const MAX_REPLY_READ_BYTES = MAX_WATCHER_FINDING_BYTES * 2;

export type WatcherRunnerTurns = Pick<TurnController, "queue" | "start" | "isActive" | "isClosing" | "cancel" | "failBeforeStart">;

export interface WatcherWakeRunnerDependencies {
  store: RuntimeStore;
  turns: WatcherRunnerTurns;
  route(selection: ModelSelection): Promise<WatcherRouteReadiness>;
  guard: Pick<WatcherCheckoutGuard, "before">;
  live: Pick<WatcherLiveProjection, "begin" | "end">;
  scheduler(): Pick<WatcherWakeScheduler, "wakeFinished" | "pause">;
  /** Republishes the link (`watcher.link.updated`). */
  publish(linkId: string): void;
  /** Refreshes the watcher chat's shell row after a check settles. */
  refreshConversation?(conversationId: string): void;
  now(): string;
  id(): string;
}

interface RunningWake {
  linkId: string;
  wakeId: string;
  watcherConversationId: string;
  window: WatcherGuardWindow;
  digest: WatcherDigest;
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
    if (!route.ready) return "transient";

    const claimed = store.watcherLinks.transition(
      linkId,
      budgetFinalPass ? ["paused"] : ["watching", "idle"],
      { status: "waking" },
      this.#deps.now(),
    );
    if (!claimed) return "skipped";
    const restore: WatcherTransition = budgetFinalPass
      ? { status: "paused", reason: "wake-budget", detail: link.pauseDetail }
      : { status: "watching" };
    const release = (attempt: WatcherWakeAttempt): WatcherWakeAttempt => {
      if (store.watcherLinks.transition(linkId, ["waking"], restore, this.#deps.now())) this.#deps.publish(linkId);
      return attempt;
    };
    let window: WatcherGuardWindow | null = null;
    try {
      if (context.final && context.watchedTurnId !== null && claimed.finalPassTurnId === context.watchedTurnId) {
        return release("skipped");
      }
      const previousPlanKey = this.#planKeys.has(linkId) ? this.#planKeys.get(linkId)! : undefined;
      const digest = buildWatcherDigest(store.watcherLinks.digest, claimed, {
        final: context.final,
        sessionFresh: watcher.providerSessionId === null,
        now: this.#deps.now(),
        watchedTitle: watched.title,
        sequence: claimed.counters.wakesTotal + 1,
        ...(previousPlanKey === undefined ? {} : { previousPlanKey }),
      });
      if (!digest) return release("skipped");
      window = await this.#deps.guard.before(watcher.id);
      const wake = store.watcherLinks.createWake({
        id: this.#deps.id(),
        linkId,
        watchedTurnId: digest.turnId,
        trigger,
        eventsCovered: digest.stats.eventsCovered,
        itemsTruncated: digest.stats.itemsTruncated,
        itemsOmitted: digest.stats.itemsOmitted,
        digestBytes: digest.stats.bytes,
        consumesAllowance: trigger !== "manual" && trigger !== "initial",
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
        store.watcherLinks.settleWake(wake.wakeId, "failed", null, null, null, this.#deps.now());
        release("transient");
        throw error;
      }
      store.watcherLinks.attachWakeTurn(wake.wakeId, queuedTurnId, this.#deps.now());
      if (context.final && context.watchedTurnId !== null) {
        store.watcherLinks.markFinalPass(linkId, context.watchedTurnId, this.#deps.now());
      }
      this.#running.set(queuedTurnId, {
        linkId, wakeId: wake.wakeId, watcherConversationId: watcher.id, window, digest, restore, violations: [], pause: null,
      });
      this.#planKeys.set(linkId, digest.planKey);
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
      const attempts = store.watcherLinks.recordAttempt(link.id, "write", this.#deps.now());
      if (attempts >= 2) pause = { status: "paused", reason: "write-attempts", detail: WATCHER_WRITE_ATTEMPTS_DETAIL };
    } else if (violation.kind === "command-attempt") {
      store.watcherLinks.recordAttempt(link.id, "command", this.#deps.now());
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

  /** Settles the check a watcher turn ran; false when the turn ran no check. */
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
    this.#deps.live.end(linkId);
    let guard: WatcherGuardOutcome | null = null;
    try {
      guard = running ? await running.window.after(turn.id) : null;
    } catch {
      guard = { state: "unavailable", paths: [], pauseDetail: null };
    }
    const usageLimited = turn.usageLimited === true || store.limitResets.usageLimited(turn.id);
    let outcome: WatcherWakeOutcome;
    let finding: string | null = null;
    if (turn.status === "cancelled") outcome = "cancelled";
    else if (usageLimited) outcome = "usage-limited";
    else if (turn.status !== "completed") outcome = "failed";
    else {
      const text = turn.terminalAssistantMessageId
        ? store.watcherLinks.digest.messageText(turn.terminalAssistantMessageId, MAX_REPLY_READ_BYTES).content
        : "";
      outcome = classifyWatcherReply(text, turn.status);
      if (outcome === "finding") finding = findingPreview(text);
    }
    const violations = running?.violations ?? [];
    const stopped = violations.some((violation) => violation.stopped);
    const override = VIOLATION_OUTCOMES.find(([kinds]) =>
      violations.some((violation) => kinds.includes(violation.kind)))?.[1];
    if (override && (stopped || outcome !== "finding")) {
      outcome = override;
      finding = null;
    }
    if (guard?.state === "changed") {
      outcome = "write-detected";
      finding = null;
    }
    const now = this.#deps.now();
    if (running && (outcome === "silent" || outcome === "finding")) {
      store.watcherLinks.advanceCursor(linkId, running.digest.cursor, running.digest.stats.eventsCovered, now);
    }
    store.watcherLinks.settleWake(
      wake.wakeId,
      outcome,
      guard ? { state: guard.state, paths: guard.paths } : null,
      finding,
      finding === null ? null : turn.terminalAssistantMessageId,
      now,
    );
    const pause: WatcherTransition | null = guard?.state === "changed"
      ? { status: "paused", reason: "write-detected", detail: guard.pauseDetail }
      : running?.pause
        ?? (usageLimited ? { status: "paused", reason: "usage-limit", detail: WATCHER_USAGE_LIMIT_DETAIL } : null);
    const next = pause ?? running?.restore ?? { status: "watching" };
    store.watcherLinks.transition(linkId, ["waking"], next, now);
    const scheduler = this.#deps.scheduler();
    if (pause) scheduler.pause(linkId);
    scheduler.wakeFinished(linkId);
    this.#deps.publish(linkId);
    this.#deps.refreshConversation?.(turn.conversationId);
    return true;
  }

  dispose(): void {
    for (const running of this.#running.values()) running.window.dispose();
    this.#running.clear();
    this.#planKeys.clear();
  }
}
