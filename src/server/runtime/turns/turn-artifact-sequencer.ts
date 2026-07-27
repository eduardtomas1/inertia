import type {
  ActiveTurn,
  TurnControllerHooks,
} from "./turn-controller-types";

export interface TurnArtifactSequencerOptions {
  hooks: TurnControllerHooks;
  barriers: Map<string, Promise<void>>;
  track(value: void | Promise<void> | undefined): void;
}

/**
 * Sequences repository checkpoints per conversation without making artifact
 * materialization part of the authoritative provider lifecycle.
 */
export class TurnArtifactSequencer {
  constructor(private readonly options: TurnArtifactSequencerOptions) {}

  captureBefore(active: ActiveTurn): Promise<void> | null {
    try {
      const capture = () => this.options.hooks.captureGitBefore?.({
        turn: active.turn,
        checkpointId: active.checkpointId,
        terminalAssistantMessageId: null,
      });
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

  finalize(active: ActiveTurn): void {
    try {
      const artifactFinalization =
        this.options.hooks.captureGitArtifacts?.({
          turn: active.turn,
          checkpointId: active.checkpointId,
          terminalAssistantMessageId: active.latestAssistantMessageId,
        });
      if (
        !artifactFinalization
        || typeof (artifactFinalization as Promise<void>).then !== "function"
      ) {
        return;
      }
      const barrier = Promise.resolve(artifactFinalization)
        .catch(() => undefined)
        .finally(() => {
          if (
            this.options.barriers.get(active.conversation.id) === barrier
          ) {
            this.options.barriers.delete(active.conversation.id);
          }
        });
      this.options.barriers.set(active.conversation.id, barrier);
      this.options.track(barrier);
    } catch {
      // Restart reconciliation owns a pending artifact after sync failure.
    }
  }
}
