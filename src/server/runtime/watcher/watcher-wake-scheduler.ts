import type { AgentActivity, RuntimeMutationEvent } from "../../../shared/contracts";
import {
  WATCHER_BUDGET_LIMITS,
  type WatcherWakeTrigger,
} from "../../../shared/watcher";
import type { DeltaTimerScheduler } from "../turns/turn-stream-coalescer";
import { WATCHER_EVENT_KINDS } from "./watcher-digest";

export const WATCHER_SETTLE_DELAY_MS = 2_000;
export const WATCHER_STALL_TICK_MS = 60_000;
export const WATCHER_QUIET_AFTER_MS = 10 * 60_000;
export const WATCHER_RETRY_BASE_MS = 5_000;
export const WATCHER_RETRY_MAX_MS = 120_000;
export const WATCHER_RECHECK_MS = 5_000;
export const WATCHER_ACCUMULATE_MIN = 6;
export const WATCHER_ACCUMULATE_AGE_COOLDOWNS = 3;
export const WATCHER_SPACING_MAX_COOLDOWNS = 10;

export type WatcherWakeAttempt = "started" | "skipped" | "transient" | "paused";

export interface WatcherWakeContext {
  final: boolean;
  watchedTurnId: string | null;
  events: number;
  continued: boolean;
}

export interface WatcherWakeSchedulerDependencies {
  scheduler: DeltaTimerScheduler;
  clock: () => number;
  onWake(
    linkId: string,
    trigger: WatcherWakeTrigger,
    context: WatcherWakeContext,
  ): WatcherWakeAttempt | Promise<WatcherWakeAttempt>;
  onQuiet(linkId: string): void;
  isBusy(linkId: string): boolean;
  allowance(linkId: string): number;
  onBudgetExhausted?(linkId: string): void;
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

interface WatcherTrackOptions {
  watchedTurnId?: string | null;
  watchedRunning?: boolean;
  lastOutputAt?: number;
}

type ActivityTrigger = Extract<WatcherWakeTrigger, "activity" | "plan" | "error">;
type RequestTrigger = Extract<WatcherWakeTrigger, "manual" | "initial">;

const TRIGGER_RANK: Readonly<Record<ActivityTrigger, number>> = { plan: 1, activity: 2, error: 3 };
const ACCUMULATING_KINDS: ReadonlySet<AgentActivity["kind"]> = new Set(["tool", "command"]);
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
  continuation: boolean;
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

  track(linkId: string, options: WatcherTrackOptions = {}): void {
    const state = this.#state(linkId);
    if (!state) return;
    if (options.watchedTurnId !== undefined) state.watchedTurnId = options.watchedTurnId;
    if (options.watchedRunning !== undefined) state.watchedRunning = options.watchedRunning;
    state.lastOutputAt = options.lastOutputAt ?? this.#deps.clock();
    if (state.watchedRunning) this.#startStall(linkId, state);
    else this.#stopStall(state);
  }

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
      if (activity.status !== "running" && WATCHER_EVENT_KINDS.has(activity.kind)) {
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

  requestWake(linkId: string, trigger: RequestTrigger): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.request = trigger;
    state.requestContinues = false;
    state.retryAt = null;
    this.#schedule(linkId, state);
  }

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

  deferWhile(linkId: string, predicate: (() => boolean) | null): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.defer = predicate;
    this.#schedule(linkId, state);
  }

  wakeFinished(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state || this.#disposed) return;
    state.inFlight = false;
    state.lastWakeEndAt = this.#deps.clock();
    this.#schedule(linkId, state);
  }

  poke(linkId: string): void {
    const state = this.#links.get(linkId);
    if (state && !this.#disposed) this.#schedule(linkId, state);
  }

  pause(linkId: string, options: { finalPass?: boolean } = {}): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.paused = { finalPass: options.finalPass === true };
    this.#schedule(linkId, state);
  }

  resume(linkId: string): void {
    const state = this.#state(linkId);
    if (!state) return;
    state.paused = null;
    state.budgetNotified = false;
    state.retryAttempt = 0;
    state.retryAt = null;
    this.#schedule(linkId, state);
  }

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
