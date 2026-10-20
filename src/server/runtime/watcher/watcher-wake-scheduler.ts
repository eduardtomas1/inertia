import type { AgentActivity, RuntimeMutationEvent } from "../../../shared/contracts";
import {
  WATCHER_BUDGET_LIMITS,
  type WatcherWakeTrigger,
} from "../../../shared/watcher";
import type { DeltaTimerScheduler } from "../turns/turn-stream-coalescer";

export const WATCHER_SETTLE_DELAY_MS = 2_000;
export const WATCHER_STALL_TICK_MS = 60_000;
export const WATCHER_QUIET_AFTER_MS = 10 * 60_000;
export const WATCHER_RETRY_BASE_MS = 5_000;
export const WATCHER_RETRY_MAX_MS = 120_000;
/** How often a wake that is due re-checks a busy watcher or a deferral. */
export const WATCHER_RECHECK_MS = 5_000;
export const WATCHER_ACCUMULATE_MIN = 6;
export const WATCHER_ACCUMULATE_AGE_COOLDOWNS = 3;
export const WATCHER_SPACING_MAX_COOLDOWNS = 10;

/**
 * What `onWake` reports back:
 * - `started`: a check began; call `wakeFinished` once it settles.
 * - `skipped`: nothing to check (no new digest, link gone); the events are dropped.
 * - `transient`: the runtime is held, closing or has no route; retried with backoff.
 * - `paused`: the attempt paused the link; its final pass stays due until `resume`.
 */
export type WatcherWakeAttempt = "started" | "skipped" | "transient" | "paused";

export interface WatcherWakeContext {
  /** True for the final pass after the watched turn ended. */
  final: boolean;
  watchedTurnId: string | null;
  /** Observed events this wake covers. */
  events: number;
  continued: boolean;
}

export interface WatcherWakeSchedulerDependencies {
  /** Compatible with `TurnTimerScheduler`, so tests can use `FakeTurnScheduler`. */
  scheduler: DeltaTimerScheduler;
  /** Milliseconds since the epoch. */
  clock: () => number;
  onWake(
    linkId: string,
    trigger: WatcherWakeTrigger,
    context: WatcherWakeContext,
  ): WatcherWakeAttempt | Promise<WatcherWakeAttempt>;
  onQuiet(linkId: string): void;
  /** The watcher conversation already has a turn in flight. */
  isBusy(linkId: string): boolean;
  /** Wakes left in the watched turn, counting the unit reserved for the final pass. */
  allowance(linkId: string): number;
  /** Mid-turn wakes ran out; called once per watched turn until `resume`. */
  onBudgetExhausted?(linkId: string): void;
  /**
   * The pending-event count changed outside `observe`: a wake consumed it, or
   * a transient attempt put it back. The scheduler is its only source.
   */
  onPendingChanged?(linkId: string): void;
  cooldownMs?(linkId: string): number;
  onError?(linkId: string, error: unknown): void;
  settleDelayMs?: number;
  stallTickMs?: number;
  quietAfterMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  recheckMs?: number;
}

export interface WatcherTrackOptions {
  watchedTurnId?: string | null;
  watchedRunning?: boolean;
  /** Last watched output in epoch milliseconds; defaults to now. */
  lastOutputAt?: number;
}

type ActivityTrigger = Extract<WatcherWakeTrigger, "activity" | "plan" | "error">;
type RequestTrigger = Extract<WatcherWakeTrigger, "manual" | "initial">;

const TRIGGER_RANK: Readonly<Record<ActivityTrigger, number>> = { plan: 1, activity: 2, error: 3 };
const SETTLED_KINDS: ReadonlySet<AgentActivity["kind"]> = new Set(["tool", "command", "file", "error"]);
const ACCUMULATING_KINDS: ReadonlySet<AgentActivity["kind"]> = new Set(["tool", "command"]);
/** Final passes kept per link: the ended turn's and the one after it. */
export const WATCHER_MAX_PENDING_FINALS = 2;
const MAX_DONE_FINALS = 4;
const OUTPUT_EVENTS: ReadonlySet<RuntimeMutationEvent["type"]> = new Set([
  "agent.started", "agent.text", "agent.text.replaced", "agent.reasoning", "agent.commentary.persisted",
  "agent.activity", "agent.plan.updated", "agent.subagent.updated",
]);

