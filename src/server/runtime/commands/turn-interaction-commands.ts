import { join } from "node:path";

import type WebSocket from "ws";

import {
  chatAttachmentKind,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type ProviderInfo,
  type ServerEvent,
} from "../../../shared/contracts";
import { CheckpointError, createCheckpoint } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { getRepositoryStatus, GitError } from "../../git";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { IsolatedRunController } from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { TrustedAttachmentResolver } from "../attachments/trusted-attachment-resolver";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface TurnInteractionCommandDependencies {
  store: RuntimeStore;
  backendProfileController: BackendProfileController;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  pendingApprovals: Map<string, AgentApprovalRequest>;
  pendingInputs: Map<string, AgentInputRequest>;
  dataDirectory: string;
  enableProviders: boolean;
  attachmentResolver: TrustedAttachmentResolver | null;
  providerInfo(): readonly ProviderInfo[];
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createTurnInteractionCommandHandler(
  dependencies: TurnInteractionCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "message.send",
    "agent.stop",
    "agent.subagent.stop",
    "activity.stop",
    "activity.dismiss",
    "activity.mark-seen",
    "activity.acknowledge",
    "agent.approval.respond",
    "agent.input.respond",
  ], async (socket, command) => {
    switch (command.type) {
      case "message.send": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (dependencies.turns.isActive(conversation.id)) {
          if (
            command.payload.attachments.length > 0
            || command.payload.context !== undefined
          ) {
            throw new RuntimeRequestError(
              "Follow-ups while the agent is working support text only.",
            );
          }
          const followedUp = await dependencies.turns.steer(
            conversation.id,
            command.payload.content,
          );
          if (!followedUp) {
            throw new RuntimeRequestError(
              "This active agent route cannot accept a follow-up.",
            );
          }
          dependencies.send(socket, {
            type: "request.ok",
            requestId: command.requestId,
          });
          dependencies.broadcastSnapshot();
          return "handled";
        }
        if (dependencies.isolatedRuns.has(conversation.id)) {
          throw new RuntimeRequestError(
            "Wait for the current run or read-only review to finish first.",
          );
        }
        const attachments = command.payload.attachments.length === 0
          ? []
          : await dependencies.attachmentResolver?.resolveAll(
              command.payload.attachments,
            ) ?? (() => {
              throw new RuntimeRequestError(
                "The selected attachment is no longer available or could not be verified.",
              );
            })();
        const relinquishAttachments = () =>
          dependencies.attachmentResolver?.relinquishAll(
            attachments.map(({ id }) => id),
          );
        if (
          attachments.some(
            ({ mimeType }) => chatAttachmentKind(mimeType) === "document",
          )
        ) {
          await relinquishAttachments();
          throw new RuntimeRequestError(
            "Document attachments are preview-only and cannot be sent to the selected provider.",
          );
        }
        if (dependencies.enableProviders) {
          const selectedProvider = dependencies.providerInfo().find(
            ({ id }) => id === conversation.providerId,
          );
          try {
            dependencies.backendProfileController.validateSelection(
              conversation.modelSelection,
            );
            const backendReadiness = await dependencies
              .backendProfileController.readiness(
                conversation.modelSelection,
                selectedProvider,
              );
            if (backendReadiness && !backendReadiness.ready) {
              throw new RuntimeRequestError(
                backendReadiness.message
                  ?? "The selected model backend is unavailable.",
              );
            }
            if (!backendReadiness && !selectedProvider?.canRun) {
              throw new RuntimeRequestError(
                selectedProvider?.statusMessage
                  ?? "This agent is not ready. Open Settings to finish setup.",
              );
            }
            const selectedModel = !backendReadiness
              ? conversation.model
                ? selectedProvider?.models.find(
                    ({ id }) => id === conversation.model,
                  )
                : selectedProvider?.models.find(({ isDefault }) => isDefault)
                  ?? selectedProvider?.models[0]
              : undefined;
            if (
              !backendReadiness
              && conversation.model
              && (selectedProvider?.models.length ?? 0) > 0
              && !selectedModel
            ) {
              throw new RuntimeRequestError(
                "That model is no longer offered by this provider. Choose another model before sending.",
              );
            }
            if (
              !backendReadiness
              && conversation.reasoningEffort
              && selectedModel?.reasoningOptions.length
              && !selectedModel.reasoningOptions.some(
                ({ value }) => value === conversation.reasoningEffort,
              )
            ) {
              throw new RuntimeRequestError(
                "That reasoning level is not supported by the selected model.",
              );
            }
          } catch (error) {
            await relinquishAttachments();
            throw error;
          }
        }
        let checkpointId: string | null = null;
        if (dependencies.enableProviders) {
          try {
            const path = dependencies.store.conversationPath(conversation.id);
            const status = await getRepositoryStatus(path);
            const captured = await createCheckpoint(
              path,
              join(dependencies.dataDirectory, "checkpoint-indexes"),
              conversation.id,
            );
            const turnIndex = dependencies.store.checkpointCount(
              conversation.id,
            ) + 1;
            checkpointId = dependencies.store.addCheckpoint({
              conversationId: conversation.id,
              ref: captured.ref,
              label: `Before turn ${turnIndex}`,
              turnIndex,
              filesChanged: status.files.length,
              insertions: status.insertions,
              deletions: status.deletions,
            }).id;
          } catch (error) {
            if (
              !(
                error instanceof CheckpointError
                && error.message === "not-repository"
              )
              && !(
                error instanceof GitError
                && error.code === "not-repository"
              )
            ) {
              // A checkpoint is protective but not a reason to block a run.
            }
          }
        }
        let queued: ReturnType<typeof dependencies.turns.queue> | null;
        try {
          queued = dependencies.enableProviders
            ? dependencies.turns.queue({
                conversationId: conversation.id,
                content: command.payload.content,
                attachments,
                activateConversation: command.payload.activate,
                context: command.payload.context,
                checkpointId,
              })
            : null;
        } catch (error) {
          await relinquishAttachments();
          throw error;
        }
        let attachmentOwnershipAccepted = queued !== null;
        try {
          if (!dependencies.enableProviders) {
            dependencies.store.createMessage(
              conversation.id,
              command.payload.content,
              "user",
              attachments,
              null,
              undefined,
              { activateConversation: command.payload.activate },
            );
            attachmentOwnershipAccepted = true;
          }
          if (
            conversation.title === "New chat"
            || conversation.title === "New thread"
          ) {
            dependencies.store.updateConversation(conversation.id, {
              title: command.payload.content.slice(0, 64),
            });
          }
          dependencies.send(socket, {
            type: "request.ok",
            requestId: command.requestId,
          });
          dependencies.broadcastSnapshot();
          if (queued) dependencies.turns.start(queued.turn.id);
          return "handled";
        } catch (error) {
          if (queued) {
            dependencies.turns.failBeforeStart(
              conversation.id,
              error instanceof Error
                ? error.message
                : "The turn could not start.",
            );
          } else if (!attachmentOwnershipAccepted) {
            await relinquishAttachments();
          }
          throw error;
        }
      }
      case "agent.stop":
        if (
          !dependencies.isolatedRuns.stopConversation(
            command.payload.conversationId,
          )
          && !dependencies.turns.cancel(command.payload.conversationId)
        ) {
          throw new RuntimeRequestError(
            "This thread does not have an active run.",
          );
        }
        return "mutation";
      case "agent.subagent.stop":
        if (
          !await dependencies.turns.stopSubagent(
            command.payload.conversationId,
            command.payload.traceId,
          )
        ) {
          throw new RuntimeRequestError(
            "That delegated Claude task is no longer live or cannot be stopped.",
          );
        }
        return "mutation";
      case "activity.stop": {
        const activity = dependencies.store.workspaceRun(
          command.payload.runId,
        );
        if (
          activity.status !== "running"
          && activity.status !== "waiting"
        ) {
          throw new RuntimeRequestError(
            "That activity has already finished.",
          );
        }
        if (activity.kind === "check" || activity.kind === "service") {
          if (!dependencies.workspaceRuns.stopManagedAction(activity.id)) {
            throw new RuntimeRequestError(
              "That process is no longer owned by the local runtime.",
            );
          }
          return "mutation";
        }
        if (activity.kind !== "agent" || !activity.conversationId) {
          throw new RuntimeRequestError(
            "This activity cannot be stopped safely.",
          );
        }
        if (dependencies.isolatedRuns.ownsWorkspaceRun(activity.id)) {
          if (!dependencies.isolatedRuns.stopWorkspaceRun(activity.id)) {
            throw new RuntimeRequestError(
              "That isolated review has already finished.",
            );
          }
          return "mutation";
        }
        if (
          !dependencies.isolatedRuns.stopConversation(
            activity.conversationId,
          )
          && !dependencies.turns.cancel(activity.conversationId)
        ) {
          throw new RuntimeRequestError(
            "That agent run is no longer active.",
          );
        }
        return "mutation";
      }
      case "activity.dismiss":
        dependencies.store.dismissWorkspaceRun(command.payload.runId);
        return "mutation";
      case "activity.mark-seen":
        dependencies.store.markWorkspaceRunSeen(command.payload.runId);
        return "mutation";
      case "activity.acknowledge":
        dependencies.store.acknowledgeWorkspaceRun(command.payload.runId);
        return "mutation";
      case "agent.approval.respond": {
        const pending = dependencies.pendingApprovals.get(
          command.payload.requestId,
        );
        if (
          !pending
          || pending.conversationId !== command.payload.conversationId
        ) {
          throw new RuntimeRequestError(
            "That approval request is no longer pending.",
          );
        }
        if (
          !pending.availableDecisions.includes(command.payload.decision)
        ) {
          throw new RuntimeRequestError(
            "That response is not available for this approval request.",
          );
        }
        if (
          !dependencies.turns.respondToApproval(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.decision,
          )
        ) {
          throw new RuntimeRequestError(
            "That approval request is no longer pending.",
          );
        }
        return "mutation";
      }
      case "agent.input.respond": {
        const pending = dependencies.pendingInputs.get(
          command.payload.requestId,
        );
        if (
          !pending
          || pending.conversationId !== command.payload.conversationId
        ) {
          throw new RuntimeRequestError(
            "That question is no longer pending.",
          );
        }
        const expected = new Map(
          pending.questions.map((question) => [question.id, question]),
        );
        const invalidAnswer = Object.entries(command.payload.answers).some(
          ([id, values]) => {
            const question = expected.get(id);
            if (
              !question
              || values.length === 0
              || (!question.allowMultiple && values.length !== 1)
            ) {
              return true;
            }
            const optionIds = new Set(
              question.options.map((option) => option.id),
            );
            return values.some((value) => (
              !optionIds.has(value)
              && !question.isOther
              && question.options.length > 0
            ));
          },
        );
        if (
          invalidAnswer
          || [...expected.keys()].some(
            (id) => !command.payload.answers[id]?.length,
          )
        ) {
          throw new RuntimeRequestError(
            "Answer every question before continuing.",
          );
        }
        if (
          !dependencies.turns.respondToInput(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.answers,
          )
        ) {
          throw new RuntimeRequestError(
            "That question is no longer pending.",
          );
        }
        return "mutation";
      }
      default:
        return "not-handled";
    }
  });
}
