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
  readonly #checkpoints = new Map<string, Promise<void>>();
  readonly #checkpointStops = new Map<string, AbortController>();

  constructor(private readonly options: TurnArtifactSequencerOptions) {}

  captureBefore(active: ActiveTurn): Promise<void> | null {
    try {
      const priorCheckpoint = this.#checkpoints.get(active.conversation.id) ?? null;
      const turnCheckpoint = this.createTurnCheckpoint(active, priorCheckpoint)
        ?? priorCheckpoint;
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

  private createTurnCheckpoint(
    active: ActiveTurn,
    priorCheckpoint: Promise<void> | null,
  ): Promise<void> | null {
    const create = this.options.hooks.createTurnCheckpoint;
    if (!create || !active.turnCheckpoint || active.checkpointId) return null;
    const stop = new AbortController();
    const start = async (): Promise<void> => {
      if (stop.signal.aborted || active.runState.isTerminal()) return;
      this.applyTurnCheckpoint(active, await create(active.turn, stop.signal));
    };
    const checkpoint: Promise<void> = (priorCheckpoint ? priorCheckpoint.then(start) : start())
      .catch(() => undefined)
      .finally(() => {
        if (this.#checkpoints.get(active.conversation.id) === checkpoint) {
          this.#checkpoints.delete(active.conversation.id);
        }
        this.#checkpointStops.delete(active.turn.id);
      });
    this.#checkpoints.set(active.conversation.id, checkpoint);
    this.#checkpointStops.set(active.turn.id, stop);
    return checkpoint;
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
    this.#checkpointStops.get(active.turn.id)?.abort();
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
