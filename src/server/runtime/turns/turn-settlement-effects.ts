import type { AgentTurn } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { TurnControllerHooks } from "./turn-controller-types";

const EFFECT_FAILURES = {
  "lifecycle-cleanup": {
    responsibility: "mandatory-lifecycle",
    message: "The agent result was saved, but local turn cleanup did not finish. Further execution remains blocked until runtime recovery.",
  },
  "terminal-persistence": {
    responsibility: "mandatory-lifecycle",
    message: "The turn could not be committed. Further execution remains blocked until runtime recovery.",
  },
  projection: {
    responsibility: "recoverable-publication",
    message: "A turn projection could not be refreshed. The saved agent result remains authoritative.",
  },
  publication: {
    responsibility: "recoverable-publication",
    message: "A turn update could not be delivered. Reconnect to load the saved result.",
  },
  metadata: {
    responsibility: "optional-metadata",
    message: "Provider metadata could not be refreshed. The saved agent result was not changed.",
  },
  artifacts: {
    responsibility: "durable-orchestration",
    message: "Repository post-processing did not finish. Pending artifacts remain owned by restart reconciliation.",
  },
  orchestration: {
    responsibility: "durable-orchestration",
    message: "Required turn follow-up did not finish. The saved result was not changed; runtime recovery reconciles unfinished work.",
  },
  "turn-follow-up": {
    responsibility: "optional-metadata",
    message: "Post-turn review information could not be recorded. Review the saved result and its recovery checkpoint.",
  },
} as const;

type SettlementEffect = keyof typeof EFFECT_FAILURES;

/** Effect failures are exact-turn diagnostics, never another terminal outcome. */
export class TurnSettlementEffects {
  private readonly reported = new Set<SettlementEffect>();

  constructor(private readonly options: {
    store: RuntimeStore;
    turn: AgentTurn;
    hooks: TurnControllerHooks;
    track(value: void | Promise<void> | undefined, onSettled: () => void): void;
  }) {}

  run(effect: SettlementEffect, operation: () => unknown): boolean {
    try {
      const result = operation();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        this.options.track(Promise.resolve(result).then(
          () => undefined,
          () => this.failed(effect),
        ), () => {
          // Publication completion must not publish itself recursively when
          // an implementation returns a promise through a void callback.
          if (effect !== "publication") {
            this.run("publication", () => this.options.hooks.broadcastSnapshot());
          }
        });
      }
      return true;
    } catch {
      this.failed(effect);
      return false;
    }
  }

  failed(effect: SettlementEffect): void {
    if (this.reported.has(effect)) return;
    this.reported.add(effect);
    const { turn, store, hooks } = this.options;
    const failure = EFFECT_FAILURES[effect];
    const detail = {
      code: "turn-post-processing-failed",
      effect,
      responsibility: failure.responsibility,
      outcome: turn.status,
      conversationId: turn.conversationId,
      runId: turn.runId,
      turnId: turn.id,
    };
    try {
      const activity = store.addActivity({
        conversationId: turn.conversationId,
        runId: turn.runId,
        turnId: turn.id,
        kind: "error",
        title: failure.message,
        detail: JSON.stringify(detail),
        status: "failed",
      });
      // Do not recurse when the failed effect is the renderer transport itself.
      try {
        void Promise.resolve(hooks.broadcast({ type: "agent.activity", activity }))
          .catch(() => undefined);
      } catch { /* Reconnection hydrates the durable diagnostic. */ }
    } catch {
      // Even a failed diagnostic write must remain visible without leaking the
      // callback's arbitrary error, prompt, output, or filesystem paths.
      console.warn("Turn post-processing diagnostic could not be persisted.", detail);
    }
  }
}