interface LinkState {
  pending: number;
  firstPendingAt: number | null;
  trigger: ActivityTrigger | null;
  immediate: boolean;
  request: RequestTrigger | null;
  requestContinues: boolean;
  /** A settled check left activity of its watched turn unread; another check follows without new events. */
  continuation: boolean;
  /** Final passes still due, oldest first; a new watched turn never erases one. */
  finals: FinalPass[];
  finalDoneTurnIds: string[];
  watchedTurnId: string | null;
  watchedRunning: boolean;
  turnStartedAt: number;
  lastWakeEndAt: number | null;
  inFlight: boolean;
  paused: { finalPass: boolean } | null;
  defer: (() => boolean) | null;
  retryAttempt: number;
  retryAt: number | null;
  wakeTimer: unknown;
  lastOutputAt: number;
  quiet: boolean;
  stallTimer: unknown;
  budgetNotified: boolean;
}

interface FinalPass {
  turnId: string;
  requestedAt: number;
}

interface Consumed {
  kind: "final" | "request" | "pending";
  pending: number;
  firstPendingAt: number | null;
  trigger: ActivityTrigger | null;
  immediate: boolean;
  request: RequestTrigger | null;
  requestContinues: boolean;
  continuation: boolean;
  final: FinalPass | null;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Decides when a watcher wakes. It counts only settled watched events,
 * coalesces them, honours the cooldown and a short settle delay, keeps the
 * last wake of each watched turn for the final pass, waits while the watcher
 * is busy or the user's own watcher turn runs, retries transient failures and
 * marks the watched chat quiet after ten minutes without output. It never
 * talks to a model or the database; everything goes through injected callbacks.
 */
export class WatcherWakeScheduler {
  readonly #deps: WatcherWakeSchedulerDependencies;
  readonly #links = new Map<string, LinkState>();
  readonly #settleDelayMs: number;
  readonly #stallTickMs: number;
  readonly #quietAfterMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #recheckMs: number;
  #disposed = false;

  constructor(dependencies: WatcherWakeSchedulerDependencies) {
    this.#deps = dependencies;
    this.#settleDelayMs = dependencies.settleDelayMs ?? WATCHER_SETTLE_DELAY_MS;
    this.#stallTickMs = dependencies.stallTickMs ?? WATCHER_STALL_TICK_MS;
    this.#quietAfterMs = dependencies.quietAfterMs ?? WATCHER_QUIET_AFTER_MS;
    this.#retryBaseMs = dependencies.retryBaseMs ?? WATCHER_RETRY_BASE_MS;
    this.#retryMaxMs = dependencies.retryMaxMs ?? WATCHER_RETRY_MAX_MS;
    this.#recheckMs = dependencies.recheckMs ?? WATCHER_RECHECK_MS;
  }

  /** Registers a link, for example after attach or restart, with its watched turn state. */
  track(linkId: string, options: WatcherTrackOptions = {}): void {
    const state = this.#state(linkId);
    if (!state) return;
    if (options.watchedTurnId !== undefined) state.watchedTurnId = options.watchedTurnId;
    if (options.watchedRunning !== undefined) state.watchedRunning = options.watchedRunning;
    state.lastOutputAt = options.lastOutputAt ?? this.#deps.clock();
    if (state.watchedRunning) this.#startStall(linkId, state);
    else this.#stopStall(state);
  }

  /**
   * Feeds one runtime event of the watched conversation. Returns true when
   * the event counts toward a wake. Text and reasoning only refresh the
   * quiet marker.
   */
  observe(linkId: string, event: RuntimeMutationEvent): boolean {
    const state = this.#state(linkId);
    if (!state) return false;
    if (!OUTPUT_EVENTS.has(event.type)) return false;
    const now = this.#deps.clock();
    state.lastOutputAt = now;
    state.quiet = false;
    let trigger: ActivityTrigger | null = null;
    let accumulating = false;
    if (event.type === "agent.started") {
      if (event.turnId !== state.watchedTurnId) {
        state.watchedTurnId = event.turnId;
        state.turnStartedAt = now;
        state.budgetNotified = false;
      }
      state.watchedRunning = true;
      trigger = "activity";
    } else if (event.type === "agent.activity") {
      const { activity } = event;
      if (activity.status !== "running" && SETTLED_KINDS.has(activity.kind)) {
        trigger = activity.kind === "error" || activity.status === "failed" ? "error" : "activity";
        accumulating = trigger === "activity" && ACCUMULATING_KINDS.has(activity.kind);
      }
    } else if (event.type === "agent.plan.updated") {
      trigger = "plan";
    }
    if (state.watchedRunning) this.#startStall(linkId, state);
    if (!trigger) return false;
    state.pending += 1;
    state.firstPendingAt ??= now;
    state.immediate ||= !accumulating;
    if (!state.trigger || TRIGGER_RANK[trigger] > TRIGGER_RANK[state.trigger]) state.trigger = trigger;
    this.#schedule(linkId, state);
    return true;
  }

