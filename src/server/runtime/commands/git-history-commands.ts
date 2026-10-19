import type WebSocket from "ws";

import type { ClientCommand, ServerEvent } from "../../../shared/contracts";
import { GIT_READ_OPERATION_TIMEOUT_MS } from "../../../shared/runtime-command-timeouts";
import { blameGitFile } from "../../git/blame";
import { showGitCommit } from "../../git/commit-show";
import { readGitLog } from "../../git/log";
import { SourceControlDeadline } from "./source-control-deadline";

export const GIT_HISTORY_COMMAND_TYPES = [
  "git.log",
  "git.commit.show",
  "git.blame",
] as const;

type GitHistoryCommand = Extract<
  ClientCommand,
  { type: (typeof GIT_HISTORY_COMMAND_TYPES)[number] }
>;

export interface GitHistoryCommandContext<Repository> {
  socket: WebSocket;
  command: GitHistoryCommand;
  /**
   * The shared source-control scope resolver: the project or chat checkout
   * when repositoryPath is omitted, otherwise a discovered nested repository
   * bound to its runtime-issued authority.
   */
  resolveRepository: (
    socket: WebSocket,
    payload: GitHistoryCommand["payload"],
    options: { deadlineAt: number; signal: AbortSignal },
  ) => Promise<Repository>;
  runVerified: <Result>(
    repository: Repository,
    operation: (root: string) => Promise<Result>,
    options: { deadlineAt: number; signal: AbortSignal },
  ) => Promise<Result>;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

type HistoryResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: GitHistoryCommand["type"] }
>;

async function inspect(
  command: GitHistoryCommand,
  root: string,
  options: { deadlineAt: number; signal: AbortSignal },
): Promise<HistoryResult> {
  switch (command.type) {
    case "git.log":
      return {
        kind: "git.log",
        page: await readGitLog(root, {
          ...options,
          ...(command.payload.cursor ? { cursor: command.payload.cursor } : {}),
          ...(command.payload.limit ? { limit: command.payload.limit } : {}),
          ...(command.payload.path ? { path: command.payload.path } : {}),
        }),
      };
    case "git.commit.show":
      return {
        kind: "git.commit.show",
        commit: await showGitCommit(root, { ...options, sha: command.payload.sha }),
      };
    case "git.blame":
      return {
        kind: "git.blame",
        blame: await blameGitFile(root, {
          ...options,
          path: command.payload.path,
          ...(command.payload.startLine ? { startLine: command.payload.startLine } : {}),
          ...(command.payload.endLine ? { endLine: command.payload.endLine } : {}),
        }),
      };
  }
}

/**
 * Handles the read-only history commands under one Git read deadline. They
 * never take the mutation serialization lock and never change refs, the
 * index or the working tree.
 */
export async function handleGitHistoryCommand<Repository>({
  socket,
  command,
  resolveRepository,
  runVerified,
  send,
}: GitHistoryCommandContext<Repository>): Promise<"handled"> {
  const deadline = new SourceControlDeadline(
    Date.now() + GIT_READ_OPERATION_TIMEOUT_MS,
    "read",
  );
  const cancel = (): void => deadline.cancel();
  socket.once("close", cancel);
  try {
    const options = { deadlineAt: deadline.deadlineAt, signal: deadline.signal };
    const repository = await deadline.run(async (signal) =>
      await resolveRepository(socket, command.payload, { ...options, signal }));
    const result = await deadline.runToSettlement(async (signal, recordTriggeringFailure) => {
      try {
        return await runVerified(
          repository,
          async (root) => await inspect(command, root, { ...options, signal }),
          { ...options, signal },
        );
      } catch (error) {
        recordTriggeringFailure(error);
        throw error;
      }
    });
    send(socket, { type: "request.result", requestId: command.requestId, result });
  } finally {
    socket.off("close", cancel);
    deadline.dispose();
  }
  return "handled";
}
