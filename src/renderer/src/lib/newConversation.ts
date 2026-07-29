import type {
  AppSettings,
  ClientCommand,
  Conversation,
  GitStatusSnapshot,
  ModelSelection,
  Project,
} from "@shared/contracts";
import {
  legacyProviderIdForHarness,
  nativeModelSelection,
} from "../../../shared/model-routing";

type ConversationCreateCommand = Extract<ClientCommand, { type: "conversation.create" }>;

export type NewConversationPayload = ConversationCreateCommand["payload"];

export type NewConversationLocation =
  | { kind: "defaults" }
  | { kind: "branch"; branch: string }
  | { kind: "worktree"; branch: string | null; path: string }
  | { kind: "isolated-worktree" };

export type ConversationContextMismatch = {
  expectedBranch: string | null;
  actualBranch: string | null;
  expectedCheckoutPath: string;
  actualCheckoutPath: string;
  branchDiffers: boolean;
  checkoutDiffers: boolean;
};

const newConversationDefaults = (
  settings: AppSettings,
): Pick<
  NewConversationPayload,
  "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode"
> => ({
  providerId: settings.defaultProvider,
  model: settings.defaultModel,
  reasoningEffort: settings.defaultReasoningEffort,
  interactionMode: settings.defaultInteractionMode,
  accessMode: settings.defaultAccessMode,
});

/**
 * New chats deliberately start from a small allowlist. In particular, this
 * function never accepts a viewed Conversation, so its provider session,
 * checkout, transcript, continuation, and per-turn state cannot leak into an
 * ordinary new chat.
 */
export function buildNewConversationPayload(
  projectId: string,
  settings: AppSettings,
  location: NewConversationLocation = { kind: "defaults" },
): NewConversationPayload {
  const base: NewConversationPayload = {
    projectId,
    title: "New chat",
    ...newConversationDefaults(settings),
  };

  if (location.kind === "defaults") {
    return {
      ...base,
      useWorktree: settings.newThreadMode === "worktree",
    };
  }
  if (location.kind === "isolated-worktree") {
    return { ...base, useWorktree: true };
  }
  if (location.kind === "worktree") {
    return {
      ...base,
      useWorktree: false,
      branch: location.branch,
      worktreePath: location.path,
    };
  }
  return {
    ...base,
    useWorktree: false,
    branch: location.branch,
    worktreePath: null,
  };
}

export function withNewConversationModelSelection(
  payload: NewConversationPayload,
  selection: ModelSelection,
): NewConversationPayload {
  const providerId = legacyProviderIdForHarness(selection.harnessId);
  if (!providerId) {
    throw new Error("The selected agent harness is unavailable in this build.");
  }
  const {
    providerId: _defaultProviderId,
    model: _defaultModel,
    reasoningEffort: _defaultReasoningEffort,
    ...base
  } = payload;
  return {
    ...base,
    providerId,
    modelSelection: {
      ...selection,
      providerOptions: { ...selection.providerOptions },
      capabilities: selection.capabilities.map((capability) => ({
        ...capability,
      })),
    },
  };
}

export function buildDraftConversation(
  payload: NewConversationPayload,
  options: {
    id?: string;
    now?: string;
  } = {},
): Conversation {
  const selection = payload.modelSelection ?? nativeModelSelection({
    providerId: payload.providerId ?? "codex",
    modelId: payload.model || "provider-default",
    alias: payload.model || null,
    reasoningEffort: payload.reasoningEffort,
  });
  const providerId = legacyProviderIdForHarness(selection.harnessId);
  if (!providerId) {
    throw new Error("The selected agent harness is unavailable in this build.");
  }
  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? crypto.randomUUID(),
    projectId: payload.projectId,
    title: payload.title,
    providerId,
    modelSelection: {
      ...selection,
      providerOptions: { ...selection.providerOptions },
      capabilities: selection.capabilities.map((capability) => ({
        ...capability,
      })),
    },
    continuationIdentity: null,
    model: selection.modelId === "provider-default" ? "" : selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? payload.reasoningEffort ?? "",
    interactionMode: payload.interactionMode ?? "build",
    accessMode: payload.accessMode ?? "supervised",
    status: "idle",
    attentionKind: null,
    branch: payload.branch ?? null,
    worktreePath: payload.worktreePath ?? null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function conversationContextMismatch(
  project: Project | null,
  conversation: Conversation | null,
  status: GitStatusSnapshot | null,
): ConversationContextMismatch | null {
  if (!project || !conversation || !status?.isRepository) return null;

  const expectedCheckoutPath = conversation.worktreePath ?? project.repositoryRoot ?? project.path;
  const actualCheckoutPath = status.root ?? expectedCheckoutPath;
  const branchDiffers = Boolean(
    conversation.branch
      && status.branch
      && conversation.branch !== status.branch,
  );
  const checkoutDiffers = normalizedPath(expectedCheckoutPath) !== normalizedPath(actualCheckoutPath);
  if (!branchDiffers && !checkoutDiffers) return null;

  return {
    expectedBranch: conversation.branch,
    actualBranch: status.branch,
    expectedCheckoutPath,
    actualCheckoutPath,
    branchDiffers,
    checkoutDiffers,
  };
}