  /** The watched turn ended; schedules its final pass once. */
  onWatchedTurnSettled(linkId: string, turnId: string): void {
    const state = this.#state(linkId);
    if (!state) return;
    if (state.watchedTurnId === null || state.watchedTurnId === turnId) {
      state.watchedTurnId = turnId;
      state.watchedRunning = false;
      this.#stopStall(state);
    }
    if (state.finalDoneTurnIds.includes(turnId) || state.finals.some((final) => final.turnId === turnId)) return;
    state.finals.push({ turnId, requestedAt: this.#deps.clock() });
    if (state.finals.length > WATCHER_MAX_PENDING_FINALS) {
      state.finals.splice(0, state.finals.length - WATCHER_MAX_PENDING_FINALS);
    }
    this.#schedule(linkId, state);
  }

  /** "Check now" or the initial review: skips the settle delay, cooldown and budget gate. */
  requestWake(linkId: string, trigger: RequestTrigger): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.request = trigger;
    state.requestContinues = false;
    state.retryAt = null;
    this.#schedule(linkId, state);
  }

  /**
   * A settled check read only the first page of what waits. Without a final
   * turn, another mid-turn check follows with no new events, after the
   * cooldown and within the allowance like any automatic check; the next page
   * of a request stays that request. With a final turn, the final pass of
   * that turn is due again, so its remaining pages drain.
   */
  continueWake(linkId: string, finalTurnId: string | null, request: RequestTrigger | null = null): void {
    const state = this.#state(linkId);
    if (!state) return;
    if (finalTurnId === null && request !== null) {
      if (state.request === null) {
        state.request = request;
        state.requestContinues = true;
      }
    } else if (finalTurnId === null) {
      state.continuation = true;
    } else if (!state.finals.some(({ turnId }) => turnId === finalTurnId)) {
      state.finals.unshift({ turnId: finalTurnId, requestedAt: this.#deps.clock() });
      state.finalDoneTurnIds = state.finalDoneTurnIds.filter((turnId) => turnId !== finalTurnId);
    }
    this.#schedule(linkId, state);
  }

  /** Holds due wakes while `predicate` is true, for example while the user's own watcher turn runs. */
  deferWhile(linkId: string, predicate: (() => boolean) | null): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.defer = predicate;
    this.#schedule(linkId, state);
  }

  /** A started check settled; the cooldown starts now. */
  wakeFinished(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state || this.#disposed) return;
    state.inFlight = false;
    state.lastWakeEndAt = this.#deps.clock();
    this.#schedule(linkId, state);
  }

  /** Re-evaluates a link, for example after the user's own watcher turn ended. */
  poke(linkId: string): void {
    const state = this.#links.get(linkId);
    if (state && !this.#disposed) this.#schedule(linkId, state);
  }

  /** Stops new wakes. With `finalPass`, the final pass still runs (budget pauses). */
  pause(linkId: string, options: { finalPass?: boolean } = {}): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.paused = { finalPass: options.finalPass === true };
    this.#schedule(linkId, state);
  }

  /** Resumes wakes; a resume after budget exhaustion follows a new grant. */
  resume(linkId: string): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.paused = null;
    state.budgetNotified = false;
    state.retryAttempt = 0;
    state.retryAt = null;
    this.#schedule(linkId, state);
  }

  /** Observed events waiting for the next wake. */
  pendingEvents(linkId: string): number {
    return this.#links.get(linkId)?.pending ?? 0;
  }

  forget(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state) return;
    this.#clearWake(state);
    this.#stopStall(state);
    this.#links.delete(linkId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const linkId of this.#links.keys()) this.forget(linkId);
  }

