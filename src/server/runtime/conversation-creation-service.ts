import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Conversation, ClientCommand, ProviderInfo } from "../../shared/contracts";
import { effectiveDefaultProviderId } from "../../shared/default-provider";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
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
import type { NewConversationOptions } from "../persistence/types";
import type { ProviderManager } from "../providers";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import type { TurnController } from "./turns/turn-controller";
import type { WorkspaceRunController } from "./workspace-run-controller";
import { ScratchWorkspace } from "./scratch-workspace";
import {
  pinWorktreeSourceIdentity,
  verifyWorktreeSourceIdentity,
} from "./worktree-source-identity";

export type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

export type ConversationContinuePayload = Extract<
  ClientCommand,
  { type: "conversation.continue" }
>["payload"];

type ConversationInsertion = (insert: () => Conversation) => Conversation;

const CONTINUATION_ADMISSION_TIMEOUT_MS = 1_000;
const SOURCE_BUSY = "Wait for this chat's turn to finish before continuing in a new chat.";

export interface ConversationCreationDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: Pick<
    WorkspaceRunController<never>,
    "trackSourceControl"
  >;
  dataDirectory: string;
  turns?: Pick<TurnController, "acquireTurnAdmission">;
  providerInfo?(): readonly ProviderInfo[];
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

  ensureScratchProject() {
    return new ScratchWorkspace(this.dependencies.store, this.dependencies.dataDirectory).ensureProject();
  }

  canonicalSelection(payload: ConversationCreatePayload): {
    providerId: Conversation["providerId"];
    selection: ModelSelection;
  } {
    const settings = this.dependencies.store.shellSnapshot().settings;
    const defaultProviderId = payload.providerId ?? effectiveDefaultProviderId(
      settings.defaultProvider,
      payload.modelSelection ? [] : this.dependencies.providerInfo?.() ?? [],
    );
    const inherited = payload.providerId !== undefined || defaultProviderId === settings.defaultProvider;
    const defaultModel = inherited ? settings.defaultModel : "";
    const requestedModel = inherited ? payload.model : undefined;
    const requestedSelection = payload.modelSelection
      ?? providerNativeModelSelection({
        providerId: defaultProviderId,
        modelId: requestedModel
          || defaultModel
          || "provider-default",
        alias: requestedModel || defaultModel || null,
        reasoningEffort: (inherited ? payload.reasoningEffort || settings.defaultReasoningEffort : "")
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

  async continueFrom(
    payload: ConversationContinuePayload,
    requestId: string,
  ): Promise<Conversation> {
    const { store } = this.dependencies;
    const source = store.conversation(payload.sourceConversationId);
    if (store.project(source.projectId).workspaceKind === "scratch") {
      throw new RuntimeRequestError("A chat without a project cannot continue in a new chat.");
    }
    const admission = await this.dependencies.turns?.acquireTurnAdmission(
      source.id,
      CONTINUATION_ADMISSION_TIMEOUT_MS,
    );
    if (!admission) throw new RuntimeRequestError(SOURCE_BUSY);
    try {
      return await this.continueWithAdmission(source, payload, requestId);
    } finally {
      admission.release();
    }
  }

  private async continueWithAdmission(
    source: Conversation,
    payload: ConversationContinuePayload,
    requestId: string,
  ): Promise<Conversation> {
    const { store } = this.dependencies;
    this.assertIdle(source.id);
    return await this.create({
      projectId: source.projectId,
      title: "New chat",
      modelSelection: payload.modelSelection,
      interactionMode: payload.interactionMode,
      accessMode: payload.accessMode,
      activate: false,
      useWorktree: false,
      branch: source.branch,
      worktreePath: source.worktreePath,
    }, requestId, (insert) => store.contextPackets.createTargetWithPacket(source.id, () => {
      this.assertIdle(source.id);
      return insert();
    }));
  }

  private assertIdle(conversationId: string): void {
    const { store, providers } = this.dependencies;
    const latest = store.latestAgentTurnForConversation(conversationId);
    if (
      (latest && !isAgentTurnTerminalStatus(latest.status))
      || providers.isRunning(conversationId)
      || store.providerRunOwnership.forConversation(conversationId).length > 0
    ) {
      throw new RuntimeRequestError(SOURCE_BUSY);
    }
  }

  private insert(
    projectId: string,
    title: string,
    options: NewConversationOptions,
    insertion?: ConversationInsertion,
  ): Conversation {
    const insert = () => this.dependencies.store.createConversation(projectId, title, options);
    return insertion ? insertion(insert) : insert();
  }

  async create(
    payload: ConversationCreatePayload,
    requestId: string,
    insertion?: ConversationInsertion,
  ): Promise<Conversation> {
    if (payload.accessMode === undefined) {
      const accessMode = this.dependencies.store.project(payload.projectId).preferences?.defaultAccessMode;
      if (accessMode) payload = { ...payload, accessMode };
    }
    if (this.dependencies.store.project(payload.projectId).workspaceKind === "scratch") {
      if (payload.branch || payload.worktreePath) {
        throw new RuntimeRequestError("A chat without a project gets its own folder; it cannot reuse a branch or worktree.");
      }
      const { providerId, selection } = this.canonicalSelection(payload);
      return new ScratchWorkspace(this.dependencies.store, this.dependencies.dataDirectory).createConversation(
        payload.projectId, payload.title,
        { ...payload, id: payload.draftConversationId, providerId, modelSelection: selection },
      );
    }
    if (payload.useWorktree === undefined && !payload.worktreePath && !payload.branch) {
      const preference = this.dependencies.store.project(payload.projectId).preferences?.workspace;
      if (preference !== undefined && preference !== null) {
        payload = { ...payload, useWorktree: preference === "worktree" };
      }
    }
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
      return this.insert(
        payload.projectId,
        payload.title,
        {
          ...payload,
          id: payload.draftConversationId,
          providerId,
          modelSelection: selection,
          branch: status.branch,
          worktreePath: status.root,
        },
        insertion,
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

    const conversation = this.insert(
      payload.projectId,
      payload.title,
      {
        ...payload,
        id: payload.draftConversationId,
        providerId,
        modelSelection: selection,
        branch: projectStatus?.branch ?? null,
        worktreePath: null,
      },
      insertion,
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
