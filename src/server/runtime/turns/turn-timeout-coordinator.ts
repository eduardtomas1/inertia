import type { AgentTurnStatus } from "../../../shared/contracts";
import { PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS } from "../../../shared/run-state";
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
  readonly suspendedMs?: (fromMs: number, toMs: number) => number;
  readonly onProviderActivity?: (active: ActiveTurn) => void;
}

/** Owns the silence watchdog and the independent process-lifetime fail-safe. */
export class TurnTimeoutCoordinator {
  private readonly observations = new WeakMap<ActiveTurn, { startedAt: number }>();
  private readonly providerActivity = new WeakMap<ActiveTurn, number>();
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
    this.publishProviderActivity(active);
    const ended = active.runState.isTerminal() || HUMAN_WAIT_STATUSES.has(this.options.status(active));
    this.stopObservation(active, ended ? "ended" : "recovered");
    if (active.timeoutTimer !== null) {
      this.options.scheduler.clearTimeout(active.timeoutTimer);
      active.timeoutTimer = null;
    }
    if (ended) {
      return;
    }
    if (this.options.reportIncident) this.observations.set(active, { startedAt: this.now() });
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

  stop(active: ActiveTurn): void {
    this.stopObservation(active, "ended");
    this.providerActivity.delete(active);
  }

  restampProviderActivity(active: ActiveTurn): void {
    if (!this.providerActivity.has(active)) return;
    this.providerActivity.set(active, this.now());
    this.options.onProviderActivity?.(active);
  }

  providerActivityAt(active: ActiveTurn): number | null {
    return this.providerActivity.get(active) ?? null;
  }

  private publishProviderActivity(active: ActiveTurn): void {
    const now = this.now();
    const published = this.providerActivity.get(active);
    if (published !== undefined && now - published < PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS) return;
    this.providerActivity.set(active, now);
    this.options.onProviderActivity?.(active);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private stopObservation(active: ActiveTurn, outcome: "ended" | "recovered"): void {
    const episode = this.observations.get(active);
    if (!episode) return;
    this.observations.delete(active);
    const threshold = Math.max(1, Math.min(this.options.observationMs ?? 600_000, this.options.inactivityMs / 2));
    const endedAt = this.now();
    if (endedAt - episode.startedAt < threshold) return;
    try {
      const silenceMs = endedAt - episode.startedAt - Math.max(0, this.options.suspendedMs?.(episode.startedAt, endedAt) ?? 0);
      if (silenceMs < threshold) return;
      this.options.reportIncident?.({ id: randomUUID(), correlationId: active.turn.id,
        code: "turn.inactivity", outcome,
        context: { providerId: active.turn.providerId, projectId: active.conversation.projectId,
          conversationId: active.conversation.id, turnId: active.turn.id },
        metadata: { silenceMs: Math.min(7 * 24 * 60 * 60 * 1_000, silenceMs) },
      });
    } catch { /* Observation must not change deadlines or cancellation. */ }
  }
}
