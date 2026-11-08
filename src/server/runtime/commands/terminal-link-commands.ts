import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import { resolveTerminalPath } from "../../terminal-path-links";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface TerminalLinkCommandDependencies {
  workspacePath(projectId: string, conversationId?: string): string;
  send(socket: WebSocket, event: ServerEvent): void;
  resolve?: typeof resolveTerminalPath;
}

/** Read-only resolution of file paths printed in a chat's terminal. */
export function createTerminalLinkCommandHandler(
  dependencies: TerminalLinkCommandDependencies,
): RuntimeCommandHandler {
  const resolvePath = dependencies.resolve ?? resolveTerminalPath;
  return defineRuntimeCommandHandler(["workspace.path.resolve"], async (socket, command) => {
    if (command.type !== "workspace.path.resolve") return "not-handled";
    const workspacePath = dependencies.workspacePath(
      command.payload.projectId,
      command.payload.conversationId,
    );
    const resolution = await resolvePath(workspacePath, command.payload.text);
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: { kind: "workspace.path", resolution },
    });
    return "handled";
  });
}
