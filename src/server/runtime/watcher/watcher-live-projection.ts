import { activityExecutionCategory, hostToolActivityTitle } from "../../../shared/activity-display";
import { clipCodeUnits } from "../../../shared/code-units";
import type { AgentActivity, RuntimeMutationEvent } from "../../../shared/contracts";
import {
  MAX_WATCHER_LIVE_LABEL_CHARS,
  type WatcherLivePhase,
} from "../../../shared/watcher";
import type { DeltaTimerScheduler } from "../turns/turn-stream-coalescer";
import { neutralizeUntrustedAgentText } from "../untrusted-agent-text";

const WATCHER_LIVE_INTERVAL_MS = 750;

type WatcherLiveEvent = Extract<RuntimeMutationEvent, { type: "watcher.live" }>;

interface WatcherLiveProjectionDependencies {
  scheduler: DeltaTimerScheduler;
  clock: () => number;
  broadcast(event: WatcherLiveEvent): void;
  intervalMs?: number;
}

interface LiveState {
  watcherConversationId: string;
  turnId: string;
  lastKey: string | null;
  lastAt: number;
  pending: WatcherLiveEvent | null;
  timer: unknown;
}

const PHASES: Readonly<Record<ReturnType<typeof activityExecutionCategory>, WatcherLivePhase>> = {
  searching: "searching",
  coding: "writing",
  command: "reading",
  reasoning: "thinking",
  tool: "reading",
  attention: "thinking",
};

export function watcherLiveLabel(activity: Pick<AgentActivity, "kind" | "title" | "status">): string | null {
  const raw = hostToolActivityTitle(activity) ?? activity.title;
  let flattened = "";
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    flattened += code < 0x20 || code === 0x7f ? " " : character;
  }
  const line = neutralizeUntrustedAgentText(flattened.replace(/\s+/gu, " ").trim());
  if (line.length === 0) return null;
  return line.length <= MAX_WATCHER_LIVE_LABEL_CHARS ? line : `${clipCodeUnits(line, MAX_WATCHER_LIVE_LABEL_CHARS - 1)}…`;
}

export class WatcherLiveProjection {
  readonly #deps: WatcherLiveProjectionDependencies;
  readonly #intervalMs: number;
  readonly #links = new Map<string, LiveState>();

  constructor(dependencies: WatcherLiveProjectionDependencies) {
    this.#deps = dependencies;
    this.#intervalMs = dependencies.intervalMs ?? WATCHER_LIVE_INTERVAL_MS;
  }

  begin(linkId: string, watcherConversationId: string, turnId: string): void {
    this.end(linkId);
    this.#links.set(linkId, {
      watcherConversationId, turnId, lastKey: null, lastAt: Number.NEGATIVE_INFINITY, pending: null, timer: null,
    });
    this.#offer(linkId, "starting", null);
  }

  observe(linkId: string, activity: AgentActivity): void {
    const state = this.#links.get(linkId);
    if (!state || activity.turnId !== state.turnId || activity.conversationId !== state.watcherConversationId) return;
    const phase = PHASES[activityExecutionCategory(activity)];
    this.#offer(linkId, phase, watcherLiveLabel(activity));
  }

  end(linkId: string): void {
    const state = this.#links.get(linkId);
    if (!state) return;
    if (state.timer !== null) this.#deps.scheduler.clearTimeout(state.timer);
    this.#links.delete(linkId);
  }

  dispose(): void {
    for (const linkId of this.#links.keys()) this.end(linkId);
  }

  #offer(linkId: string, phase: WatcherLivePhase, label: string | null): void {
    const state = this.#links.get(linkId)!;
    const key = `${phase}\u0000${label ?? ""}`;
    if (key === state.lastKey && state.pending === null) return;
    const now = this.#deps.clock();
    const event: WatcherLiveEvent = {
      type: "watcher.live",
      linkId,
      watcherConversationId: state.watcherConversationId,
      turnId: state.turnId,
      phase,
      label,
      at: new Date(now).toISOString(),
    };
    if (now - state.lastAt >= this.#intervalMs && state.timer === null) {
      this.#emit(state, event, key, now);
      return;
    }
    state.pending = key === state.lastKey ? null : event;
    if (state.pending === null || state.timer !== null) return;
    state.timer = this.#deps.scheduler.setTimeout(() => {
      state.timer = null;
      if (this.#links.get(linkId) !== state || state.pending === null) return;
      const pending = state.pending;
      state.pending = null;
      this.#emit(state, { ...pending, at: new Date(this.#deps.clock()).toISOString() },
        `${pending.phase}\u0000${pending.label ?? ""}`, this.#deps.clock());
    }, Math.max(0, state.lastAt + this.#intervalMs - now));
  }

  #emit(state: LiveState, event: WatcherLiveEvent, key: string, now: number): void {
    state.lastKey = key;
    state.lastAt = now;
    try {
      this.#deps.broadcast(event);
    } catch {
    }
  }
}
