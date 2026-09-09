import type { AgentTurnStatus } from "../../../shared/contracts";
import { randomUUID } from "node:crypto";
import type { IncidentObservation } from "../../../node/application-incidents";
import type { ActiveTurn, TurnTimerScheduler } from "./turn-controller-types";

const HUMAN_WAIT_STATUSES = new Set<AgentTurnStatus>([
  "waiting-for-approval",
  "waiting-for-input",
]);

interface TurnTimeoutCoordinatorOptions {
  readonly scheduler: TurnTimerScheduler;
  readonly inactivityMs: number;
  readonly maxLifetimeMs: number;
  readonly status: (active: ActiveTurn) => AgentTurnStatus;
  readonly cancel: (active: ActiveTurn) => void;
  readonly fail: (active: ActiveTurn, message: string) => void;
  readonly reportIncident?: (observation: IncidentObservation) => unknown;
  readonly now?: () => number;
  readonly observationMs?: number;
}

/** Owns the silence watchdog and the independent process-lifetime fail-safe. */
export class TurnTimeoutCoordinator {
  private readonly observations = new WeakMap<ActiveTurn, {
    id: string; startedAt: number; warned: boolean; timer: unknown;
  }>();
  constructor(private readonly options: TurnTimeoutCoordinatorOptions) {}

  start(active: ActiveTurn): void {
    active.lifetimeTimer = this.options.scheduler.setTimeout(() => {
      active.lifetimeTimer = null;
      if (active.runState.isTerminal()) return;
      active.diagnosticFailureCode = "turn.lifetime-timeout";
      this.options.cancel(active);
      this.options.fail(
        active,
        "The agent reached the maximum safe runtime for one turn.",
      );
    }, this.options.maxLifetimeMs);
    this.activity(active);
  }

  /** Human approval/input time does not count as provider inactivity. */
  activity(active: ActiveTurn): void {
    this.stopObservation(active, active.runState.isTerminal() || HUMAN_WAIT_STATUSES.has(this.options.status(active)) ? "ended" : "recovered");
    if (active.timeoutTimer !== null) {
      this.options.scheduler.clearTimeout(active.timeoutTimer);
      active.timeoutTimer = null;
    }
    if (active.runState.isTerminal() || HUMAN_WAIT_STATUSES.has(this.options.status(active))) {
      return;
    }
    if (this.options.reportIncident) {
      const episode = { id: "", startedAt: this.now(), warned: false, timer: null as unknown };
      this.observations.set(active, episode);
      // An observation is useful well before the six-hour safety deadline.
      // Shorter configured deadlines retain a strictly earlier observation.
      const delay = Math.max(1, Math.min(this.options.observationMs ?? 60_000, this.options.inactivityMs / 2));
      episode.timer = this.options.scheduler.setTimeout(() => {
        episode.timer = null;
        if (this.observations.get(active) !== episode || active.runState.isTerminal()
          || HUMAN_WAIT_STATUSES.has(this.options.status(active))) return;
        episode.id = randomUUID();
        episode.warned = true;
        this.observe(active, episode, "observing");
      }, delay);
    }
    active.timeoutTimer = this.options.scheduler.setTimeout(() => {
      active.timeoutTimer = null;
      if (
        active.runState.isTerminal()
        || HUMAN_WAIT_STATUSES.has(this.options.status(active))
      ) return;
      active.diagnosticFailureCode = "turn.inactivity-timeout";
      this.options.cancel(active);
      this.options.fail(
        active,
        "The agent stopped after a prolonged period without provider activity.",
      );
    }, this.options.inactivityMs);
  }

  stop(active: ActiveTurn): void { this.stopObservation(active, "ended"); }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private stopObservation(active: ActiveTurn, outcome: "ended" | "recovered"): void {
    const episode = this.observations.get(active);
    if (!episode) return;
    this.observations.delete(active);
    if (episode.timer !== null) this.options.scheduler.clearTimeout(episode.timer);
    if (episode.warned) this.observe(active, episode, outcome);
  }

  private observe(active: ActiveTurn, episode: { id: string; startedAt: number }, outcome: "observing" | "ended" | "recovered"): void {
    try {
      this.options.reportIncident?.({ id: episode.id, correlationId: active.turn.id,
        code: "turn.inactivity", outcome,
        context: { providerId: active.turn.providerId, projectId: active.conversation.projectId,
          conversationId: active.conversation.id, turnId: active.turn.id },
        metadata: { silenceMs: Math.max(0, Math.min(7 * 24 * 60 * 60 * 1_000, this.now() - episode.startedAt)) },
      });
    } catch { /* Observation must not change deadlines or cancellation. */ }
  }
}
