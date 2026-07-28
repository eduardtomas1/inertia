import type {
  CheckpointSummary,
  Conversation,
  ServerEvent,
  SubagentTrace,
} from "@shared/contracts";

import type { CommandWithoutId } from "../../lib/runtimeCommands";

interface WorkspaceTurnActionInput {
  conversation: Conversation | null;
  confirmDestructiveActions: boolean;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  loadGit: () => Promise<void>;
  openTurnDiff: (turnId: string, path?: string) => Promise<void>;
  compareTurnArtifacts: (
    earlierTurnId: string,
    laterTurnId: string,
  ) => Promise<void>;
}

export function createWorkspaceTurnActions({
  conversation,
  confirmDestructiveActions,
  run,
  loadGit,
  openTurnDiff,
  compareTurnArtifacts,
}: WorkspaceTurnActionInput) {
  return {
    revertCheckpoint(checkpoint: CheckpointSummary): void {
      const confirmed = !confirmDestructiveActions
        || window.confirm(
          "Restore the project to before this turn? "
          + "Untracked files created later will be left in place.",
        );
      if (!conversation || !confirmed) return;
      void run("checkpoint.revert", {
        type: "checkpoint.revert",
        payload: {
          conversationId: conversation.id,
          checkpointId: checkpoint.id,
        },
      }).then(loadGit).catch(() => undefined);
    },
    openTurnDiff(turnId: string, path?: string): void {
      void openTurnDiff(turnId, path);
    },
    compareTurnArtifacts(
      earlierTurnId: string,
      laterTurnId: string,
    ): void {
      void compareTurnArtifacts(earlierTurnId, laterTurnId);
    },
    stopSubagent(trace: SubagentTrace): Promise<void> {
      return run(`agent.subagent.stop:${trace.id}`, {
        type: "agent.subagent.stop",
        payload: {
          conversationId: trace.conversationId,
          traceId: trace.id,
        },
      }).then(() => undefined);
    },
    stopAgent(): Promise<void> {
      return conversation
        ? run("agent.stop", {
            type: "agent.stop",
            payload: { conversationId: conversation.id },
          }).then(() => undefined)
        : Promise.resolve();
    },
  };
}
