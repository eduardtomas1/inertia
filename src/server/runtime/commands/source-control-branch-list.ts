import type WebSocket from "ws";
import type { ClientCommand, ServerEvent } from "../../../shared/contracts";
import { GIT_READ_OPERATION_TIMEOUT_MS } from "../../../shared/runtime-command-timeouts";
import type { GitBranches } from "../../git/types";
import { SourceControlDeadline } from "./source-control-deadline";

export async function handleBranchListCommand(
  socket: WebSocket,
  command: Extract<ClientCommand, { type: "git.branches" }>,
  dependencies: {
    inspectBranches(options: { deadlineAt: number; signal: AbortSignal }): Promise<GitBranches>;
    send(socket: WebSocket, event: ServerEvent): void;
  },
): Promise<"handled"> {
  const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
  const deadline = new SourceControlDeadline(deadlineAt, "read");
  const cancel = (): void => deadline.cancel();
  socket.once("close", cancel);
  try {
    const branches = await deadline.runToSettlement(async (signal) =>
      await dependencies.inspectBranches({ deadlineAt, signal }));
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: {
        kind: "git.branches",
        branches: [...branches.local, ...branches.remote].map((branch) => ({
          name: branch.name,
          current: branch.current,
          remote: branch.kind === "remote",
          worktreePath: null,
          checkedOut: branch.checkedOut,
        })),
      },
    });
    return "handled";
  } finally {
    socket.off("close", cancel);
    deadline.dispose();
  }
}
