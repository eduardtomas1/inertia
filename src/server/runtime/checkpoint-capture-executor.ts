import type { AgentTurn } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import {
  CHECKPOINT_CAPTURE_EFFECT_KIND,
  type OrchestrationEffectRuntime,
} from "../orchestration-v2/effect-runtime";
import type { TurnGitArtifactManager } from "../turn-git-artifacts";

export interface CheckpointCaptureExecutorDependencies {
  readonly effects: Pick<OrchestrationEffectRuntime, "register">;
  readonly store: Pick<RuntimeStore, "agentTurn">;
  readonly artifacts: Pick<TurnGitArtifactManager, "finalize">;
  readonly invalidate: (conversationId: string) => void;
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
    });
  };
}
