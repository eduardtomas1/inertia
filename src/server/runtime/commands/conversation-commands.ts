import type WebSocket from "ws";
import { resolve } from "node:path";

import type { ConversationAttachmentStore } from "../../../node/conversation-attachment-store";

import {
  type Conversation,
  type ServerEvent,
} from "../../../shared/contracts";
import {
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../../shared/continuation-policy";
import {
  nativeModelSelection,
  type ModelSelection,
} from "../../../shared/model-routing";
import { deleteCheckpoints } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import {
  inspectUnacknowledgedWorktreeCreation,
  removeOwnedWorktree,
} from "../../git";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { ProviderManager } from "../../providers";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import { ConversationCreationService } from "../conversation-creation-service";
import type { DuoLaunchCoordinator } from "../duo/duo-launch-coordinator";
import type { RuntimeSyncHub } from "../runtime-sync-hub";
import type { WorkspaceRunController } from "../workspace-run-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import { ConversationContextService } from "../conversation-context-service";

type ConversationUpdatePayload = Extract<
  Parameters<RuntimeCommandHandler>[1],
  { type: "conversation.update" }
>["payload"];

function requestedConversationModelSelection(
  current: Conversation,
  update: ConversationUpdatePayload,
): ModelSelection {
  if (update.modelSelection) return update.modelSelection;
  if (
    update.providerId === undefined
    && update.model === undefined
    && update.reasoningEffort === undefined
  ) {
    return current.modelSelection;
  }

  const providerId = update.providerId ?? current.providerId;
  const providerChanged = providerId !== current.providerId;
  return nativeModelSelection({
    providerId,
    modelId: update.model ?? (
      providerChanged ? "provider-default" : current.modelSelection.modelId
    ),
    alias: update.model ?? (
      providerChanged ? null : current.modelSelection.alias
    ),
    reasoningEffort: update.reasoningEffort ?? (
      providerChanged ? null : current.modelSelection.reasoningEffort
    ),
    providerOptions: providerChanged
      ? {}
      : current.modelSelection.providerOptions,
  });
}

export interface ConversationCommandDependencies {
  store: RuntimeStore;
  conversationAttachments: ConversationAttachmentStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  runtimeSync: RuntimeSyncHub<WebSocket>;
  duoLaunches?: Pick<
    DuoLaunchCoordinator,
    "reconcileConversationDeletion"
  >;
  deletedConversationIds: Set<string>;
  dataDirectory: string;
  rememberDeletedConversation(conversationId: string): void;
  forgetRemoteTranscript(conversationId: string): void;
  broadcastSnapshot(): void;
  publicError(error: unknown): string;
  send(socket: WebSocket, event: ServerEvent): void;
  testHooks?: {
    afterIsolatedWorktreeCreate?: () => void | Promise<void>;
  };
  creation?: ConversationCreationService;
}

export function createConversationCommandHandler(
  dependencies: ConversationCommandDependencies,
): RuntimeCommandHandler {
  const creation = dependencies.creation
    ?? new ConversationCreationService(dependencies);
  return defineRuntimeCommandHandler([
    "conversation.create",
    "conversation.select",
    "conversation.detail.load",
    "conversation.detail.subscription",
    "conversation.context.source.load",
    "conversation.context.create",
    "conversation.context.load",
    "conversation.context.remove",
    "conversation.update",
    "conversation.archive",
    "conversation.unarchive",
    "conversation.settle",
    "conversation.unsettle",
    "conversation.delete",
  ], async (socket, command) => {
    switch (command.type) {
      case "conversation.create": {
        const conversation = await creation.create(
          command.payload,
          command.requestId,
        );
        if (command.payload.activate !== false) return "mutation";
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.created",
            conversationId: conversation.id,
          },
        });
        return "handled";
      }
      case "conversation.select":
        dependencies.store.selectConversation(
          command.payload.conversationId,
        );
        return "mutation";
      case "conversation.detail.load": {
        const { conversationId } = command.payload;
        dependencies.runtimeSync.ensureConversationSubscription(
          socket,
          conversationId,
        );
        const sync = dependencies.runtimeSync.cursor();
        if (dependencies.deletedConversationIds.has(conversationId)) {
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "conversation.detail",
              conversationId,
              state: "deleted",
              sync,
            },
          });
          return "handled";
        }
        try {
          const detail = dependencies.store.conversationDetail(
            conversationId,
          );
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: detail
              ? {
                  kind: "conversation.detail",
                  conversationId,
                  state: "ready",
                  detail,
                  sync,
                }
              : {
                  kind: "conversation.detail",
                  conversationId,
                  state: "missing",
                  sync,
                },
          });
        } catch (error) {
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "conversation.detail",
              conversationId,
              state: "failed",
              message: dependencies.publicError(error),
              sync,
            },
          });
        }
        return "handled";
      }
      case "conversation.detail.subscription":
        dependencies.runtimeSync.setConversationSubscription(
          socket,
          command.payload.owner,
          command.payload.conversationId,
        );
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      case "conversation.context.source.load": {
        const { sourceConversationId, targetConversationId } = command.payload;
        const service = new ConversationContextService(dependencies.store);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.context.source",
            source: service.sourceTranscript(
              sourceConversationId,
              targetConversationId,
            ),
          },
        });
        return "handled";
      }
      case "conversation.context.create": {
        const service = new ConversationContextService(dependencies.store);
        const packet = service.createFromRenderer(command.payload);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "conversation.context.packet", packet },
        });
        dependencies.runtimeSync.broadcast({
          type: "conversation.detail.invalidated",
          conversationId: command.payload.targetConversationId,
        });
        return "handled";
      }
      case "conversation.context.load": {
        const service = new ConversationContextService(dependencies.store);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.context.packet",
            packet: service.load(
              command.payload.packetId,
              command.payload.targetConversationId,
            ),
          },
        });
        return "handled";
      }
      case "conversation.context.remove": {
        const service = new ConversationContextService(dependencies.store);
        service.remove(
          command.payload.packetId,
          command.payload.targetConversationId,
        );
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        dependencies.runtimeSync.broadcast({
          type: "conversation.detail.invalidated",
          conversationId: command.payload.targetConversationId,
        });
        return "handled";
      }
      case "conversation.update": {
        const {
          conversationId,
          pinned,
          snoozedUntil,
          ...update
        } = command.payload;
        const current = dependencies.store.conversation(conversationId);
        if (
          dependencies.backendProfileController.isExternalSelection(
            current.modelSelection,
          )
          && update.modelSelection === undefined
          && (
            update.model !== undefined
            || update.reasoningEffort !== undefined
          )
        ) {
          throw new RuntimeRequestError(
            "External backend model and reasoning changes require a verified model selection.",
          );
        }
        const changesSelection = (
          update.providerId !== undefined
          || update.modelSelection !== undefined
          || update.model !== undefined
          || update.reasoningEffort !== undefined
        );
        let canonicalSelection: ModelSelection | null = null;
        let canonicalProviderId: Conversation["providerId"] | null = null;
        if (changesSelection) {
          const selection = dependencies.backendProfileController
            .validateSelection(
              requestedConversationModelSelection(
                current,
                command.payload,
              ),
            );
          const route = dependencies.providers.resolveModelRoute(selection);
          if (
            update.providerId !== undefined
            && update.providerId !== route.providerId
          ) {
            throw new RuntimeRequestError(
              "The selected provider does not match the verified model route.",
            );
          }
          canonicalSelection = selection;
          canonicalProviderId = route.providerId;
          const latestTurn = dependencies.store
            .latestAgentTurnForConversation(conversationId);
          const decision = resolveContinuationDecision({
            previousIdentity: latestTurn?.continuationIdentity
              ?? current.continuationIdentity
              ?? null,
            nextIdentity: route.continuationIdentity,
            previousModelId: latestTurn?.modelSelection.modelId
              ?? (
                current.continuationIdentity
                  ? current.modelSelection.modelId
                  : null
              ),
            nextModelId: selection.modelId,
            hasProviderSession: current.providerSessionId !== null,
            hasTurns: latestTurn !== null,
            allowsModelSwitchWithinSession:
              officiallyAllowsModelSwitchWithinSession(route.compatibility),
            allowsPerformanceModeSwitchWithinSession:
              officiallyAllowsFastModeSwitchWithinSession(route.compatibility)
              && dependencies.backendProfileController
                .supportsNativeFastModeControl(selection),
          });
          if (decision.action === "new-conversation-required") {
            throw new RuntimeRequestError(decision.reason);
          }
        }
        const changesRunConfiguration = (
          update.providerId !== undefined
          || update.modelSelection !== undefined
          || update.model !== undefined
          || update.reasoningEffort !== undefined
          || update.interactionMode !== undefined
          || update.accessMode !== undefined
        );
        if (changesRunConfiguration) {
          try {
            dependencies.store.assertDuoComparisonTurnAllowed(
              conversationId,
            );
          } catch (error) {
            throw new RuntimeRequestError(
              error instanceof Error
                ? error.message
                : "That judge chat is reserved for a Duo comparison.",
            );
          }
        }
        if (
          changesRunConfiguration
          && dependencies.store.hasActiveWorkspaceRunForConversation(
            conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before changing its agent configuration.",
          );
        }
        const canonicalUpdate = canonicalSelection && canonicalProviderId
          ? {
              ...update,
              providerId: canonicalProviderId,
              modelSelection: canonicalSelection,
            }
          : update;
        if (canonicalSelection) {
          delete canonicalUpdate.model;
          delete canonicalUpdate.reasoningEffort;
        }
        dependencies.store.updateConversation(conversationId, {
          ...canonicalUpdate,
          pinnedAt: pinned === undefined
            ? current.pinnedAt ?? null
            : pinned ? new Date().toISOString() : null,
          snoozedUntil: snoozedUntil === undefined
            ? current.snoozedUntil ?? null
            : snoozedUntil,
        });
        return "mutation";
      }
      case "conversation.archive":
        if (dependencies.providerTerminalResumes.isActive(command.payload.conversationId)) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before archiving this thread.",
          );
        }
        if (
          dependencies.store.hasActiveWorkspaceRunForConversation(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before archiving this thread.",
          );
        }
        dependencies.store.archiveConversation(
          command.payload.conversationId,
          true,
        );
        dependencies.forgetRemoteTranscript(command.payload.conversationId);
        return "mutation";
      case "conversation.unarchive":
        dependencies.store.archiveConversation(
          command.payload.conversationId,
          false,
        );
        return "mutation";
      case "conversation.settle":
        if (dependencies.providerTerminalResumes.isActive(command.payload.conversationId)) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before settling this thread.",
          );
        }
        if (
          dependencies.store.hasActiveWorkspaceRunForConversation(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before settling this thread.",
          );
        }
        dependencies.store.settleConversation(
          command.payload.conversationId,
          true,
        );
        return "mutation";
      case "conversation.unsettle":
        dependencies.store.settleConversation(
          command.payload.conversationId,
          false,
        );
        return "mutation";
      case "conversation.delete": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        let ownership = dependencies.store.conversationWorktrees.get(
          conversation.id,
        );
        const checkoutPath = conversation.worktreePath
          ?? ownership?.path
          ?? dependencies.store.projectPath(conversation.projectId);
        const deletionReservationId = `conversation-delete:${command.requestId}`;
        if (!dependencies.providerTerminalResumes.acquireAtCheckout(
          conversation.id,
          conversation.projectId,
          checkoutPath,
          deletionReservationId,
        )) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before deleting this thread.",
          );
        }
        try {
          if (dependencies.store.providerRunOwnership.forConversation(
            conversation.id,
          ).length > 0) {
            throw new RuntimeRequestError(
              "Provider process cleanup is unconfirmed. Keep this thread and its checkout until Inertia confirms the prior runtime process tree stopped.",
            );
          }
          if (
            dependencies.duoLaunches
            && !await dependencies.duoLaunches.reconcileConversationDeletion(
              conversation.id,
              deletionReservationId,
            )
          ) {
            throw new RuntimeRequestError(
              "Cancel the active Duo launch, acknowledge an interrupted dispatch, or cancel the locked comparison before deleting this thread.",
            );
          }
          if (
            dependencies.store.hasRecordedActiveWorkspaceRunForConversation(
              conversation.id,
            )
          ) {
            throw new RuntimeRequestError(
              "Stop the active run or review before deleting this thread.",
            );
          }
          try {
            dependencies.store.assertConversationDeletionAllowed(
              conversation.id,
            );
          } catch (error) {
            if (
              error instanceof Error
              && error.message.includes("Cancel the active Duo launch")
            ) throw new RuntimeRequestError(error.message);
            throw error;
          }
          if (ownership?.creationState === "creating") {
            const creation = await inspectUnacknowledgedWorktreeCreation(
              dependencies.store.projectPath(conversation.projectId),
              ownership.path,
              ownership.branch,
            );
            if (creation === "absent") {
              dependencies.store.conversationWorktrees.rejectCreation(
                conversation.id,
              );
              ownership = null;
            } else {
              throw new RuntimeRequestError(
                "Worktree creation was interrupted and Git artifacts remain. Inertia preserved this thread and its ownership receipt. Remove the retained linked worktree and generated branch manually with Git, then delete the thread again.",
              );
            }
          }
          if (ownership?.ownsWorktree) {
            if (
              conversation.worktreePath === null
              || resolve(conversation.worktreePath) !== resolve(ownership.path)
            ) {
              throw new RuntimeRequestError(
                "The isolated worktree no longer matches this thread's ownership receipt.",
              );
            }
            const sharedCheckout = dependencies.store.shellSnapshot()
              .conversations.find((candidate) => (
                candidate.id !== conversation.id
                && candidate.projectId === conversation.projectId
                && candidate.worktreePath !== null
                && resolve(candidate.worktreePath)
                  === resolve(conversation.worktreePath!)
              ));
            if (sharedCheckout) {
              dependencies.store.conversationWorktrees.transfer(
                conversation.id,
                sharedCheckout.id,
              );
            } else {
              const repositoryPath = dependencies.store.projectPath(
                conversation.projectId,
              );
              const removal = await removeOwnedWorktree(
                repositoryPath,
                ownership.path,
                ownership.branch,
                ownership.branchHead,
                ownership.worktreeId,
                ownership.repositoryIdentity,
                ownership.ownershipToken,
                ownership.filesystemReceipt,
              );
              if (removal === "conflict") {
                throw new RuntimeRequestError(
                  "The isolated worktree was replaced or changed ownership, so it was preserved.",
                );
              }
              if (removal === "retained") {
                throw new RuntimeRequestError(
                  "The isolated worktree is still registered. Inertia preserved it because Git cannot atomically verify ownership during removal. Remove this linked worktree manually with Git, then delete the thread again.",
                );
              }
            }
          }
          await deleteCheckpoints(
            dependencies.store.projectPath(conversation.projectId),
            conversation.id,
          ).catch(() => undefined);
          const finalConversation = dependencies.store.conversation(
            command.payload.conversationId,
          );
          const attachmentIds = dependencies.store
            .attachments(finalConversation.id)
            .map(({ id }) => id);
          const contextTargetConversationIds = dependencies.store.contextPackets
            .targetConversationIdsForSource(finalConversation.id);
          dependencies.store.deleteConversation(
            finalConversation.id,
          );
          for (const targetConversationId of contextTargetConversationIds) {
            dependencies.runtimeSync.broadcast({
              type: "conversation.detail.invalidated",
              conversationId: targetConversationId,
            });
          }
          try {
            const referencedAttachmentIds = new Set(
              dependencies.store.attachments().map(({ id }) => id),
            );
            await dependencies.conversationAttachments.release(
              attachmentIds.filter((attachmentId) =>
                !referencedAttachmentIds.has(attachmentId)),
            );
          } catch {
            // Startup reconciliation retries cleanup against authoritative SQL.
          }
          dependencies.rememberDeletedConversation(
            finalConversation.id,
          );
          dependencies.forgetRemoteTranscript(finalConversation.id);
          return "mutation";
        } finally {
          dependencies.providerTerminalResumes.release(conversation.id);
        }
      }
      default:
        return "not-handled";
    }
  });
}
