import type {
  AgentTurn,
  Conversation,
  ModelSelection,
  RuntimeMutationEvent,
} from "../../../shared/contracts";
import { providerIdForHarness } from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { PrivateConnectScheduledTaskGatewayHandlers } from "../../private-connect/scheduled-tasks-gateway";
import type { ConversationCreationService } from "../conversation-creation-service";
import {
  ScheduledTaskService,
  type ScheduledTaskMessageQueueLike,
} from "./scheduled-task-service";

export interface ScheduledTaskRuntimeDependencies {
  store: RuntimeStore;
  creation(): Pick<ConversationCreationService, "create"> | undefined;
  messageQueue(): ScheduledTaskMessageQueueLike | undefined;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
  enableProviders?: boolean;
  isUpdateHeld?(): boolean;
}

export interface ScheduledTaskRuntime {
  readonly service: ScheduledTaskService;
  readonly privateConnectHandlers: PrivateConnectScheduledTaskGatewayHandlers;
  start(): void;
  onTurnSettled(turn: AgentTurn): void;
  dispose(): void;
}

function projectDefaultModelSelection(store: RuntimeStore, projectId: string): ModelSelection | undefined {
  const existing = store.projectConversations(projectId).find((conversation) => conversation.archivedAt === null);
  return existing?.modelSelection;
}

export function createScheduledTaskRuntime(
  dependencies: ScheduledTaskRuntimeDependencies,
): ScheduledTaskRuntime {
  const { store } = dependencies;
  const service = new ScheduledTaskService({
    repository: store.scheduledTasks,
    store,
    createConversation: async (input) => {
      const creation = dependencies.creation();
      if (!creation) {
        throw new Error("Conversation creation is not ready for scheduled tasks.");
      }
      const selection = input.modelSelection ?? projectDefaultModelSelection(store, input.projectId);
      const providerId = selection ? providerIdForHarness(selection.harnessId) : null;
      const created = await creation.create({
        projectId: input.projectId,
        title: input.title,
        interactionMode: input.interactionMode,
        accessMode: input.accessMode,
        activate: false,
        ...(selection ? {
          ...(providerId ? { providerId } : {}),
          model: selection.modelId,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          modelSelection: { ...selection, capabilities: [...selection.capabilities] },
        } : {}),
      }, input.requestId);
      dependencies.broadcastConversationShell(created.id);
      dependencies.broadcastSnapshot();
      return created;
    },
    messageQueue: dependencies.messageQueue,
    isUpdateHeld: dependencies.isUpdateHeld,
    broadcast: (event) => {
      dependencies.broadcast(event);
    },
    enableProviders: dependencies.enableProviders,
  });

  const privateConnectHandlers: PrivateConnectScheduledTaskGatewayHandlers = {
    list: (projectId) => service.list(projectId),
    get: (taskId) => service.get(taskId),
    projectName: (projectId) => {
      try {
        return store.project(projectId).name;
      } catch {
        return null;
      }
    },
    toggle: (taskId, enabled) => service.update(taskId, { enabled }),
    runNow: async (taskId) => {
      const result = await service.runNow(taskId);
      return { task: result.task, conversationId: result.conversationId };
    },
    remove: (taskId) => service.delete(taskId),
  };

  return {
    service,
    privateConnectHandlers,
    start: () => service.start(),
    onTurnSettled: (turn: AgentTurn) => service.onTurnSettled(turn),
    dispose: () => service.dispose(),
  };
}

export type ScheduledTaskConversationRef = Pick<Conversation, "id">;
