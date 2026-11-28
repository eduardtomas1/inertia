import type {
  AgentTurn,
  Conversation,
  ModelSelection,
  ProviderInfo,
  RuntimeMutationEvent,
} from "../../../shared/contracts";
import { effectiveDefaultProviderId } from "../../../shared/default-provider";
import { providerIdForHarness, providerNativeModelSelection } from "../../../shared/model-routing";
import {
  privateConnectPromptSafetyForHarness,
  privateConnectPromptSafetyIsUsable,
} from "../../../shared/private-connect/prompt-safety";
import type { RuntimeStore } from "../../database";
import type { PrivateConnectScheduledTaskGatewayHandlers } from "../../private-connect/scheduled-tasks-gateway";
import { RuntimeRequestError } from "../../runtime-errors";
import type { ConversationCreationService } from "../conversation-creation-service";
import {
  ScheduledTaskService,
  type ScheduledTaskMessageQueueLike,
} from "./scheduled-task-service";

export interface ScheduledTaskRuntimeDependencies {
  store: RuntimeStore;
  creation(): Pick<ConversationCreationService, "create"> | undefined;
  messageQueue(): ScheduledTaskMessageQueueLike | undefined;
  providerInfo?(): readonly ProviderInfo[];
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

export function resolveScheduledTaskEffectiveModelSelection(
  store: RuntimeStore,
  projectId: string,
  taskModelSelection: ModelSelection | null,
  providerInfo: readonly ProviderInfo[] = [],
): ModelSelection {
  if (taskModelSelection !== null) return taskModelSelection;
  const projectDefault = projectDefaultModelSelection(store, projectId);
  if (projectDefault) return projectDefault;
  const settings = store.settings();
  const providerId = effectiveDefaultProviderId(settings.defaultProvider, providerInfo);
  const inherited = providerId === settings.defaultProvider;
  const modelId = (inherited ? settings.defaultModel : "") || "provider-default";
  return providerNativeModelSelection({
    providerId,
    modelId,
    alias: (inherited ? settings.defaultModel : "") || null,
    reasoningEffort: (inherited ? settings.defaultReasoningEffort : "") || null,
  });
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
      const effectiveSelection = resolveScheduledTaskEffectiveModelSelection(
        store,
        input.projectId,
        input.modelSelection,
        dependencies.providerInfo?.() ?? [],
      );
      const selection = input.modelSelection
        ?? projectDefaultModelSelection(store, input.projectId)
        ?? (input.requirePrivateConnectPromptSafety ? effectiveSelection : undefined);
      if (input.requirePrivateConnectPromptSafety) {
        if (input.accessMode !== "supervised") {
          throw new RuntimeRequestError("PrivateConnect prompting requires Supervised access on the desktop.", "forbidden");
        }
        const safety = privateConnectPromptSafetyForHarness(effectiveSelection.harnessId);
        if (!privateConnectPromptSafetyIsUsable(safety)) {
          throw new RuntimeRequestError(safety.explanation, "forbidden");
        }
      }
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
    effectivePromptSafety: (task) => {
      const effective = resolveScheduledTaskEffectiveModelSelection(
        store,
        task.projectId,
        task.modelSelection,
        dependencies.providerInfo?.() ?? [],
      );
      return privateConnectPromptSafetyForHarness(effective.harnessId);
    },
    toggle: (taskId, enabled) => service.update(taskId, { enabled }),
    runNow: async (taskId) => {
      const result = await service.runNow(taskId, { requirePrivateConnectPromptSafety: true });
      return { task: result.task, conversationId: result.conversationId };
    },
    remove: (taskId) => service.delete(taskId),
  };

  return {
    service,
    privateConnectHandlers,
    start: () => {
      try { service.start(); } catch (error) {
        console.warn("[scheduled-tasks] Startup reconciliation deferred for retry:", error instanceof Error ? error.message : String(error));
      }
    },
    onTurnSettled: (turn: AgentTurn) => service.onTurnSettled(turn),
    dispose: () => service.dispose(),
  };
}

export type ScheduledTaskConversationRef = Pick<Conversation, "id">;
