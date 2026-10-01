import type WebSocket from "ws";
import type { ServerEvent } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { PullRequestService } from "../pull-requests/service";
import { GitHubPullRequestsClient } from "../pull-requests/github-client";
import { createGitHubRequest } from "../pull-requests/github-transport";
import { defineRuntimeCommandHandler } from "./commands/command-router";

export function createPullRequestsRuntime(store: RuntimeStore, dataDirectory: string, signal: AbortSignal,
  send: (socket: WebSocket, event: ServerEvent) => void) {
  const service = new PullRequestService(store, (operationSignal) => new GitHubPullRequestsClient(createGitHubRequest(dataDirectory, operationSignal)), signal);
  return defineRuntimeCommandHandler([
    "conversation.prs.get", "conversation.prs.refresh", "conversation.prs.link", "conversation.prs.unlink",
    "conversation.stack.prepare", "conversation.stack.execute",
  ], async (socket, command) => {
    const result = await (async () => {
      switch (command.type) {
        case "conversation.prs.get": return service.get(command.payload.conversationId);
        case "conversation.prs.refresh": return await service.refresh(command.payload.conversationId);
        case "conversation.prs.link": return await service.link(command.payload.conversationId, command.payload.url);
        case "conversation.prs.unlink": return await service.unlink(command.payload.conversationId, command.payload.key);
        case "conversation.stack.prepare": return await service.prepare(command.payload.conversationId, command.payload.key, command.payload.action);
        case "conversation.stack.execute": return await service.execute(command.payload.conversationId, command.payload.reviewId);
        default: return null;
      }
    })();
    if (!result) return "not-handled";
    send(socket, { type: "request.result", requestId: command.requestId, result });
    return "handled";
  });
}
