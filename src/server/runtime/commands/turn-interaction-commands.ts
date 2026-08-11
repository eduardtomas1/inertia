import { join } from "node:path";

import type WebSocket from "ws";

import type { ConversationAttachmentStore } from "../../../node/conversation-attachment-store";

import {
  type AgentApprovalRequest,
  type AgentInputRequest,
  type ProviderInfo,
  type RuntimeMutationEvent,
  type ServerEvent,
} from "../../../shared/contracts";
import {
  CheckpointError,
  createCheckpoint,
  deleteCheckpoint,
} from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { getRepositoryStatus, GitError } from "../../git";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  prepareDocumentAttachments,
  type PreparedDocumentAttachments,
} from "../attachments/document-attachment-context";
import type { PrivateGeneratedAttachmentStore } from "../attachments/private-generated-attachments";
import type { TrustedAttachmentResolver } from "../attachments/trusted-attachment-resolver";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { IsolatedRunController } from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import {
  assertMessageSendPreparationPending,
  awaitMessageSendPreparation,
  messageSendPreparationDeadline,
  messageSendPreparationExpired,
} from "./message-send-preparation";

export interface TurnInteractionCommandDependencies {
  store: RuntimeStore;
  conversationAttachments: ConversationAttachmentStore;
  backendProfileController: BackendProfileController;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  pendingApprovals: Map<string, AgentApprovalRequest>;
  pendingInputs: Map<string, AgentInputRequest>;
  dataDirectory: string;
  enableProviders: boolean;
  attachmentResolver: TrustedAttachmentResolver | null;
  generatedAttachments: PrivateGeneratedAttachmentStore;
  workflows: AgentWorkflowController;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  providerInfo(): readonly ProviderInfo[];
  broadcast(event: RuntimeMutationEvent): void;
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
        if (dependencies.providerTerminalResumes.isActive(conversation.id)) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal for this chat before sending another message.",
          );
        }
        if (dependencies.turns.isActive(conversation.id)) {
          if (
            command.payload.attachments.length > 0
            || command.payload.context !== undefined
            || (command.payload.skillIds?.length ?? 0) > 0
          ) {
            throw new RuntimeRequestError(
              "Follow-ups while the agent is working support text only and cannot add skills.",
            );
          }
          const followUpMessage = await dependencies.turns.steer(
            conversation.id,
            command.payload.content,
          );
          if (!followUpMessage?.turnId) {
            throw new RuntimeRequestError(
              "This active agent route cannot accept a follow-up.",
            );
          }
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "message.accepted",
              conversationId: followUpMessage.conversationId,
              turnId: followUpMessage.turnId,
              userMessageId: followUpMessage.id,
              disposition: "follow-up",
            },
          });
          dependencies.broadcast({
            type: "conversation.message.persisted",
            message: followUpMessage,
          });
          dependencies.broadcastSnapshot();
          return "handled";
        }
        if (dependencies.isolatedRuns.has(conversation.id)) {
          throw new RuntimeRequestError(
            "Wait for the current run or read-only review to finish first.",
          );
        }
        const preparationDeadlineAt = messageSendPreparationDeadline();
        let resolvedAttachments: Awaited<
          ReturnType<TrustedAttachmentResolver["resolvePayloads"]>
        > = [];
        if (command.payload.attachments.length > 0) {
          const resolver = dependencies.attachmentResolver;
          if (!resolver) {
            throw new RuntimeRequestError(
              "The selected attachment is no longer available or could not be verified.",
            );
          }
          const resolutionAbort = new AbortController();
          resolvedAttachments = await awaitMessageSendPreparation(
            resolver.resolvePayloads(
              command.payload.attachments,
              resolutionAbort.signal,
            ),
            preparationDeadlineAt,
            () => resolutionAbort.abort(),
          );
        }
        const sourceAttachments = resolvedAttachments.map(
          ({ attachment }) => attachment,
        );
        let attachments = sourceAttachments;
        let retainedAttachmentIds: string[] = [];
        let retainedAttachmentsAccepted = false;
        let generatedAttachmentPaths: string[] = [];
        const relinquishAttachments = async () => {
          const generated = generatedAttachmentPaths;
          generatedAttachmentPaths = [];
          await Promise.all([
            dependencies.attachmentResolver?.relinquishAll(
              sourceAttachments.map(({ id }) => id),
            ),
            !retainedAttachmentsAccepted && retainedAttachmentIds.length > 0
              ? dependencies.conversationAttachments.release(
                  retainedAttachmentIds,
                )
              : undefined,
            generated.length > 0
              ? dependencies.generatedAttachments.release(generated)
              : undefined,
          ]);
          if (!retainedAttachmentsAccepted) retainedAttachmentIds = [];
        };
        let documentPreparation: PreparedDocumentAttachments;
        let extraction: Promise<PreparedDocumentAttachments> | null = null;
        try {
          const extractionAbort = new AbortController();
          extraction = prepareDocumentAttachments(resolvedAttachments, {
            deadlineAt: preparationDeadlineAt,
            generatedAttachmentStore: dependencies.generatedAttachments,
            signal: extractionAbort.signal,
          });
          documentPreparation = await awaitMessageSendPreparation(
            extraction,
            preparationDeadlineAt,
            () => extractionAbort.abort(),
          );
          generatedAttachmentPaths = documentPreparation.generatedImagePaths;
        } catch (error) {
          void extraction?.then(
            (late) => late.generatedImagePaths.length > 0
              ? dependencies.generatedAttachments.release(late.generatedImagePaths)
              : undefined,
            () => undefined,
          ).catch(() => undefined);
          await relinquishAttachments();
          throw new RuntimeRequestError(
            error instanceof Error
              ? error.message
              : "The selected document could not be read.",
          );
        }
        if (dependencies.enableProviders) {
          const selectedProvider = dependencies.providerInfo().find(
            ({ id }) => id === conversation.providerId,
          );
          try {
            const validatedSelection = dependencies.backendProfileController
              .validateSelection(conversation.modelSelection);
            const selectedModel = validatedSelection.modelId === "provider-default"
              ? selectedProvider?.models.find(({ isDefault }) => isDefault)
                ?? selectedProvider?.models[0]
              : selectedProvider?.models.find(
                  ({ id }) => id === validatedSelection.modelId,
                );
            const externalImageCapability = validatedSelection.capabilities.find(
              ({ id }) => id === "images",
            );
            const supportsScannedPdfImages = dependencies.backendProfileController
              .isExternalSelection(validatedSelection)
              ? externalImageCapability !== undefined
                && externalImageCapability.state !== "unknown"
                && externalImageCapability.state !== "unavailable"
              : selectedModel?.inputModalities.includes("image") === true;
            if (
              documentPreparation.generatedImagePaths.length > 0
              && !supportsScannedPdfImages
            ) {
              throw new RuntimeRequestError(
                "The selected model cannot inspect scanned PDF page images.",
              );
            }
            const backendReadiness = await awaitMessageSendPreparation(
              dependencies.backendProfileController.readiness(
                validatedSelection,
                selectedProvider,
              ),
              preparationDeadlineAt,
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
            // The authoritative selection validator owns native model and
            // reasoning admission; the legacy conversation model fields must
            // never substitute another route here.
          } catch (error) {
            await relinquishAttachments();
            throw error;
          }
        }
        let resolvedSkills: Awaited<
          ReturnType<AgentWorkflowController["resolveTurnSkills"]>
        >;
        try {
          resolvedSkills = await awaitMessageSendPreparation(
            dependencies.workflows.resolveTurnSkills(
              conversation.id,
              command.payload.skillIds ?? [],
            ),
            preparationDeadlineAt,
          );
        } catch (error) {
          await relinquishAttachments();
          throw error;
        }
        let providerTransitionReserved = false;
        try {
          assertMessageSendPreparationPending(preparationDeadlineAt);
          dependencies.workflows.assertTurnSkillsCurrent(
            conversation.id,
            resolvedSkills.routeKey,
          );
          if (
            dependencies.enableProviders
            && !dependencies.providerTerminalResumes.acquire(conversation.id)
          ) {
            throw new RuntimeRequestError(
              "End the resumed provider terminal for this chat before sending another message.",
            );
          }
          providerTransitionReserved = dependencies.enableProviders;
        } catch (error) {
          if (providerTransitionReserved) {
            dependencies.providerTerminalResumes.release(conversation.id);
          }
          await relinquishAttachments();
          throw error;
        }
        let checkpointId: string | null = null;
        let capturedCheckpoint: {
          repositoryPath: string;
          ref: string;
        } | null = null;
        let pendingCheckpoint: {
          repositoryPath: string;
          ref: string;
          label: string;
          turnIndex: number;
          filesChanged: number;
          insertions: number;
          deletions: number;
        } | null = null;
        if (dependencies.enableProviders) {
          try {
            const path = dependencies.store.conversationPath(conversation.id);
            const status = await getRepositoryStatus(path, {
              deadlineAt: preparationDeadlineAt,
            });
            const captured = await createCheckpoint(
              path,
              join(dependencies.dataDirectory, "checkpoint-indexes"),
              conversation.id,
              { deadlineAt: preparationDeadlineAt },
            );
            capturedCheckpoint = {
              repositoryPath: path,
              ref: captured.ref,
            };
            assertMessageSendPreparationPending(preparationDeadlineAt);
            const turnIndex = dependencies.store.checkpointCount(
              conversation.id,
            ) + 1;
            pendingCheckpoint = {
              repositoryPath: path,
              ref: captured.ref,
              label: `Before turn ${turnIndex}`,
              turnIndex,
              filesChanged: status.files.length,
              insertions: status.insertions,
              deletions: status.deletions,
            };
          } catch (error) {
            if (capturedCheckpoint && !pendingCheckpoint) {
              await deleteCheckpoint(
                capturedCheckpoint.repositoryPath,
                capturedCheckpoint.ref,
                conversation.id,
              ).catch(() => undefined);
            }
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
            if (messageSendPreparationExpired(preparationDeadlineAt)) {
              if (providerTransitionReserved) {
                dependencies.providerTerminalResumes.release(conversation.id);
                providerTransitionReserved = false;
              }
              await relinquishAttachments();
              assertMessageSendPreparationPending(preparationDeadlineAt);
            }
          }
        }
        const retentionAbort = new AbortController();
        const retention = dependencies.conversationAttachments.retain(
          resolvedAttachments,
          retentionAbort.signal,
        );
        let retentionCompleted = false;
        try {
          attachments = await awaitMessageSendPreparation(
            retention,
            preparationDeadlineAt,
            () => retentionAbort.abort(),
          );
          retentionCompleted = true;
          retainedAttachmentIds = attachments.map(({ id }) => id);
          const durablePathBySourcePath = new Map(
            sourceAttachments.map((source, index) => [
              source.path,
              attachments[index]?.path ?? source.path,
            ]),
          );
          documentPreparation = {
            ...documentPreparation,
            imagePaths: documentPreparation.imagePaths.map((path) =>
              durablePathBySourcePath.get(path) ?? path),
          };
          assertMessageSendPreparationPending(preparationDeadlineAt);
        } catch (error) {
          if (!retentionCompleted) {
            void retention.then(
              (lateAttachments) => dependencies.conversationAttachments
                .release(lateAttachments.map(({ id }) => id)),
              () => undefined,
            ).catch(() => undefined);
          }
          if (providerTransitionReserved) {
            dependencies.providerTerminalResumes.release(conversation.id);
            providerTransitionReserved = false;
          }
          if (pendingCheckpoint) {
            await deleteCheckpoint(
              pendingCheckpoint.repositoryPath,
              pendingCheckpoint.ref,
              conversation.id,
            ).catch(() => undefined);
          }
          await relinquishAttachments();
          throw error;
        }
        let queued: ReturnType<typeof dependencies.turns.queue> | null;
        try {
          if (pendingCheckpoint) {
            checkpointId = dependencies.store.addCheckpoint({
              conversationId: conversation.id,
              ref: pendingCheckpoint.ref,
              label: pendingCheckpoint.label,
              turnIndex: pendingCheckpoint.turnIndex,
              filesChanged: pendingCheckpoint.filesChanged,
              insertions: pendingCheckpoint.insertions,
              deletions: pendingCheckpoint.deletions,
            }).id;
          }
          queued = dependencies.enableProviders
            ? dependencies.turns.queue({
                conversationId: conversation.id,
                content: command.payload.content,
                attachments,
                imagePaths: documentPreparation.imagePaths,
                generatedAttachmentPaths,
                documentContexts: documentPreparation.contexts,
                activateConversation: command.payload.activate,
                context: command.payload.context,
                checkpointId,
                skills: resolvedSkills.inputs,
              })
            : null;
          retainedAttachmentsAccepted = queued !== null;
        } catch (error) {
          if (providerTransitionReserved) {
            dependencies.providerTerminalResumes.release(conversation.id);
          }
          if (pendingCheckpoint && checkpointId === null) {
            await deleteCheckpoint(
              pendingCheckpoint.repositoryPath,
              pendingCheckpoint.ref,
              conversation.id,
            ).catch(() => undefined);
          }
          await relinquishAttachments();
          throw error;
        }
        let attachmentOwnershipAccepted = queued !== null;
        try {
          if (!dependencies.enableProviders) {
            if (generatedAttachmentPaths.length > 0) {
              await dependencies.generatedAttachments.release(generatedAttachmentPaths);
            }
            generatedAttachmentPaths = [];
            dependencies.store.createMessage(
              conversation.id,
              command.payload.content,
              "user",
              attachments,
              null,
              undefined,
              { activateConversation: command.payload.activate },
            );
            retainedAttachmentsAccepted = true;
            attachmentOwnershipAccepted = true;
            await dependencies.attachmentResolver?.releaseAll(
              sourceAttachments.map(({ id }) => id),
            );
          }
          if (
            conversation.title === "New chat"
            || conversation.title === "New thread"
          ) {
            dependencies.store.updateConversation(conversation.id, {
              title: command.payload.content.slice(0, 64),
            });
          }
          dependencies.send(socket, queued
            ? {
                type: "request.result",
                requestId: command.requestId,
                result: {
                  kind: "message.accepted",
                  conversationId: queued.turn.conversationId,
                  turnId: queued.turn.id,
                  userMessageId: queued.message.id,
                  disposition: "new-turn",
                },
              }
            : {
                // Provider-disabled desktop fixtures persist transcript-only
                // messages and therefore have no authoritative turn to name.
                type: "request.ok",
                requestId: command.requestId,
              });
          dependencies.broadcast({
            type: "conversation.detail.invalidated",
            conversationId: conversation.id,
          });
          dependencies.broadcastSnapshot();
          if (queued) dependencies.turns.start(queued.turn.id);
          if (providerTransitionReserved) {
            dependencies.providerTerminalResumes.release(conversation.id);
            providerTransitionReserved = false;
          }
          return "handled";
        } catch (error) {
          if (providerTransitionReserved) {
            dependencies.providerTerminalResumes.release(conversation.id);
            providerTransitionReserved = false;
          }
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
          if (!await dependencies.workspaceRuns.stopManagedAction(activity.id)) {
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
