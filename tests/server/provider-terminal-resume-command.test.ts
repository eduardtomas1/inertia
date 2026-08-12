import { describe, expect, it, vi } from "vitest";

import type { ClientCommand, Conversation, ServerEvent } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import type { RuntimeStore } from "../../src/server/database";
import type { ProviderManager } from "../../src/server/providers";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import type { TerminalManager } from "../../src/server/terminal";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

function conversation(): Conversation {
  const modelSelection = nativeModelSelection({ providerId: "codex" });
  return {
    id: conversationId,
    projectId,
    title: "Owned chat",
    providerId: "codex",
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(
      modelSelection,
      null,
      false,
    ),
    model: "provider-default",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "codex/owned",
    worktreePath: "/workspace/.inertia/worktrees/owned",
    providerSessionId: sessionId,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function resumeCommand(overrides: Partial<{
  projectId: string;
  conversationId: string;
}> = {}): Extract<ClientCommand, { type: "terminal.provider.resume" }> {
  return {
    type: "terminal.provider.resume",
    requestId: "55555555-5555-4555-8555-555555555555",
    payload: {
      projectId: overrides.projectId ?? projectId,
      conversationId: overrides.conversationId ?? conversationId,
      terminalId: "77777777-7777-4777-8777-777777777777",
      cols: 91,
      rows: 31,
    },
  };
}

function dependencies(input: {
  current?: Conversation;
  running?: boolean;
  runningChecks?: boolean[];
  turnActive?: boolean;
  activeCheckout?: boolean;
  activeCheckoutChecks?: boolean[];
  workspaceRunActive?: boolean;
} = {}) {
  const current = input.current ?? conversation();
  const onExitCallbacks: Array<(exitCode: number) => void> = [];
  const send = vi.fn<(socket: never, event: ServerEvent) => void>();
  const workspacePath = vi.fn(() => current.worktreePath!);
  const terminalResumeLaunch = vi.fn(async () => ({
    executable: "/Applications/Codex CLI/codex",
    args: ["resume", sessionId],
    env: { PATH: "/usr/bin" },
  }));
  const replaceProcess = vi.fn((
    _owner: never,
    _terminalId: string,
    _cwd: string,
    _executable: string,
    _args: readonly string[],
    _env: NodeJS.ProcessEnv,
    _cols: number,
    _rows: number,
    onExit?: (exitCode: number) => void,
  ) => {
    if (onExit) onExitCallbacks.push(onExit);
    return "66666666-6666-4666-8666-666666666666";
  });
  const providerTerminalResumes = new ProviderTerminalResumeRegistry();
  const runningChecks = [...(input.runningChecks ?? [])];
  const activeCheckoutChecks = [...(input.activeCheckoutChecks ?? [])];
  const value: ProjectWorkspaceCommandDependencies = {
    store: {
      conversation: vi.fn(() => current),
      hasActiveWorkspaceRunForConversation: vi.fn(() => input.workspaceRunActive ?? false),
      hasRecordedActiveWorkspaceRunForConversation: vi.fn(() => input.workspaceRunActive ?? false),
    } as unknown as RuntimeStore,
    conversationAttachments: {} as never,
    workspaceRuns: {} as never,
    turns: {
      isActive: vi.fn(() => input.turnActive ?? false),
      hasActiveCheckout: vi.fn(() =>
        activeCheckoutChecks.shift() ?? input.activeCheckout ?? false),
    } as never,
    providers: {
      isRunning: vi.fn(() => runningChecks.shift() ?? input.running ?? false),
      terminalResumeLaunch,
    } as unknown as ProviderManager,
    providerTerminalResumes,
    terminals: { replaceProcess } as unknown as TerminalManager,
    secureFiles: {} as never,
    secureFileAuthorities: {} as never,
    workspacePath,
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    send: send as never,
  };
  return {
    value,
    send,
    workspacePath,
    terminalResumeLaunch,
    replaceProcess,
    onExitCallbacks,
    providerTerminalResumes,
  };
}

describe("terminal.provider.resume command", () => {
  it("derives the exact launch and owning worktree entirely on the server", async () => {
    const fixture = dependencies();
    const handler = createProjectWorkspaceCommandHandler(fixture.value);
    await expect(handler({ readyState: 1 } as never, resumeCommand())).resolves.toBe("handled");

    expect(fixture.workspacePath).toHaveBeenCalledWith(projectId, conversationId);
    expect(fixture.terminalResumeLaunch).toHaveBeenCalledWith(
      "codex",
      sessionId,
      "/workspace/.inertia/worktrees/owned",
    );
    expect(fixture.replaceProcess).toHaveBeenCalledWith(
      expect.anything(),
      "77777777-7777-4777-8777-777777777777",
      "/workspace/.inertia/worktrees/owned",
      "/Applications/Codex CLI/codex",
      ["resume", sessionId],
      { PATH: "/usr/bin" },
      91,
      31,
      expect.any(Function),
    );
    expect(fixture.send).toHaveBeenCalledWith(expect.anything(), {
      type: "terminal.created",
      requestId: "55555555-5555-4555-8555-555555555555",
      terminalId: "66666666-6666-4666-8666-666666666666",
      providerResume: {
        providerId: "codex",
        providerLabel: "Codex",
        sessionId,
      },
    });
  });

  it("rejects cross-project, missing, non-native, and active sessions before spawning", async () => {
    const cases: Array<{ current: Conversation; running?: boolean; message: string }> = [];
    const missing = conversation();
    missing.providerSessionId = null;
    cases.push({ current: missing, message: "No resumable provider CLI session" });
    const custom = conversation();
    custom.continuationIdentity = {
      ...custom.continuationIdentity!,
      backendProfileId: "custom:openai",
    };
    cases.push({ current: custom, message: "native CLI session store" });
    const invalid = conversation();
    invalid.providerSessionId = "--continue";
    cases.push({ current: invalid, message: "identifier is invalid or stale" });
    cases.push({ current: conversation(), running: true, message: "Stop the active provider session" });

    const crossProject = dependencies();
    const crossProjectHandler = createProjectWorkspaceCommandHandler(crossProject.value);
    await expect(crossProjectHandler(
      {} as never,
      resumeCommand({ projectId: otherProjectId }),
    )).rejects.toThrow("does not belong to this project");
    expect(crossProject.terminalResumeLaunch).not.toHaveBeenCalled();

    for (const testCase of cases) {
      const fixture = dependencies(testCase);
      const handler = createProjectWorkspaceCommandHandler(fixture.value);
      await expect(handler({ readyState: 1 } as never, resumeCommand())).rejects.toThrow(testCase.message);
      expect(fixture.terminalResumeLaunch).not.toHaveBeenCalled();
      expect(fixture.replaceProcess).not.toHaveBeenCalled();
    }
  });

  it("allows only one resumed terminal per chat until lifecycle cleanup", async () => {
    const fixture = dependencies();
    const handler = createProjectWorkspaceCommandHandler(fixture.value);
    await handler({ readyState: 1 } as never, resumeCommand());
    await expect(handler({ readyState: 1 } as never, resumeCommand())).rejects.toThrow(
      "Stop the active provider session",
    );

    fixture.onExitCallbacks[0]!(0);
    await expect(handler({ readyState: 1 } as never, resumeCommand())).resolves.toBe("handled");
    expect(fixture.replaceProcess).toHaveBeenCalledTimes(2);
  });

  it("abandons the launch if an app provider turn starts during CLI detection", async () => {
    const fixture = dependencies({ runningChecks: [false, true] });
    const handler = createProjectWorkspaceCommandHandler(fixture.value);

    await expect(handler({ readyState: 1 } as never, resumeCommand())).rejects.toThrow(
      "Stop the active provider session",
    );
    expect(fixture.terminalResumeLaunch).toHaveBeenCalledOnce();
    expect(fixture.replaceProcess).not.toHaveBeenCalled();
    expect(fixture.providerTerminalResumes.isActive(conversationId)).toBe(false);
  });

  it("abandons discovery if the owning socket disconnects before spawn", async () => {
    let completeDiscovery!: (launch: {
      executable: string;
      args: string[];
      env: { PATH: string };
    }) => void;
    const fixture = dependencies();
    fixture.terminalResumeLaunch.mockImplementation(() => new Promise((resolve) => {
      completeDiscovery = resolve;
    }));
    const socket = { readyState: 1 };
    const handler = createProjectWorkspaceCommandHandler(fixture.value);
    const pending = handler(socket as never, resumeCommand());

    socket.readyState = 3;
    completeDiscovery({
      executable: "/Applications/Codex CLI/codex",
      args: ["resume", sessionId],
      env: { PATH: "/usr/bin" },
    });

    await expect(pending).rejects.toThrow("connection closed");
    expect(fixture.replaceProcess).not.toHaveBeenCalled();
    expect(fixture.providerTerminalResumes.isActive(conversationId)).toBe(false);
  });

  it("rejects a queued or active Inertia turn before and after discovery", async () => {
    const before = dependencies({ turnActive: true });
    await expect(createProjectWorkspaceCommandHandler(before.value)(
      { readyState: 1 } as never,
      resumeCommand(),
    )).rejects.toThrow("Stop the active provider session");
    expect(before.terminalResumeLaunch).not.toHaveBeenCalled();

    const after = dependencies();
    const activeChecks = [false, true];
    vi.mocked(after.value.turns.isActive).mockImplementation(() => activeChecks.shift() ?? true);
    await expect(createProjectWorkspaceCommandHandler(after.value)(
      { readyState: 1 } as never,
      resumeCommand(),
    )).rejects.toThrow("Stop the active provider session");
    expect(after.replaceProcess).not.toHaveBeenCalled();
  });

  it("rejects an agent in a sibling chat sharing the checkout before and after discovery", async () => {
    const before = dependencies({ activeCheckout: true });
    await expect(createProjectWorkspaceCommandHandler(before.value)(
      { readyState: 1 } as never,
      resumeCommand(),
    )).rejects.toThrow("Stop the active provider session");
    expect(before.terminalResumeLaunch).not.toHaveBeenCalled();

    const after = dependencies({ activeCheckoutChecks: [false, true] });
    await expect(createProjectWorkspaceCommandHandler(after.value)(
      { readyState: 1 } as never,
      resumeCommand(),
    )).rejects.toThrow("Stop the active provider session");
    expect(after.terminalResumeLaunch).toHaveBeenCalledOnce();
    expect(after.replaceProcess).not.toHaveBeenCalled();
    expect(after.providerTerminalResumes.isActive(conversationId)).toBe(false);
  });

  it("rejects another workspace run that owns the conversation worktree", async () => {
    const fixture = dependencies({ workspaceRunActive: true });
    await expect(createProjectWorkspaceCommandHandler(fixture.value)(
      { readyState: 1 } as never,
      resumeCommand(),
    )).rejects.toThrow("Stop the active provider session");
    expect(fixture.terminalResumeLaunch).not.toHaveBeenCalled();
  });

  it("blocks checkpoint restore while the resumed terminal owns the worktree", async () => {
    const fixture = dependencies();
    const checkpointId = "88888888-8888-4888-8888-888888888888";
    Object.assign(fixture.value.store, {
      checkpoint: vi.fn(() => ({
        id: checkpointId,
        conversationId,
        ref: "refs/inertia/checkpoints/owned",
      })),
    });
    fixture.providerTerminalResumes.acquire(conversationId);

    await expect(createProjectWorkspaceCommandHandler(fixture.value)(
      { readyState: 1 } as never,
      {
        type: "checkpoint.revert",
        requestId: "99999999-9999-4999-8999-999999999999",
        payload: { conversationId, checkpointId },
      },
    )).rejects.toThrow("Stop active work, reviews, or resumed terminals");
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
