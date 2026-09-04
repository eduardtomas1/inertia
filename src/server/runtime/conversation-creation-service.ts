import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Conversation, ClientCommand } from "../../shared/contracts";
import {
  providerNativeModelSelection,
  type ModelSelection,
} from "../../shared/model-routing";
import type { RuntimeStore } from "../database";
import {
  createWorktreeWithOwnershipReceipt,
  getRepositoryStatus,
  GitError,
} from "../git";
import type { ProviderManager } from "../providers";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import type { WorkspaceRunController } from "./workspace-run-controller";
import {
  pinWorktreeSourceIdentity,
  verifyWorktreeSourceIdentity,
} from "./worktree-source-identity";

export type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

export interface ConversationCreationDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: Pick<
    WorkspaceRunController<never>,
    "trackSourceControl"
  >;
  dataDirectory: string;
  broadcastSnapshot(): void;
  testHooks?: {
    afterIsolatedWorktreeCreate?: () => void | Promise<void>;
  };
}

/**
 * One privileged creation path shared by renderer commands and host-owned
 * agent tools. Callers control activation and provenance; this service owns
 * route validation, checkout identity, and compensating persistence.
 */
export class ConversationCreationService {
  constructor(private readonly dependencies: ConversationCreationDependencies) {}

  canonicalSelection(payload: ConversationCreatePayload): {
    providerId: Conversation["providerId"];
    selection: ModelSelection;
  } {
    const settings = this.dependencies.store.shellSnapshot().settings;
    const requestedSelection = payload.modelSelection
      ?? providerNativeModelSelection({
        providerId: payload.providerId ?? settings.defaultProvider,
        modelId: payload.model
          || settings.defaultModel
          || "provider-default",
        alias: payload.model || settings.defaultModel || null,
        reasoningEffort: payload.reasoningEffort
          || settings.defaultReasoningEffort
          || null,
      });
    const selection = this.dependencies.backendProfileController
      .validateSelection(requestedSelection, {
        allowUnavailableNativeCatalog: true,
      });
    const providerId = this.dependencies.providers
      .resolveModelRoute(selection).providerId;
    if (payload.providerId !== undefined && payload.providerId !== providerId) {
      throw new RuntimeRequestError(
        "The selected provider does not match the verified model route.",
      );
    }
    return { providerId, selection };
  }