  #state(linkId: string): LinkState | null {
    if (this.#disposed) return null;
    let state = this.#links.get(linkId);
    if (!state) {
      state = {
        pending: 0,
        firstPendingAt: null,
        trigger: null,
        immediate: false,
        request: null,
        requestContinues: false,
        continuation: false,
        finals: [],
        finalDoneTurnIds: [],
        watchedTurnId: null,
        watchedRunning: false,
        turnStartedAt: this.#deps.clock(),
        lastWakeEndAt: null,
        inFlight: false,
        paused: null,
        defer: null,
        retryAttempt: 0,
        retryAt: null,
        wakeTimer: null,
        lastOutputAt: this.#deps.clock(),
        quiet: false,
        stallTimer: null,
        budgetNotified: false,
      };
      this.#links.set(linkId, state);
    }
    return state;
  }

  #cooldown(linkId: string): number {
    const value = this.#deps.cooldownMs?.(linkId);
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : WATCHER_BUDGET_LIMITS.cooldownSeconds.default * 1_000;
  }

  #cooldownEnd(linkId: string, state: LinkState): number {
    if (state.lastWakeEndAt === null) return 0;
    const cooldown = this.#cooldown(linkId);
    const checksLeft = this.#deps.allowance(linkId) - 1;
    if (checksLeft < 1) return state.lastWakeEndAt + cooldown;
    const spread = Math.ceil(Math.max(0, state.lastWakeEndAt - state.turnStartedAt) / checksLeft);
    return state.lastWakeEndAt + Math.min(WATCHER_SPACING_MAX_COOLDOWNS * cooldown, Math.max(cooldown, spread));
  }

  /** The next wake to run and when it is due, ignoring busy and deferral. */
  #next(linkId: string, state: LinkState): { kind: Consumed["kind"]; at: number } | null {
    const final = state.finals[0];
    if (final && (!state.paused || state.paused.finalPass)) {
      return { kind: "final", at: Math.max(final.requestedAt + this.#settleDelayMs, state.retryAt ?? 0) };
    }
    if (state.paused) return null;
    if (state.request) return { kind: "request", at: Math.max(this.#deps.clock(), state.retryAt ?? 0) };
    const waiting = state.pending > 0 && state.firstPendingAt !== null;
    if (!waiting && !state.continuation) return null;
    const cooldownEnd = this.#cooldownEnd(linkId, state);
    const settledAt = waiting && state.firstPendingAt !== null ? state.firstPendingAt + this.#settleDelayMs : 0;
    const gatheredAt = !waiting || state.firstPendingAt === null || state.immediate || state.continuation
      || state.pending >= WATCHER_ACCUMULATE_MIN
      ? 0
      : state.firstPendingAt + WATCHER_ACCUMULATE_AGE_COOLDOWNS * this.#cooldown(linkId);
    return { kind: "pending", at: Math.max(cooldownEnd, settledAt, gatheredAt, state.retryAt ?? 0) };
  }

  #clearWake(state: LinkState): void {
    if (state.wakeTimer !== null) this.#deps.scheduler.clearTimeout(state.wakeTimer);
    state.wakeTimer = null;
  }

  #schedule(linkId: string, state: LinkState, at?: number): void {
    this.#clearWake(state);
    if (this.#disposed || state.inFlight) return;
    const due = at ?? this.#next(linkId, state)?.at;
    if (due === undefined) return;
    const delay = Math.max(0, due - this.#deps.clock());
    state.wakeTimer = this.#deps.scheduler.setTimeout(() => this.#fire(linkId), delay);
  }

  #fire(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state || this.#disposed) return;
    state.wakeTimer = null;
    if (state.inFlight) return;
    const next = this.#next(linkId, state);
    if (!next) return;
    const now = this.#deps.clock();
    if (now < next.at) {
      this.#schedule(linkId, state, next.at);
      return;
    }
    if (this.#deps.isBusy(linkId) || state.defer?.() === true) {
      this.#schedule(linkId, state, now + this.#recheckMs);
      return;
    }
    if (next.kind === "pending" && this.#deps.allowance(linkId) <= 1) {
      if (!state.budgetNotified) {
        state.budgetNotified = true;
        this.#deps.onBudgetExhausted?.(linkId);
      }
      return;
    }
    this.#run(linkId, state, next.kind);
  }

  #run(linkId: string, state: LinkState, kind: Consumed["kind"]): void {
    const final = kind === "final" ? state.finals.shift() ?? null : null;
    const consumed: Consumed = {
      kind,
      pending: state.pending,
      firstPendingAt: state.firstPendingAt,
      trigger: state.trigger,
      immediate: state.immediate,
      request: state.request,
      requestContinues: kind === "request" && state.requestContinues,
      continuation: kind !== "final" && state.continuation,
      final,
    };
    const trigger: WatcherWakeTrigger = kind === "final"
      ? "turn-end"
      : kind === "request" ? state.request ?? "manual" : state.trigger ?? "activity";
    const context: WatcherWakeContext = {
      final: kind === "final",
      watchedTurnId: kind === "final" ? final?.turnId ?? null : state.watchedTurnId,
      events: state.pending,
      continued: consumed.requestContinues,
    };
    state.pending = 0;
    state.firstPendingAt = null;
    state.trigger = null;
    state.immediate = false;
    state.request = null;
    state.requestContinues = false;
    if (consumed.continuation) state.continuation = false;
    if (final) {
      state.finalDoneTurnIds.push(final.turnId);
      if (state.finalDoneTurnIds.length > MAX_DONE_FINALS) state.finalDoneTurnIds.shift();
    }
    state.inFlight = true;
    if (consumed.pending > 0) this.#deps.onPendingChanged?.(linkId);
    let result: WatcherWakeAttempt | Promise<WatcherWakeAttempt>;
    try {
      result = this.#deps.onWake(linkId, trigger, context);
    } catch (error) {
      this.#settleAttempt(linkId, state, consumed, "transient", error);
      return;
    }
    if (isPromiseLike(result)) {
      void result.then(
        (attempt) => this.#settleAttempt(linkId, state, consumed, attempt),
        (error: unknown) => this.#settleAttempt(linkId, state, consumed, "transient", error),
      );
    } else {
      this.#settleAttempt(linkId, state, consumed, result);
    }
  }

  #settleAttempt(
    linkId: string,
    state: LinkState,
    consumed: Consumed,
    attempt: WatcherWakeAttempt,
    error?: unknown,
  ): void {
    if (this.#disposed || this.#links.get(linkId) !== state) return;
    if (error !== undefined) this.#deps.onError?.(linkId, error);
    if (attempt === "started") {
      state.retryAttempt = 0;
      state.retryAt = null;
      return;
    }
    state.inFlight = false;
    if (attempt === "transient" || attempt === "paused") this.#restoreFinal(state, consumed.final);
    if (attempt === "transient") {
      state.pending += consumed.pending;
      if (consumed.firstPendingAt !== null) {
        state.firstPendingAt = Math.min(state.firstPendingAt ?? consumed.firstPendingAt, consumed.firstPendingAt);
      }
      if (consumed.trigger && (!state.trigger || TRIGGER_RANK[consumed.trigger] > TRIGGER_RANK[state.trigger])) {
        state.trigger = consumed.trigger;
      }
      state.immediate ||= consumed.immediate;
      if (state.request === null && consumed.request !== null) {
        state.request = consumed.request;
        state.requestContinues = consumed.requestContinues;
      }
      state.continuation ||= consumed.continuation;
      if (consumed.pending > 0) this.#deps.onPendingChanged?.(linkId);
      state.retryAttempt += 1;
      const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** (state.retryAttempt - 1));
      state.retryAt = this.#deps.clock() + delay;
    } else {
      state.retryAttempt = 0;
      state.retryAt = null;
    }
    this.#schedule(linkId, state);
  }

  #restoreFinal(state: LinkState, final: FinalPass | null): void {
    if (!final || state.finals.some(({ turnId }) => turnId === final.turnId)) return;
    state.finals.unshift(final);
    state.finalDoneTurnIds = state.finalDoneTurnIds.filter((turnId) => turnId !== final.turnId);
  }

  #startStall(linkId: string, state: LinkState): void {
    if (state.stallTimer !== null || this.#disposed) return;
    state.stallTimer = this.#deps.scheduler.setTimeout(() => this.#stallTick(linkId), this.#stallTickMs);
  }

  #stopStall(state: LinkState): void {
    if (state.stallTimer !== null) this.#deps.scheduler.clearTimeout(state.stallTimer);
    state.stallTimer = null;
  }

  #stallTick(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state || this.#disposed) return;
    state.stallTimer = null;
    if (!state.watchedRunning || state.quiet) return;
    if (this.#deps.clock() - state.lastOutputAt >= this.#quietAfterMs) {
      state.quiet = true;
      this.#deps.onQuiet(linkId);
      return;
    }
    this.#startStall(linkId, state);
  }
}
