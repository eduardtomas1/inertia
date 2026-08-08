import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type WebSocket from "ws";

import {
  type Conversation,
  type ServerEvent,
} from "../../../shared/contracts";
import {
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
  createWorktree,
  getRepositoryStatus,
  GitError,
  removeWorktree,
} from "../../git";
import type { ProviderManager } from "../../providers";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { RuntimeSyncHub } from "../runtime-sync-hub";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

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
  });
}

export interface ConversationCommandDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  runtimeSync: RuntimeSyncHub<WebSocket>;
  deletedConversationIds: Set<string>;
  dataDirectory: string;
  rememberDeletedConversation(conversationId: string): void;
  forgetRemoteTranscript(conversationId: string): void;
  broadcastSnapshot(): void;
  publicError(error: unknown): string;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createConversationCommandHandler(
  dependencies: ConversationCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "conversation.create",
    "conversation.select",
    "conversation.detail.load",
    "conversation.detail.subscription",
    "conversation.update",
    "conversation.archive",
    "conversation.unarchive",
    "conversation.settle",
    "conversation.unsettle",
    "conversation.delete",
  ], async (socket, command) => {
    switch (command.type) {
      case "conversation.create": {
        const settings = dependencies.store.shellSnapshot().settings;
        const requestedSelection = command.payload.modelSelection
          ?? nativeModelSelection({
            providerId: command.payload.providerId ?? settings.defaultProvider,
            modelId: command.payload.model
              || settings.defaultModel
              || "provider-default",
            alias: command.payload.model || settings.defaultModel || null,
            reasoningEffort: command.payload.reasoningEffort
              || settings.defaultReasoningEffort
              || null,
          });
        const canonicalCreationSelection =
          dependencies.backendProfileController.validateSelection(
            requestedSelection,
            { allowUnavailableNativeCatalog: true },
          );
        const canonicalCreationProviderId = dependencies.providers
          .resolveModelRoute(canonicalCreationSelection).providerId;
        if (
          command.payload.providerId !== undefined
          && command.payload.providerId !== canonicalCreationProviderId
        ) {
          throw new RuntimeRequestError(
            "The selected provider does not match the verified model route.",
          );
        }
        const finishCreation = (
          conversationId: string,
        ): "handled" | "mutation" => {
          if (command.payload.activate !== false) return "mutation";
          dependencies.broadcastSnapshot();
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "conversation.created", conversationId },
          });
          return "handled";
        };
        const repositoryPath = dependencies.store.projectPath(
          command.payload.projectId,
        );
        if (command.payload.useWorktree && command.payload.worktreePath) {
          throw new RuntimeRequestError(
            "Choose either an existing worktree or a new isolated worktree.",
          );
        }

        if (command.payload.worktreePath) {
          const requestedPath = resolve(command.payload.worktreePath);
          const reusableContext = dependencies.store.shellSnapshot()
            .conversations.find((candidate) => (
              candidate.projectId === command.payload.projectId
              && candidate.worktreePath !== null
              && resolve(candidate.worktreePath) === requestedPath
            ));
          if (
            !reusableContext
            || requestedPath === resolve(repositoryPath)
          ) {
            throw new RuntimeRequestError(
              "That worktree is not attached to a chat in this project.",
            );
          }
          const status = await getRepositoryStatus(requestedPath);
          if (
            command.payload.branch
            && command.payload.branch !== status.branch
          ) {
            throw new RuntimeRequestError(
              `That worktree is currently on ${status.branch ?? "a detached checkout"}, not ${command.payload.branch}.`,
            );
          }
          const conversation = dependencies.store.createConversation(
            command.payload.projectId,
            command.payload.title,
            {
              ...command.payload,
              providerId: canonicalCreationProviderId,
              modelSelection: canonicalCreationSelection,
              branch: status.branch,
              worktreePath: status.root,
            },
          );
          return finishCreation(conversation.id);
        }

        let projectStatus: Awaited<
          ReturnType<typeof getRepositoryStatus>
        > | null = null;
        try {
          projectStatus = await getRepositoryStatus(repositoryPath);
        } catch (error) {
          if (
            !(error instanceof GitError && error.code === "not-repository")
          ) {
            throw error;
          }
        }
        if (
          command.payload.branch
          && command.payload.branch !== projectStatus?.branch
        ) {
          throw new RuntimeRequestError(
            `The project checkout is currently on ${projectStatus?.branch ?? "a detached checkout"}, not ${command.payload.branch}.`,
          );
        }

        const conversation = dependencies.store.createConversation(
          command.payload.projectId,
          command.payload.title,
          {
            ...command.payload,
            providerId: canonicalCreationProviderId,
            modelSelection: canonicalCreationSelection,
            branch: projectStatus?.branch ?? null,
            worktreePath: null,
          },
        );
        if (command.payload.useWorktree) {
          try {
            if (!projectStatus?.branch) {
              throw new RuntimeRequestError(
                "Check out a branch before creating an isolated worktree.",
              );
            }
            const branch = `inertia/${conversation.id.slice(0, 8)}`;
            const target = join(
              dependencies.dataDirectory,
              "worktrees",
              conversation.id,
            );
            mkdirSync(resolve(target, ".."), {
              recursive: true,
              mode: 0o700,
            });
            await dependencies.workspaceRuns.trackSourceControl(
              "Create worktree",
              command.payload.projectId,
              conversation.id,
              repositoryPath,
              command.requestId,
              async () => await createWorktree(
                repositoryPath,
                target,
                {
                  branch,
                  createBranch: true,
                  startPoint: projectStatus.branch!,
                },
              ),
            );
            const createdStatus = await getRepositoryStatus(target);
            dependencies.store.updateConversation(conversation.id, {
              worktreePath: createdStatus.root,
              branch: createdStatus.branch ?? branch,
            });
          } catch (error) {
            dependencies.store.deleteConversation(conversation.id);
            throw error;
          }
        }
        return finishCreation(conversation.id);
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
      case "conversation.update": {
        const { conversationId, ...update } = command.payload;
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
        dependencies.store.updateConversation(
          conversationId,
          canonicalUpdate,
        );
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
        if (!dependencies.providerTerminalResumes.acquire(conversation.id)) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before deleting this thread.",
          );
        }
        try {
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
          if (conversation.worktreePath) {
            const sharedCheckout = dependencies.store.shellSnapshot()
              .conversations.some((candidate) => (
                candidate.id !== conversation.id
                && candidate.projectId === conversation.projectId
                && candidate.worktreePath !== null
                && resolve(candidate.worktreePath)
                  === resolve(conversation.worktreePath!)
              ));
            if (!sharedCheckout) {
              try {
                await removeWorktree(
                  dependencies.store.projectPath(conversation.projectId),
                  conversation.worktreePath,
                  false,
                );
              } catch (error) {
                if (
                  !(error instanceof GitError && error.code === "not-found")
                ) {
                  throw error;
                }
              }
            }
          }
          await deleteCheckpoints(
            dependencies.store.projectPath(conversation.projectId),
            conversation.id,
          ).catch(() => undefined);
          dependencies.store.deleteConversation(
            command.payload.conversationId,
          );
          dependencies.rememberDeletedConversation(
            command.payload.conversationId,
          );
          dependencies.forgetRemoteTranscript(command.payload.conversationId);
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