  async create(
    payload: ConversationCreatePayload,
    requestId: string,
  ): Promise<Conversation> {
    const { providerId, selection } = this.canonicalSelection(payload);
    const repositoryPath = this.dependencies.store.projectPath(payload.projectId);
    if (payload.useWorktree && payload.worktreePath) {
      throw new RuntimeRequestError(
        "Choose either an existing worktree or a new isolated worktree.",
      );
    }

    if (payload.worktreePath) {
      const requestedPath = resolve(payload.worktreePath);
      const reusableContext = this.dependencies.store.shellSnapshot()
        .conversations.find((candidate) => (
          candidate.projectId === payload.projectId
          && candidate.worktreePath !== null
          && normalizeIdentityPath(resolve(candidate.worktreePath))
            === normalizeIdentityPath(requestedPath)
        ));
      const reusablePath = reusableContext
        ? this.dependencies.store.conversationPath(reusableContext.id)
        : null;
      if (
        reusablePath === null
        || normalizeIdentityPath(reusablePath)
          !== normalizeIdentityPath(requestedPath)
        || normalizeIdentityPath(requestedPath)
          === normalizeIdentityPath(resolve(repositoryPath))
      ) {
        throw new RuntimeRequestError(
          "That worktree is not attached to a chat in this project.",
        );
      }
      const status = await getRepositoryStatus(reusablePath);
      if (payload.branch && payload.branch !== status.branch) {
        throw new RuntimeRequestError(
          `That worktree is currently on ${status.branch ?? "a detached checkout"}, not ${payload.branch}.`,
        );
      }
      return this.dependencies.store.createConversation(
        payload.projectId,
        payload.title,
        {
          ...payload,
          providerId,
          modelSelection: selection,
          branch: status.branch,
          worktreePath: status.root,
        },
      );
    }

    const worktreeSource = payload.useWorktree
      ? await pinWorktreeSourceIdentity(repositoryPath)
      : null;
    let projectStatus: Awaited<ReturnType<typeof getRepositoryStatus>> | null = null;
    try {
      projectStatus = await getRepositoryStatus(
        worktreeSource?.root ?? repositoryPath,
      );
    } catch (error) {
      if (!(error instanceof GitError && error.code === "not-repository")) {
        throw error;
      }
    }
    if (payload.branch && payload.branch !== projectStatus?.branch) {
      throw new RuntimeRequestError(
        `The project checkout is currently on ${projectStatus?.branch ?? "a detached checkout"}, not ${payload.branch}.`,
      );
    }

    const conversation = this.dependencies.store.createConversation(
      payload.projectId,
      payload.title,
      {
        ...payload,
        providerId,
        modelSelection: selection,
        branch: projectStatus?.branch ?? null,
        worktreePath: null,
      },
    );
    if (!payload.useWorktree) return conversation;

    try {
      if (!worktreeSource) {
        throw new RuntimeRequestError(
          "The project repository identity is unavailable.",
        );
      }
      if (!projectStatus?.branch) {
        throw new RuntimeRequestError(
          "Check out a branch before creating an isolated worktree.",
        );
      }
      const branch = `inertia/${conversation.id.slice(0, 8)}`;
      const target = join(
        this.dependencies.dataDirectory,
        "worktrees",
        conversation.id,
      );
      mkdirSync(resolve(target, ".."), {
        recursive: true,
        mode: 0o700,
      });
      const createdStatus = await this.dependencies.workspaceRuns
        .trackSourceControl(
          "Create worktree",
          payload.projectId,
          conversation.id,
          worktreeSource.root,
          requestId,
          async () => {
            const verifiedRoot = await verifyWorktreeSourceIdentity(
              repositoryPath,
              worktreeSource,
            );
            const created = await createWorktreeWithOwnershipReceipt(
              verifiedRoot,
              target,
              {
                branch,
                createBranch: true,
                startPoint: projectStatus.branch!,
              },
              {
                beforeAdd: (ownershipToken) => {
                  this.dependencies.store.conversationWorktrees.beginCreation(
                    conversation.id,
                    target,
                    branch,
                    ownershipToken,
                  );
                },
                notAdded: () => {
                  this.dependencies.store.conversationWorktrees.rejectCreation(
                    conversation.id,
                  );
                },
                added: (identity) => {
                  this.dependencies.store.conversationWorktrees.recordCreation(
                    conversation.id,
                    target,
                    branch,
                    identity,
                  );
                },
              },
            );
            this.dependencies.store.updateConversation(conversation.id, {
              worktreePath: created.root,
              branch: created.branch ?? branch,
            });
            await this.dependencies.testHooks?.afterIsolatedWorktreeCreate?.();
            await verifyWorktreeSourceIdentity(repositoryPath, worktreeSource);
            return created;
          },
          {
            recoverReviewedCommit: true,
            serializationRoot: worktreeSource.root,
            verifyRepositoryIdentity: async () => {
              await verifyWorktreeSourceIdentity(repositoryPath, worktreeSource);
            },
          },
        );
      return this.dependencies.store.updateConversation(conversation.id, {
        worktreePath: createdStatus.root,
        branch: createdStatus.branch ?? branch,
      });
    } catch (error) {
      const ownership = this.dependencies.store.conversationWorktrees
        .get(conversation.id);
      if (!ownership?.ownsWorktree) {
        this.dependencies.store.deleteConversation(conversation.id);
      } else {
        this.dependencies.broadcastSnapshot();
      }
      throw error;
    }
  }
}
