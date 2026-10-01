import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { WorktreeSetupController } from "../worktree-setup-controller";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function createWorktreeSetupCommandHandler(setups: WorktreeSetupController, send: (socket: WebSocket, event: ServerEvent) => void): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["worktree.setup.read", "worktree.setup.wait", "worktree.setup.retry", "worktree.setup.cancel", "worktree.setup.skip"], async (socket, command) => {
    if (command.type !== "worktree.setup.read" && command.type !== "worktree.setup.wait" && command.type !== "worktree.setup.retry" && command.type !== "worktree.setup.cancel" && command.type !== "worktree.setup.skip") return "not-handled";
    const id = command.payload.conversationId;
    if (command.type === "worktree.setup.retry") setups.retry(id);
    if (command.type === "worktree.setup.cancel") setups.cancel(id);
    if (command.type === "worktree.setup.skip") setups.skip(id);
    const result = command.type === "worktree.setup.wait" ? await setups.wait(id) : setups.read(id);
    send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "worktree.setup", ...result } });
    return "handled";
  });
}
