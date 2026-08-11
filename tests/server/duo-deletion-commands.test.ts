import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppSnapshot,
  ClientCommand,
  Conversation,
} from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
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
  removeWorktree: vi.fn(async () => undefined),
  restoreCheckpoint: vi.fn(async () => undefined),
}));

vi.mock("../../src/server/checkpoints", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/checkpoints")>(),
  deleteCheckpoints: sideEffects.deleteCheckpoints,
  restoreCheckpoint: sideEffects.restoreCheckpoint,
}));

vi.mock("../../src/server/git", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git")>(),
  removeOwnedWorktree: sideEffects.removeOwnedWorktree,
  removeWorktree: sideEffects.removeWorktree,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const worktreePath = "/workspace/.inertia/worktrees/duo-side";

const conversation = {
  id: conversationId,
  projectId,
  worktreePath,
} as Conversation;

const conversationDelete: ClientCommand = {
  type: "conversation.delete",
  requestId: "33333333-3333-4333-8333-333333333333",
  payload: { conversationId },
};

const projectRemove: Extract<
  ClientCommand,
  { type: "project.remove" }
> = {
  type: "project.remove",
  requestId: "44444444-4444-4444-8444-444444444444",
  payload: { projectId },
};

const conversationArchive: ClientCommand = {
  type: "conversation.archive",
  requestId: "55555555-5555-4555-8555-555555555555",
  payload: { conversationId },
};

const conversationSettle: ClientCommand = {
  type: "conversation.settle",
  requestId: "66666666-6666-4666-8666-666666666666",
  payload: { conversationId },
};

const ownedWorktree = {
  conversationId,
  path: worktreePath,
  branch: "inertia/duo-side",
  ownsWorktree: true,
  creationState: "created",
  ownershipToken: "77777777-7777-4777-8777-777777777777",
  worktreeId: "duo-side",
  repositoryIdentity: "a".repeat(64),
  filesystemReceipt: {
    version: 1,
    worktreesDirectory: { device: "1", inode: "2", birthtimeNs: "3" },
    adminDirectory: { device: "1", inode: "4", birthtimeNs: "5" },
  },
  branchHead: "b".repeat(40),
} as const;

function conversationDependencies(
  store: Partial<RuntimeStore>,
): ConversationCommandDependencies {
  return {
    store: {
      providerRunOwnership: { forConversation: vi.fn(() => []) },
      ...store,
    } as RuntimeStore,
    providers: {} as never,
    backendProfileController: {} as never,
    workspaceRuns: {} as never,
    providerTerminalResumes: {
      isActive: vi.fn(() => false),
      acquireAtCheckout: vi.fn(() => true),
      release: vi.fn(),
    } as never,
    runtimeSync: {} as never,
    deletedConversationIds: new Set(),
    dataDirectory: "/data",
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    publicError: (error) => String(error),
    send: vi.fn(),
  };
}

function projectDependencies(
  store: Partial<RuntimeStore>,
): ProjectWorkspaceCommandDependencies {
  const conversationWork = {
    reserveProviderCheckouts: vi.fn(() => ["project-delete:0"]),
    providerReservationsExactlyCover: vi.fn(() => true),
    release: vi.fn(),
  };
  return {
    store: {
      hasRecordedActiveWorkspaceRunForProject: vi.fn(() => false),
      project: vi.fn(() => ({ id: projectId, path: "/workspace" }) as never),
      conversationWork,
      ...store,
    } as RuntimeStore,
    workspaceRuns: {} as never,
    turns: {
      isActive: vi.fn(() => false),
      hasActiveCheckout: vi.fn(() => false),
    } as never,
    providers: {} as never,
    providerTerminalResumes: { isActive: vi.fn(() => false) } as never,
    terminals: {} as never,
    secureFiles: {} as never,
    secureFileAuthorities: {} as never,
    workspacePath: vi.fn(() => "/workspace"),
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  };
}

describe("Duo deletion command preflights", () => {
  beforeEach(() => {
    sideEffects.deleteCheckpoints.mockClear();
    sideEffects.removeOwnedWorktree.mockClear();
    sideEffects.removeWorktree.mockClear();
    sideEffects.restoreCheckpoint.mockClear();
    sideEffects.removeOwnedWorktree.mockResolvedValue("absent");
  });

  it("rejects a live paired chat before worktree, checkpoint, or cache effects", async () => {
    const assertConversationDeletionAllowed = vi.fn(() => {
      throw new Error(
        "Cancel the active Duo launch before deleting this thread.",
      );
    });
    const store: Partial<RuntimeStore> = {
      conversation: vi.fn(() => conversation),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => false),
      assertConversationDeletionAllowed,
      conversationWorktrees: {
        get: vi.fn(() => ownedWorktree),
      } as never,
      projectPath: vi.fn(() => "/workspace"),
      shellSnapshot: vi.fn(),
      deleteConversation: vi.fn(),
    };
    const dependencies = conversationDependencies(store);
    const handler = createConversationCommandHandler(dependencies);

    await expect(handler({} as never, conversationDelete)).rejects.toThrow(
      "Cancel the active Duo launch before deleting this thread.",
    );

    expect(assertConversationDeletionAllowed).toHaveBeenCalledWith(
      conversationId,
    );
    expect(sideEffects.removeOwnedWorktree).not.toHaveBeenCalled();
    expect(sideEffects.deleteCheckpoints).not.toHaveBeenCalled();
    expect(store.shellSnapshot).not.toHaveBeenCalled();
    expect(store.deleteConversation).not.toHaveBeenCalled();
    expect(dependencies.rememberDeletedConversation).not.toHaveBeenCalled();
    expect(dependencies.forgetRemoteTranscript).not.toHaveBeenCalled();
  });

  it("deletes terminal paired history after the read-only chat preflight", async () => {
    const assertConversationDeletionAllowed = vi.fn();
    const deleteConversation = vi.fn();
    const store: Partial<RuntimeStore> = {
      conversation: vi.fn(() => conversation),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => false),
      assertConversationDeletionAllowed,
      conversationWorktrees: {
        get: vi.fn(() => ownedWorktree),
      } as never,
      projectPath: vi.fn(() => "/workspace"),
      shellSnapshot: vi.fn(() => ({
        conversations: [conversation],
      }) as AppSnapshot),
      deleteConversation,
    };
    const dependencies = conversationDependencies(store);
    const handler = createConversationCommandHandler(dependencies);

    await expect(handler({} as never, conversationDelete))
      .resolves.toBe("mutation");

    expect(assertConversationDeletionAllowed).toHaveBeenCalledBefore(
      sideEffects.removeOwnedWorktree,
    );
    expect(assertConversationDeletionAllowed).toHaveBeenCalledBefore(
      sideEffects.deleteCheckpoints,
    );
    expect(sideEffects.removeOwnedWorktree).toHaveBeenCalledWith(
      "/workspace",
      worktreePath,
      ownedWorktree.branch,
      ownedWorktree.branchHead,
      ownedWorktree.worktreeId,
      ownedWorktree.repositoryIdentity,
      ownedWorktree.ownershipToken,
      ownedWorktree.filesystemReceipt,
    );
    expect(sideEffects.deleteCheckpoints).toHaveBeenCalledWith(
      "/workspace",
      conversationId,
    );
    expect(deleteConversation).toHaveBeenCalledWith(conversationId);
    expect(dependencies.rememberDeletedConversation).toHaveBeenCalledWith(
      conversationId,
    );
    expect(dependencies.forgetRemoteTranscript).toHaveBeenCalledWith(
      conversationId,
    );
  });

  it("preserves a registered owned worktree and its chat for manual removal", async () => {
    sideEffects.removeOwnedWorktree.mockResolvedValueOnce("retained");
    const deleteConversation = vi.fn();
    const store: Partial<RuntimeStore> = {
      conversation: vi.fn(() => conversation),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => false),
      assertConversationDeletionAllowed: vi.fn(),
      conversationWorktrees: {
        get: vi.fn(() => ownedWorktree),
      } as never,
      projectPath: vi.fn(() => "/workspace"),
      shellSnapshot: vi.fn(() => ({ conversations: [conversation] }) as AppSnapshot),
      deleteConversation,
    };
    const dependencies = conversationDependencies(store);

    await expect(createConversationCommandHandler(dependencies)(
      {} as never,
      conversationDelete,
    )).rejects.toThrow(/registered.*remove.*manually/iu);

    expect(sideEffects.deleteCheckpoints).not.toHaveBeenCalled();
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(dependencies.rememberDeletedConversation).not.toHaveBeenCalled();
    expect(dependencies.forgetRemoteTranscript).not.toHaveBeenCalled();
  });

  it("holds the resume reservation while asynchronous worktree deletion runs", async () => {
    let finishRemoval!: () => void;
    sideEffects.removeOwnedWorktree.mockImplementationOnce(() => new Promise<"absent">((resolve) => {
      finishRemoval = () => resolve("absent");
    }));
    const store: Partial<RuntimeStore> = {
      conversation: vi.fn(() => conversation),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => false),
      assertConversationDeletionAllowed: vi.fn(),
      conversationWorktrees: {
        get: vi.fn(() => ownedWorktree),
      } as never,
      projectPath: vi.fn(() => "/workspace"),
      shellSnapshot: vi.fn(() => ({ conversations: [conversation] }) as AppSnapshot),
      deleteConversation: vi.fn(),
    };
    const dependencies = conversationDependencies(store);
    const reservations = new ProviderTerminalResumeRegistry();
    dependencies.providerTerminalResumes = reservations;
    const pending = createConversationCommandHandler(dependencies)(
      {} as never,
      conversationDelete,
    );

    await vi.waitFor(() => expect(sideEffects.removeOwnedWorktree).toHaveBeenCalled());
    expect(reservations.isActive(conversationId)).toBe(true);
    expect(reservations.acquire(conversationId)).toBe(false);
    finishRemoval();
    await expect(pending).resolves.toBe("mutation");
    expect(reservations.isActive(conversationId)).toBe(false);
  });

  it("holds the resume reservation while checkpoint restore rewrites the worktree", async () => {
    let finishRestore!: () => void;
    sideEffects.restoreCheckpoint.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishRestore = () => resolve(undefined);
    }));
    const checkpointId = "77777777-7777-4777-8777-777777777777";
    const store: Partial<RuntimeStore> = {
      checkpoint: vi.fn(() => ({
        id: checkpointId,
        conversationId,
        ref: "refs/inertia/checkpoints/duo-side",
      }) as never),
      conversationPath: vi.fn(() => worktreePath),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
    };
    const dependencies = projectDependencies(store);
    const reservations = new ProviderTerminalResumeRegistry();
    dependencies.providerTerminalResumes = reservations;
    const pending = createProjectWorkspaceCommandHandler(dependencies)(
      {} as never,
      {
        type: "checkpoint.revert",
        requestId: "88888888-8888-4888-8888-888888888888",
        payload: { conversationId, checkpointId },
      },
    );

    await vi.waitFor(() => expect(sideEffects.restoreCheckpoint).toHaveBeenCalled());
    expect(reservations.isActive(conversationId)).toBe(true);
    expect(reservations.acquire(conversationId)).toBe(false);
    finishRestore();
    await expect(pending).resolves.toBe("handled");
    expect(reservations.isActive(conversationId)).toBe(false);
  });

  it.each([
    [conversationArchive, "archiving"],
    [conversationSettle, "settling"],
    [conversationDelete, "deleting"],
  ] as const)("blocks %s while a resumed provider terminal owns the chat", async (command, action) => {
    const store: Partial<RuntimeStore> = {
      conversation: vi.fn(() => conversation),
      hasActiveWorkspaceRunForConversation: vi.fn(() => false),
      archiveConversation: vi.fn(),
      settleConversation: vi.fn(),
      deleteConversation: vi.fn(),
      conversationWorktrees: {
        get: vi.fn(() => null),
      } as never,
    };
    const dependencies = conversationDependencies(store);
    dependencies.providerTerminalResumes = {
      isActive: vi.fn(() => true),
      acquire: vi.fn(() => false),
      acquireAtCheckout: vi.fn(() => false),
      release: vi.fn(),
    } as never;
    const handler = createConversationCommandHandler(dependencies);

    await expect(handler({} as never, command)).rejects.toThrow(
      `End the resumed provider terminal before ${action} this thread.`,
    );
    expect(store.archiveConversation).not.toHaveBeenCalled();
    expect(store.settleConversation).not.toHaveBeenCalled();
    expect(store.deleteConversation).not.toHaveBeenCalled();
    expect(sideEffects.removeWorktree).not.toHaveBeenCalled();
  });

  it("rejects a live paired project before deletion-cache effects", async () => {
    const assertProjectDeletionAllowed = vi.fn(() => {
      throw new Error(
        "Cancel the active Duo launch before removing this project.",
      );
    });
    const store: Partial<RuntimeStore> = {
      hasActiveWorkspaceRunForProject: vi.fn(() => false),
      assertProjectDeletionAllowed,
      shellSnapshot: vi.fn(() => ({ conversations: [] }) as never),
      removeProject: vi.fn(),
    };
    const dependencies = projectDependencies(store);
    const handler = createProjectWorkspaceCommandHandler(dependencies);

    await expect(handler({} as never, projectRemove)).rejects.toThrow(
      "Cancel the active Duo launch before removing this project.",
    );

    expect(assertProjectDeletionAllowed).toHaveBeenCalledWith(projectId);
    expect(store.shellSnapshot).toHaveBeenCalledTimes(2);
    expect(store.removeProject).not.toHaveBeenCalled();
    expect(dependencies.rememberDeletedConversation).not.toHaveBeenCalled();
    expect(dependencies.forgetRemoteTranscript).not.toHaveBeenCalled();
  });

  it("rechecks resumed terminals acquired while Duo project recovery is awaiting", async () => {
    let finishRecovery!: (value: boolean) => void;
    const recovery = new Promise<boolean>((resolve) => {
      finishRecovery = resolve;
    });
    const removeProject = vi.fn();
    const store: Partial<RuntimeStore> = {
      shellSnapshot: vi.fn(() => ({ conversations: [conversation] }) as never),
      hasActiveWorkspaceRunForProject: vi.fn(() => false),
      assertProjectDeletionAllowed: vi.fn(),
      removeProject,
    };
    const dependencies = projectDependencies(store);
    const resumes = new ProviderTerminalResumeRegistry();
    dependencies.providerTerminalResumes = resumes;
    dependencies.duoLaunches = {
      reconcileProjectDeletion: vi.fn(() => recovery),
    };
    const pending = createProjectWorkspaceCommandHandler(dependencies)(
      {} as never,
      projectRemove,
    );
    await vi.waitFor(() => expect(
      dependencies.duoLaunches?.reconcileProjectDeletion,
    ).toHaveBeenCalledOnce());

    expect(resumes.acquire(conversationId)).toBe(true);
    finishRecovery(true);
    await expect(pending).rejects.toThrow(/End resumed provider terminals/u);
    expect(removeProject).not.toHaveBeenCalled();
    resumes.release(conversationId);
  });

  it("updates deletion caches only after terminal project removal succeeds", async () => {
    const assertProjectDeletionAllowed = vi.fn();
    const removeProject = vi.fn();
    const store: Partial<RuntimeStore> = {
      hasActiveWorkspaceRunForProject: vi.fn(() => false),
      assertProjectDeletionAllowed,
      shellSnapshot: vi.fn(() => ({
        conversations: [conversation],
      }) as AppSnapshot),
      removeProject,
    };
    const dependencies = projectDependencies(store);
    const handler = createProjectWorkspaceCommandHandler(dependencies);

    await expect(handler({} as never, projectRemove))
      .resolves.toBe("mutation");

    expect(assertProjectDeletionAllowed).toHaveBeenCalledBefore(removeProject);
    expect(removeProject).toHaveBeenCalledWith(projectId);
    expect(removeProject).toHaveBeenCalledBefore(
      dependencies.rememberDeletedConversation as ReturnType<typeof vi.fn>,
    );
    expect(removeProject).toHaveBeenCalledBefore(
      dependencies.forgetRemoteTranscript as ReturnType<typeof vi.fn>,
    );
  });

  it("removes stale project history using stored checkout paths", async () => {
    const missingProjectPath = "/missing/project-checkout";
    const missingWorktreePath = "/missing/conversation-worktree";
    const missingConversation = {
      ...conversation,
      worktreePath: missingWorktreePath,
    };
    const removeProject = vi.fn();
    const store: Partial<RuntimeStore> = {
      project: vi.fn(() => ({
        id: projectId,
        path: missingProjectPath,
      }) as never),
      shellSnapshot: vi.fn(() => ({
        conversations: [missingConversation],
      }) as AppSnapshot),
      assertProjectDeletionAllowed: vi.fn(),
      removeProject,
    };
    const dependencies = projectDependencies(store);
    const reserveProviderCheckouts = vi.mocked(
      dependencies.store.conversationWork.reserveProviderCheckouts,
    );
    reserveProviderCheckouts.mockReturnValue([
      "project-delete:0",
      "project-delete:1",
    ]);
    const providerReservationsExactlyCover = vi.mocked(
      dependencies.store.conversationWork.providerReservationsExactlyCover,
    );
    dependencies.workspacePath = vi.fn(() => {
      throw new Error("Missing paths must not require privileged resolution.");
    });

    await expect(createProjectWorkspaceCommandHandler(dependencies)(
      {} as never,
      projectRemove,
    )).resolves.toBe("mutation");

    const storedWorkspaces = [
      { projectId, checkoutPath: missingProjectPath },
      { projectId, checkoutPath: missingWorktreePath },
    ];
    expect(dependencies.workspacePath).not.toHaveBeenCalled();
    expect(reserveProviderCheckouts).toHaveBeenCalledWith(
      `project-delete:${projectRemove.requestId}`,
      storedWorkspaces,
    );
    expect(providerReservationsExactlyCover).toHaveBeenCalledWith(
      ["project-delete:0", "project-delete:1"],
      storedWorkspaces,
    );
    expect(removeProject).toHaveBeenCalledWith(projectId);
  });

  it("keeps stale project history when its stored checkout is reserved", async () => {
    const missingProjectPath = "/missing/project-checkout";
    const removeProject = vi.fn();
    const dependencies = projectDependencies({
      project: vi.fn(() => ({
        id: projectId,
        path: missingProjectPath,
      }) as never),
      shellSnapshot: vi.fn(() => ({ conversations: [] }) as unknown as AppSnapshot),
      removeProject,
    });
    vi.mocked(dependencies.store.conversationWork.reserveProviderCheckouts)
      .mockReturnValue(null);
    dependencies.workspacePath = vi.fn(() => {
      throw new Error("Missing paths must not require privileged resolution.");
    });

    await expect(createProjectWorkspaceCommandHandler(dependencies)(
      {} as never,
      projectRemove,
    )).rejects.toThrow("Stop active work for this project");

    expect(dependencies.workspacePath).not.toHaveBeenCalled();
    expect(removeProject).not.toHaveBeenCalled();
  });

  it("blocks project removal while one of its chats owns a resumed terminal", async () => {
    const removeProject = vi.fn();
    const store: Partial<RuntimeStore> = {
      hasActiveWorkspaceRunForProject: vi.fn(() => false),
      assertProjectDeletionAllowed: vi.fn(),
      shellSnapshot: vi.fn(() => ({ conversations: [conversation] }) as AppSnapshot),
      removeProject,
    };
    const dependencies = projectDependencies(store);
    dependencies.providerTerminalResumes = {
      isActive: vi.fn(() => true),
    } as never;

    await expect(createProjectWorkspaceCommandHandler(dependencies)(
      {} as never,
      projectRemove,
    )).rejects.toThrow("End resumed provider terminals for this project");
    expect(removeProject).not.toHaveBeenCalled();
  });
});
