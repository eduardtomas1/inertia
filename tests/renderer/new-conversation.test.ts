import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type Conversation,
  type GitStatusSnapshot,
  type Project,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  buildDraftConversation,
  buildNewConversationPayload,
  conversationContextMismatch,
  withNewConversationModelSelection,
} from "../../src/renderer/src/lib/newConversation";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: "git:/workspace/inertia/.git",
  repositoryRoot: "/workspace/inertia",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
};

const viewedConversation: Conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project.id,
  title: "Viewed chat",
  modelSelection: providerNativeModelSelection({
    providerId: "claude",
    modelId: "viewed-model",
    reasoningEffort: "viewed-effort",
  }),
  continuationIdentity: null,
  providerId: "claude",
  model: "viewed-model",
  reasoningEffort: "viewed-effort",
  interactionMode: "plan",
  accessMode: "full",
  status: "completed",
  attentionKind: null,
  branch: "viewed/branch",
  worktreePath: "/workspace/worktrees/viewed",
  providerSessionId: "viewed-provider-session",
  archivedAt: null,
  settledAt: null,
  completedAt: "2026-07-25T10:01:00.000Z",
  lastViewedAt: "2026-07-25T10:01:00.000Z",
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:01:00.000Z",
};

const gitStatus: GitStatusSnapshot & { root: string } = {
  isRepository: true,
  root: "/workspace/inertia",
  branch: "actual/branch",
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  files: [],
  insertions: 0,
  deletions: 0,
};

describe("new conversation isolation", () => {
  it("builds an ordinary new chat only from global defaults", () => {
    const payload = buildNewConversationPayload(project.id, {
      ...defaultSettings,
      defaultProvider: "codex",
      defaultModel: "default-model",
      defaultReasoningEffort: "high",
      defaultInteractionMode: "build",
      defaultAccessMode: "auto-edit",
      newThreadMode: "local",
    });

    expect(payload).toEqual({
      projectId: project.id,
      title: "New chat",
      providerId: "codex",
      model: "default-model",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "auto-edit",
      useWorktree: false,
    });
    expect(payload).not.toHaveProperty("branch");
    expect(payload).not.toHaveProperty("worktreePath");
    expect(payload).not.toHaveProperty("providerSessionId");
    expect(payload).not.toHaveProperty("conversationId");
    expect(payload).not.toHaveProperty("continuation");
  });

  it("uses the isolated-worktree default without accepting viewed chat context", () => {
    const payload = buildNewConversationPayload(project.id, {
      ...defaultSettings,
      newThreadMode: "worktree",
    });

    expect(payload.useWorktree).toBe(true);
    expect(payload).not.toHaveProperty("branch");
    expect(payload).not.toHaveProperty("worktreePath");
    expect(payload).not.toHaveProperty("providerSessionId");
    expect(viewedConversation.providerSessionId).toBe("viewed-provider-session");
  });

  it("derives legacy routing fields from an explicit model selection", () => {
    const payload = withNewConversationModelSelection(
      buildNewConversationPayload(project.id, {
        ...defaultSettings,
        defaultProvider: "codex",
        defaultModel: "stale-default",
        defaultReasoningEffort: "medium",
      }),
      viewedConversation.modelSelection,
    );

    expect(payload.providerId).toBe("claude");
    expect(payload.modelSelection).toEqual(viewedConversation.modelSelection);
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("reasoningEffort");
  });

  it("adds checkout context only for clearly explicit locations", () => {
    expect(buildNewConversationPayload(project.id, defaultSettings, {
      kind: "branch",
      branch: "feature/current",
    })).toMatchObject({
      useWorktree: false,
      branch: "feature/current",
      worktreePath: null,
    });

    expect(buildNewConversationPayload(project.id, defaultSettings, {
      kind: "worktree",
      branch: "feature/current",
      path: "/workspace/worktrees/current",
    })).toMatchObject({
      useWorktree: false,
      branch: "feature/current",
      worktreePath: "/workspace/worktrees/current",
    });

    const isolated = buildNewConversationPayload(project.id, defaultSettings, {
      kind: "isolated-worktree",
    });
    expect(isolated.useWorktree).toBe(true);
    expect(isolated).not.toHaveProperty("branch");
    expect(isolated).not.toHaveProperty("worktreePath");
  });

  it("projects a local draft without creating provider or continuation state", () => {
    const draft = buildDraftConversation(
      withNewConversationModelSelection(
        buildNewConversationPayload(project.id, defaultSettings),
        viewedConversation.modelSelection,
      ),
      {
        id: "33333333-3333-4333-8333-333333333333",
        now: "2026-07-29T10:00:00.000Z",
      },
    );

    expect(draft).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      projectId: project.id,
      title: "New chat",
      providerId: "claude",
      status: "idle",
      providerSessionId: null,
      continuationIdentity: null,
      createdAt: "2026-07-29T10:00:00.000Z",
    });
    expect(draft.modelSelection).toEqual(viewedConversation.modelSelection);
  });

  it("projects Gemini defaults through the current native route", () => {
    const draft = buildDraftConversation(
      buildNewConversationPayload(project.id, {
        ...defaultSettings,
        defaultProvider: "gemini",
        defaultModel: "gemini-2.5-pro",
      }),
      {
        id: "44444444-4444-4444-8444-444444444444",
        now: "2026-07-29T10:02:00.000Z",
      },
    );

    expect(draft).toMatchObject({
      providerId: "gemini",
      modelSelection: {
        harnessId: "gemini-acp",
        backendProfileId: "builtin:gemini",
        backendProfileDisplayName: "Google Gemini",
        modelId: "gemini-2.5-pro",
      },
    });
  });
});

describe("conversation checkout mismatch", () => {
  it("reports persisted branch and worktree differences without treating them as errors", () => {
    expect(conversationContextMismatch(project, viewedConversation, gitStatus)).toEqual({
      expectedBranch: "viewed/branch",
      actualBranch: "actual/branch",
      expectedCheckoutPath: "/workspace/worktrees/viewed",
      actualCheckoutPath: "/workspace/inertia",
      branchDiffers: true,
      checkoutDiffers: true,
    });
  });

  it("does not report matching, incomplete, or non-repository context", () => {
    const matching = {
      ...gitStatus,
      root: viewedConversation.worktreePath!,
      branch: viewedConversation.branch,
    };
    expect(conversationContextMismatch(project, viewedConversation, matching)).toBeNull();
    expect(conversationContextMismatch(project, null, matching)).toBeNull();
    expect(conversationContextMismatch(project, viewedConversation, {
      ...matching,
      isRepository: false,
    })).toBeNull();
  });

  it("does not report Windows checkout paths that differ only by casing and separators", () => {
    const windowsProject = {
      ...project,
      path: "C:\\Users\\Runner\\Project",
      normalizedPath: "c:/users/runner/project",
      repositoryRoot: "c:/users/runner/project",
    };
    const windowsConversation = {
      ...viewedConversation,
      branch: null,
      worktreePath: null,
    };
    expect(conversationContextMismatch(windowsProject, windowsConversation, {
      ...gitStatus,
      root: "C:\\Users\\RUNNER\\Project\\",
      branch: "main",
    })).toBeNull();
  });
});
