import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import { providerNativeModelSelection } from "../../../shared/model-routing";
import { CliConversationDiscovery } from "../../cli-import/discovery";
import type { RuntimeStore } from "../../database";
import type { ProviderManager } from "../../providers";
import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function createCliConversationCommandHandler(deps: {
  store: RuntimeStore;
  providers: Pick<ProviderManager, "resolveModelRoute">;
  discovery?: CliConversationDiscovery;
  signal?: AbortSignal;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}): RuntimeCommandHandler {
  const discovery = deps.discovery ?? new CliConversationDiscovery(undefined, undefined, deps.signal);
  return defineRuntimeCommandHandler(["conversation.cli.scan", "conversation.cli.preview", "conversation.cli.import"], async (socket, command) => {
    if (command.type !== "conversation.cli.scan" && command.type !== "conversation.cli.preview" && command.type !== "conversation.cli.import") return "not-handled";
    const { projectId } = command.payload;
    if (deps.store.project(projectId).workspaceKind === "scratch") throw new RuntimeRequestError("Chats without a project cannot import CLI conversations.");
    const workspace = deps.store.projectPath(projectId);
    const ownership = (provider: "codex" | "claude", sessionId: string) => deps.store.cliSessionOwnership(provider, sessionId);
    if (command.type === "conversation.cli.scan") {
      const scan = await discovery.scan(projectId, workspace, ownership);
      deps.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "conversation.cli.scan", scan } });
    } else {
      const value = await discovery.read(projectId, workspace, command.payload.candidateId);
      if (deps.store.projectPath(projectId) !== workspace) throw new RuntimeRequestError("The project changed. Scan again.");
      if (command.type === "conversation.cli.preview") {
        deps.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "conversation.cli.preview", preview: discovery.preview(command.payload.candidateId, value, ownership(value.providerId, value.transcript.sessionId)) } });
      } else {
        if (value.revision !== command.payload.revision) throw new RuntimeRequestError("The CLI conversation changed since your preview. Preview it again before importing.");
        const selection = providerNativeModelSelection({ providerId: value.providerId });
        const route = deps.providers.resolveModelRoute(selection);
        const conversationId = deps.store.importCliConversation({
          projectId, sourceKey: value.sourceKey, providerId: value.providerId, sessionId: value.transcript.sessionId, cwd: value.transcript.cwd,
          title: value.transcript.title, messages: value.transcript.messages,
          omittedMessages: value.transcript.omittedMessages, omittedBytes: value.transcript.omittedBytes, droppedRecords: value.droppedRecords,
          selection, continuationIdentity: route.continuationIdentity,
        });
        deps.broadcastSnapshot();
        deps.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "conversation.cli.imported", conversationId } });
      }
    }
    return "handled";
  });
}
