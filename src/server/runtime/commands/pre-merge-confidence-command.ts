import type WebSocket from "ws";

import type {
  ClientCommand,
  GitPreMergeConfidence,
  ServerEvent,
} from "../../../shared/contracts";
import { GIT_READ_OPERATION_TIMEOUT_MS } from "../../../shared/runtime-command-timeouts";
import { inspectGitHubPreMergeConfidence } from "../../git";
import { SourceControlDeadline } from "./source-control-deadline";

type ConfidenceCommand = Extract<ClientCommand, { type: "git.pr.confidence" }>;

interface PreMergeConfidenceCommandContext<Repository> {
  socket: WebSocket;
  command: ConfidenceCommand;
  resolveRepository: (
    socket: WebSocket,
    payload: ConfidenceCommand["payload"],
    options: {
      requireAuthority: true;
      deadlineAt: number;
      signal: AbortSignal;
    },
  ) => Promise<Repository>;
  runVerified: <Result>(
    repository: Repository,
    operation: (root: string) => Promise<Result>,
    options: { deadlineAt: number; signal: AbortSignal },
  ) => Promise<Result>;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handlePreMergeConfidenceCommand<Repository>({
  socket,
  command,
  resolveRepository,
  runVerified,
  send,
}: PreMergeConfidenceCommandContext<Repository>): Promise<"handled"> {
  const deadline = new SourceControlDeadline(
    Date.now() + GIT_READ_OPERATION_TIMEOUT_MS,
    "read",
  );
  try {
    const repository = await deadline.runToSettlement(
      async (signal, recordTriggeringFailure) => {
        try {
          return await resolveRepository(
            socket,
            command.payload,
            { requireAuthority: true, deadlineAt: deadline.deadlineAt, signal },
          );
        } catch (error) {
          recordTriggeringFailure(error);
          throw error;
        }
      },
    );
    const confidence = await deadline.runToSettlement(
      async (signal, recordTriggeringFailure) => {
        try {
          return await runVerified(
            repository,
            async (root): Promise<GitPreMergeConfidence> =>
              await inspectGitHubPreMergeConfidence(root, { signal, recordTriggeringFailure }),
            { deadlineAt: deadline.deadlineAt, signal },
          );
        } catch (error) {
          recordTriggeringFailure(error);
          throw error;
        }
      },
    );
    send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: { kind: "git.pr.confidence", confidence },
    });
  } finally {
    deadline.dispose();
  }
  return "handled";
}
