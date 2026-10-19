import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ClientCommand, Conversation } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";

const sideEffects = vi.hoisted(() => ({
  deleteCheckpoints: vi.fn(async () => undefined),
  removeOwnedWorktree: vi.fn(async () => "absent"),
}));

vi.mock("../../src/server/checkpoints", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/checkpoints")>(),
  deleteCheckpoints: sideEffects.deleteCheckpoints,
}));

vi.mock("../../src/server/git", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git")>(),
  removeOwnedWorktree: sideEffects.removeOwnedWorktree,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const siblingId = "33333333-3333-4333-8333-333333333333";
const worktreePath = "/workspace/.inertia/worktrees/app-chat";
const conversation = { id: conversationId, projectId, worktreePath } as Conversation;
const sibling = { id: siblingId, projectId, worktreePath: null } as Conversation;

const ownedWorktree = {
  conversationId,
  path: worktreePath,
  branch: "inertia/app-chat",
  ownsWorktree: true,
  creationState: "created",
  ownershipToken: "77777777-7777-4777-8777-777777777777",
  worktreeId: "app-chat",
  repositoryIdentity: "a".repeat(64),
  filesystemReceipt: {
    version: 1,
    worktreesDirectory: { device: "1", inode: "2", birthtimeNs: "3" },
    adminDirectory: { device: "1", inode: "4", birthtimeNs: "5" },
  },
  branchHead: "b".repeat(40),
} as const;

const conversationDelete: ClientCommand = {
  type: "conversation.delete",
  requestId: "44444444-4444-4444-8444-444444444444",
  payload: { conversationId },
};

const conversationArchive: ClientCommand = {
  type: "conversation.archive",
  requestId: "66666666-6666-4666-8666-666666666666",
  payload: { conversationId },
};

const projectRemove: ClientCommand = {
  type: "project.remove",
  requestId: "55555555-5555-4555-8555-555555555555",
  payload: { projectId },
};

function deleteDependencies(clear: (id: string) => Promise<boolean>): ConversationCommandDependencies {
  return {
    store: {
      conversation: vi.fn(() => conversation),
      project: vi.fn(() => ({ id: projectId, path: "/workspace" }) as never),
      projectPath: vi.fn(() => "/workspace"),
      attachments: vi.fn(() => []),
      referencedAttachmentIds: vi.fn(() => new Set<string>()),
      providerRunOwnership: { forConversation: vi.fn(() => []) },
      contextPackets: {
        targetConversationIdsForSource: vi.fn(() => []),
        hasDraftForTargetWithoutMessages: vi.fn(() => false),
      },
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => false),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      archiveConversation: vi.fn(),
      assertConversationDeletionAllowed: vi.fn(),
      conversationWorktrees: { get: vi.fn(() => ownedWorktree) },
      shellSnapshot: vi.fn(() => ({ conversations: [conversation] }) as AppSnapshot),
      deleteConversation: vi.fn(),
    } as unknown as RuntimeStore,
    conversationAttachments: { release: vi.fn(async () => undefined) } as never,
    providers: {} as never,
    backendProfileController: {} as never,
    workspaceRuns: {} as never,
    providerTerminalResumes: {
      isActive: vi.fn(() => false),
      acquireAtCheckout: vi.fn(() => true),
      release: vi.fn(),
    } as never,
    runtimeSync: { broadcast: vi.fn() } as never,
    deletedConversationIds: new Set(),
    dataDirectory: "/data",
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    clearAppUnderTestSession: vi.fn(clear),
    broadcastSnapshot: vi.fn(),
    publicError: (error) => String(error),
    send: vi.fn(),
  };
}

function removeDependencies(clear: (id: string) => Promise<boolean>): ProjectWorkspaceCommandDependencies {
  return {
    dataDirectory: "/data",
    store: {
      project: vi.fn(() => ({ id: projectId, path: "/workspace", workspaceKind: "repository" }) as never),
      shellSnapshot: vi.fn(() => ({ conversations: [conversation, sibling] }) as AppSnapshot),
      hasRecordedActiveWorkspaceRunForProject: vi.fn(() => false),
      conversationWork: {
        reserveProviderCheckouts: vi.fn(() => ["project-delete:0"]),
        providerReservationsExactlyCover: vi.fn(() => true),
        release: vi.fn(),
      },
      assertProjectDeletionAllowed: vi.fn(),
      attachments: vi.fn(() => []),
      referencedAttachmentIds: vi.fn(() => new Set<string>()),
      removeProject: vi.fn(),
    } as unknown as RuntimeStore,
    conversationAttachments: { release: vi.fn(async () => undefined) } as never,
    workspaceRuns: {} as never,
    turns: { isActive: vi.fn(() => false), hasActiveCheckout: vi.fn(() => false) } as never,
    providers: {} as never,
    providerTerminalResumes: { isActive: vi.fn(() => false) } as never,
    terminals: {} as never,
    secureFiles: {} as never,
    secureFileAuthorities: {} as never,
    workspacePath: vi.fn(() => "/workspace"),
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    clearAppUnderTestSession: vi.fn(clear),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  };
}

