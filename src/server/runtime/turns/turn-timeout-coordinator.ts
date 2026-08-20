import type { AgentTurnStatus } from "../../../shared/contracts";
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
}

/** Owns the silence watchdog and the independent process-lifetime fail-safe. */
export class TurnTimeoutCoordinator {
  constructor(private readonly options: TurnTimeoutCoordinatorOptions) {}

  start(active: ActiveTurn): void {
    active.lifetimeTimer = this.options.scheduler.setTimeout(() => {
      active.lifetimeTimer = null;
      if (active.settled) return;
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
    if (active.timeoutTimer !== null) {
      this.options.scheduler.clearTimeout(active.timeoutTimer);
      active.timeoutTimer = null;
    }
    if (active.settled || HUMAN_WAIT_STATUSES.has(this.options.status(active))) {
      return;
    }
    active.timeoutTimer = this.options.scheduler.setTimeout(() => {
      active.timeoutTimer = null;
      if (
        active.settled
        || HUMAN_WAIT_STATUSES.has(this.options.status(active))
      ) return;
      this.options.cancel(active);
      this.options.fail(
        active,
        "The agent stopped after a prolonged period without provider activity.",
      );
    }, this.options.inactivityMs);
  }
}
