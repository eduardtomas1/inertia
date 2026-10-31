import type WebSocket from "ws";

import type { ClientCommand, ServerEvent } from "../../../shared/contracts";
import {
  GIT_INDEX_MUTATION_TIMEOUT_MS,
  GIT_READ_OPERATION_TIMEOUT_MS,
} from "../../../shared/runtime-command-timeouts";
import {
  stageRepositoryPaths,
  unstageRepositoryPaths,
  type GitStagingResult,
} from "../../git/staging";

type StagingCommand = Extract<ClientCommand, { type: "git.stage" | "git.unstage" }>;

export interface StagingCommandContext {
  socket: WebSocket;
  command: StagingCommand;
  /**
   * Runs the index mutation under the caller's live repository authority,
   * identity verification, checkout reservation, serialization and Git
   * invalidation, with the canonical repository root it verified.
   */
  runTrackedRepositoryOperation: (
    label: string,
    operation: (root: string) => Promise<GitStagingResult>,
  ) => Promise<GitStagingResult>;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

function stagingMessage(stage: boolean, result: GitStagingResult): string {
  const count = result.paths.length;
  if (count === 0) return stage ? "Nothing new to stage." : "Nothing staged to unstage.";
  const noun = count === 1 ? "file" : "files";
  const message = stage
    ? `Staged ${count} ${noun}.`
    : `Unstaged ${count} ${noun}. Working-tree files are unchanged.`;
  return result.refreshWarning ? `${message} ${result.refreshWarning}` : message;
}

/**
 * Moves whole files between the working tree and the index; never the
 * reverse. The reads before the index update share one read deadline; the
 * update itself and the status refresh after it each get their own clock.
 */
export async function handleStagingCommand({
  socket,
  command,
  runTrackedRepositoryOperation,
  send,
}: StagingCommandContext): Promise<"handled"> {
  const stage = command.type === "git.stage";
  const change = stage ? stageRepositoryPaths : unstageRepositoryPaths;
  const result = await runTrackedRepositoryOperation(
    stage ? "Stage files" : "Unstage files",
    async (root) => await change(root, command.payload.paths, {
      deadlineAt: Date.now() + GIT_READ_OPERATION_TIMEOUT_MS,
      mutationTimeoutMs: GIT_INDEX_MUTATION_TIMEOUT_MS,
      refreshTimeoutMs: GIT_READ_OPERATION_TIMEOUT_MS,
    }),
  );
  send(socket, {
    type: "request.result",
    requestId: command.requestId,
    result: { kind: "git.action", message: stagingMessage(stage, result) },
  });
  return "handled";
}