describe("App under test cleanup before chat archive, delete and project removal", () => {
  beforeEach(() => {
    sideEffects.deleteCheckpoints.mockClear();
    sideEffects.removeOwnedWorktree.mockClear();
  });

  it("awaits the App session clear, with confirmed termination, before removing the chat's worktree", async () => {
    let finishClear!: (confirmed: boolean) => void;
    const dependencies = deleteDependencies(() => new Promise<boolean>((resolve) => { finishClear = resolve; }));
    const pending = createConversationCommandHandler(dependencies)({} as never, conversationDelete);
    await vi.waitFor(() => expect(dependencies.clearAppUnderTestSession).toHaveBeenCalledWith(conversationId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sideEffects.removeOwnedWorktree).not.toHaveBeenCalled();
    finishClear(true);
    await expect(pending).resolves.toBe("mutation");
    expect(dependencies.clearAppUnderTestSession).toHaveBeenCalledBefore(sideEffects.removeOwnedWorktree);
    expect(dependencies.store.deleteConversation).toHaveBeenCalledWith(conversationId);
  });

  it("keeps the chat and its worktree when the app could not be proved stopped", async () => {
    const dependencies = deleteDependencies(async () => false);
    await expect(createConversationCommandHandler(dependencies)({} as never, conversationDelete))
      .rejects.toThrow("Inertia could not confirm that this thread's app under test stopped. Stop it from the App surface, then delete the thread again.");
    expect(sideEffects.removeOwnedWorktree).not.toHaveBeenCalled();
    expect(sideEffects.deleteCheckpoints).not.toHaveBeenCalled();
    expect(dependencies.store.deleteConversation).not.toHaveBeenCalled();
    expect(dependencies.rememberDeletedConversation).not.toHaveBeenCalled();
    expect(dependencies.providerTerminalResumes.release).toHaveBeenCalledWith(conversationId);
  });

  it("archives a chat only after its App session is proved stopped", async () => {
    const confirmed = deleteDependencies(async () => true);
    await expect(createConversationCommandHandler(confirmed)({} as never, conversationArchive)).resolves.toBe("mutation");
    expect(confirmed.clearAppUnderTestSession).toHaveBeenCalledWith(conversationId);
    expect(confirmed.clearAppUnderTestSession).toHaveBeenCalledBefore(vi.mocked(confirmed.store.archiveConversation));
    expect(confirmed.store.archiveConversation).toHaveBeenCalledWith(conversationId, true);

    const stuck = deleteDependencies(async () => false);
    await expect(createConversationCommandHandler(stuck)({} as never, conversationArchive))
      .rejects.toThrow("Stop the chat's app before archiving it; its process could not be confirmed stopped.");
    expect(stuck.store.archiveConversation).not.toHaveBeenCalled();
    expect(stuck.forgetRemoteTranscript).not.toHaveBeenCalled();
  });

  it("clears every chat's App session before removing a project, and refuses when one is unconfirmed", async () => {
    const confirmed = removeDependencies(async () => true);
    await expect(createProjectWorkspaceCommandHandler(confirmed)({} as never, projectRemove)).resolves.toBe("mutation");
    expect(vi.mocked(confirmed.clearAppUnderTestSession!).mock.calls.map(([id]) => id)).toEqual([conversationId, siblingId]);
    expect(confirmed.clearAppUnderTestSession).toHaveBeenCalledBefore(vi.mocked(confirmed.store.removeProject));

    const stuck = removeDependencies(async (id) => id !== siblingId);
    await expect(createProjectWorkspaceCommandHandler(stuck)({} as never, projectRemove))
      .rejects.toThrow("Inertia could not confirm that this project's apps under test stopped.");
    expect(stuck.store.removeProject).not.toHaveBeenCalled();
    expect(stuck.rememberDeletedConversation).not.toHaveBeenCalled();
    expect(stuck.store.conversationWork.release).toHaveBeenCalledWith("project-delete:0");
  });
});
