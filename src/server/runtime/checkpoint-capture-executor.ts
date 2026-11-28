import type { AgentTurn } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import {
  CHECKPOINT_CAPTURE_EFFECT_KIND,
  type OrchestrationEffectRuntime,
} from "../orchestration-v2/effect-runtime";
import type { TurnGitArtifactManager } from "../turn-git-artifacts";

export interface CheckpointCaptureAfterContext {
  readonly conversationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly turn: AgentTurn;
}

export interface CheckpointCaptureExecutorDependencies {
  readonly effects: Pick<OrchestrationEffectRuntime, "register">;
  readonly store: Pick<RuntimeStore, "agentTurn">;
  readonly artifacts: Pick<TurnGitArtifactManager, "finalize">;
  readonly invalidate: (conversationId: string) => void;
  /**
   * Optional D.6 post-capture hook (e.g. `delegation.recover` / bookkeeping
   * retry after checkpoint finalization, T3 `7462f234e`). Errors are bounded
   * and isolated so they never prevent checkpoint settlement.
   */
  readonly onAfterCapture?: (context: CheckpointCaptureAfterContext) => Promise<void> | void;
  readonly retryDelegatedBookkeeping?: (context: CheckpointCaptureAfterContext) => Promise<void> | void;
  readonly onAfterCaptureError?: (error: unknown, context: CheckpointCaptureAfterContext) => void;
}

async function runPostCaptureHook(
  hook: ((context: CheckpointCaptureAfterContext) => Promise<void> | void) | undefined,
  context: CheckpointCaptureAfterContext,
  onError: CheckpointCaptureExecutorDependencies["onAfterCaptureError"],
): Promise<void> {
  if (!hook) return;
  try {
    await hook(context);
  } catch (error) {
    try {
      onError?.(error, context);
    } catch {
      // Bounded error observer must never interrupt checkpoint settlement.
    }
  }
}

export function checkpointCaptureExecutor(dependencies: CheckpointCaptureExecutorDependencies): () => void {
  let registered = false;
  return () => {
    if (registered) return;
    registered = true;
    dependencies.effects.register(CHECKPOINT_CAPTURE_EFFECT_KIND, async (request) => {
      let turn: AgentTurn;
      try {
        turn = dependencies.store.agentTurn(request.turnId);
      } catch {
        return;
      }
      if (turn.conversationId !== request.conversationId || turn.runId !== request.runId) return;
      await dependencies.artifacts.finalize({
        turn,
        checkpointId: turn.checkpointId,
        terminalAssistantMessageId: turn.terminalAssistantMessageId,
      });
      dependencies.invalidate(request.conversationId);
      const context: CheckpointCaptureAfterContext = {
        conversationId: request.conversationId,
        runId: request.runId,
        turnId: request.turnId,
        turn,
      };
      await runPostCaptureHook(dependencies.onAfterCapture, context, dependencies.onAfterCaptureError);
      await runPostCaptureHook(dependencies.retryDelegatedBookkeeping, context, dependencies.onAfterCaptureError);
    });
  };
}
