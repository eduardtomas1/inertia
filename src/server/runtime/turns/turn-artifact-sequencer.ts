import type { RuntimeStore } from "../../database";
import { recordTurnCheckpointUnavailable } from "./turn-checkpoint-notice";
import type {
  ActiveTurn,
  TurnCheckpointCapture,
  TurnControllerHooks,
} from "./turn-controller-types";
import type { TurnSettlementEffects } from "./turn-settlement-effects";

export interface TurnArtifactSequencerOptions {
  store: Pick<RuntimeStore, "addActivity">;
  hooks: TurnControllerHooks;
  barriers: Map<string, Promise<void>>;
}

/**
 * Sequences repository checkpoints per conversation without making artifact
 * materialization part of the authoritative provider lifecycle.
 */
export class TurnArtifactSequencer {
  constructor(private readonly options: TurnArtifactSequencerOptions) {}

  captureBefore(active: ActiveTurn): Promise<void> | null {
    try {
      const turnCheckpoint = this.createTurnCheckpoint(active);
      const captureGitBefore = () => this.options.hooks.captureGitBefore?.({
        turn: active.turn,
        checkpointId: active.checkpointId,
        terminalAssistantMessageId: null,
      });
      const capture = () => turnCheckpoint
        ? turnCheckpoint.then(captureGitBefore)
        : captureGitBefore();
      const priorArtifact = this.options.barriers.get(active.conversation.id);
      const value = priorArtifact
        ? priorArtifact.catch(() => undefined).then(capture)
        : capture();
      if (value && typeof (value as Promise<void>).then === "function") {
        return Promise.resolve(value).catch(() => undefined);
      }
      return null;
    } catch {
      return null;
    }
  }

  private createTurnCheckpoint(active: ActiveTurn): Promise<void> | null {
    if (!active.turnCheckpoint || active.checkpointId) return null;
    const created = this.options.hooks.createTurnCheckpoint?.(active.turn);
    if (!created) return null;
    return created
      .then((checkpoint) => this.applyTurnCheckpoint(active, checkpoint))
      .catch(() => undefined);
  }

  private applyTurnCheckpoint(
    active: ActiveTurn,
    checkpoint: TurnCheckpointCapture,
  ): void {
    active.checkpointId = checkpoint.checkpointId;
    active.checkpointFailure = checkpoint.failure;
    if (checkpoint.checkpointId) {
      this.options.hooks.broadcast({
        type: "conversation.detail.invalidated",
        conversationId: active.conversation.id,
      });
    }
    if (active.runState.isTerminal()) return;
    recordTurnCheckpointUnavailable(this.options.store, this.options.hooks, active);
  }

  finalize(active: ActiveTurn, effects: TurnSettlementEffects): void | Promise<void> {
    const finalization = this.options.hooks.captureGitArtifacts?.({
      turn: active.turn,
      checkpointId: active.checkpointId,
      terminalAssistantMessageId: active.turn.terminalAssistantMessageId,
    });
    if (!finalization) return;
    const barrier = Promise.resolve(finalization).finally(() => {
      // Retire the exact barrier even if publication fails or a later turn
      // has already installed its own artifact finalizer.
      if (this.options.barriers.get(active.conversation.id) === barrier) {
        this.options.barriers.delete(active.conversation.id);
      }
      effects.run("publication", () => this.options.hooks.broadcast({
        type: "conversation.detail.invalidated",
        conversationId: active.conversation.id,
      }));
    });
    this.options.barriers.set(active.conversation.id, barrier);
    return barrier;
  }
}
