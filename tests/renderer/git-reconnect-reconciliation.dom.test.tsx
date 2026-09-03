import { useCallback } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  defaultSettings,
  type Conversation,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { GIT_MUTATION_REQUEST_TIMEOUT_MS } from "../../src/shared/runtime-command-timeouts";
import { useInertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";
import { useWorkspaceGit } from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  RuntimeCommandError,
  runtimeCommandDelivery,
} from "../../src/renderer/src/utils/connectionMessages";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

const project: Project = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Timeout fixture",
  path: "/timeout-fixture",
  normalizedPath: "/timeout-fixture",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#5555ff",
  status: "ready",
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const conversation: Conversation = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: project.id,
  title: "Timeout fixture chat",
  providerId: "codex",
  modelSelection: nativeModelSelection({
    providerId: "codex",
    modelId: "default",
    reasoningEffort: "medium",
  }),
  continuationIdentity: null,
  model: "default",
  reasoningEffort: "medium",
  interactionMode: "build",
  accessMode: "supervised",
  status: "idle",
  attentionKind: null,
  branch: "main",
  worktreePath: null,
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

function sentCommands(socket: FakeWebSocket) {
  return socket.send.mock.calls.map(([data]) =>
    clientCommandSchema.parse(JSON.parse(String(data))));
}

function gitStatusResult(requestId: string, branch: string): ServerEvent {
  return {
    type: "request.result",
    requestId,
    result: {
      kind: "git.status",
      status: {
        isRepository: true,
        authorityRef: "66666666-6666-4666-8666-666666666666",
        root: "/timeout-fixture",
        branch,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
      },
    },
  };
}

function useConnectionGitProjection() {
  const connection = useInertiaConnection();
  const sendCommand = connection.sendCommand;
  const request = useCallback((command: CommandWithoutId) =>
    sendCommand(clientCommandSchema.parse({
      ...command,
      requestId: crypto.randomUUID(),
    })), [sendCommand]);
  const run = useCallback((
    _key: string,
    command: CommandWithoutId,
  ) => request(command), [request]);
  const setActionError = useCallback((_message: string | null) => undefined, []);
  const git = useWorkspaceGit({
    enabled: true,
    loadStatusOnMount: true,
    loadWorkspaceOnMount: false,
    project,
    conversation,
    online: connection.status === "online",
    ignoreWhitespace: false,
    refreshVersion: 0,
    request,
    run,
    subscribe: connection.subscribe,
    setActionError,
  });
  return { connection, git };
}

afterEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "inertia");
});

describe("durable Git reconnect reconciliation", () => {
  it("does not promote an interrupted mounted refresh to a persistent app error", async () => {
    let refreshes = 0;
    let interrupt!: (error: Error) => void;
    const request = vi.fn((command: CommandWithoutId) => {
      if (command.type !== "git.refresh") {
        return Promise.reject(new Error(`Unexpected ${command.type} command`));
      }
      refreshes += 1;
      if (refreshes === 1) {
        return new Promise<ServerEvent>((_resolve, reject) => {
          interrupt = reject;
        });
      }
      return Promise.resolve(gitStatusResult("reconnected-refresh", "main"));
    });
    const setActionError = vi.fn();
    const hook = renderHook(
      ({ online }: { online: boolean }) => useWorkspaceGit({
        enabled: true,
        loadStatusOnMount: true,
        loadWorkspaceOnMount: false,
        project,
        conversation,
        online,
        ignoreWhitespace: false,
        refreshVersion: 0,
        request,
        run: async (_key, command) => await request(command),
        subscribe: () => () => undefined,
        setActionError,
      }),
      { initialProps: { online: true } },
    );

    await waitFor(() => expect(refreshes).toBe(1));
    await act(async () => {
      interrupt(new RuntimeCommandError(
        "The local service disconnected before finishing the request.",
        "ambiguous",
      ));
      await Promise.resolve();
    });
    expect(hook.result.current.loadError)
      .toBe("The local service disconnected before finishing the request.");
    expect(setActionError).not.toHaveBeenCalled();

    hook.rerender({ online: false });
    hook.rerender({ online: true });
    await waitFor(() => {
      expect(refreshes).toBe(2);
      expect(hook.result.current.loadError).toBeNull();
      expect(hook.result.current.gitStatus?.branch).toBe("main");
    });
    expect(setActionError).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "ambiguous transport",
      error: new RuntimeCommandError(
        "The local service disconnected before finishing the request.",
        "ambiguous",
      ),
      promoted: false,
    },
    {
      label: "not-sent transport",
      error: new RuntimeCommandError(
        "The local service disconnected before receiving the request.",
        "not-sent",
      ),
      promoted: false,
    },
    {
      label: "server rejection",
      error: new RuntimeCommandError(
        "The repository is no longer available.",
        "rejected",
      ),
      promoted: true,
    },
    {
      label: "ordinary failure",
      error: new Error("The Git response was unreadable."),
      promoted: true,
    },
  ])("classifies $label invalidation refresh failures", async ({
    error,
    promoted,
  }) => {
    const message = error.message;
    const request = vi.fn((_command: CommandWithoutId) => Promise.reject(
      error,
    ));
    let publish!: (event: ServerEvent) => void;
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: false,
      loadWorkspaceOnMount: false,
      project,
      conversation,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run: async (_key, command) => await request(command),
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      },
      setActionError,
    }));

    act(() => publish({
      type: "workspace.git.invalidated",
      requestId: "99999999-9999-4999-8999-999999999999",
      projectId: project.id,
      conversationId: conversation.id,
    }));

    await waitFor(() => expect(hook.result.current.loadError).toBe(message));
    if (promoted) {
      expect(setActionError).toHaveBeenCalledWith(message);
    } else {
      expect(setActionError).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      label: "ambiguous transport",
      error: new RuntimeCommandError(
        "The local service disconnected before finishing the request.",
        "ambiguous",
      ),
      promoted: false,
    },
    {
      label: "not-sent transport",
      error: new RuntimeCommandError(
        "The local service disconnected before receiving the request.",
        "not-sent",
      ),
      promoted: false,
    },
    {
      label: "server rejection",
      error: new RuntimeCommandError(
        "The repository is no longer available.",
        "rejected",
      ),
      promoted: true,
    },
    {
      label: "ordinary failure",
      error: new Error("The branch response was unreadable."),
      promoted: true,
    },
  ])("classifies $label during passive branch reconciliation", async ({
    error,
    promoted,
  }) => {
    let refreshes = 0;
    let rejectBranches!: (error: unknown) => void;
    const request = vi.fn((command: CommandWithoutId) => {
      if (command.type === "git.refresh") {
        refreshes += 1;
        return Promise.resolve(gitStatusResult(
          `branch-refresh-${refreshes}`,
          "main",
        ));
      }
      if (command.type === "git.branches") {
        return new Promise<ServerEvent>((_resolve, reject) => {
          rejectBranches = reject;
        });
      }
      return Promise.reject(new Error(`Unexpected ${command.type} command`));
    });
    let publish!: (event: ServerEvent) => void;
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceGit({
      enabled: true,
      loadStatusOnMount: true,
      loadWorkspaceOnMount: false,
      project,
      conversation,
      online: true,
      ignoreWhitespace: false,
      refreshVersion: 0,
      request,
      run: async (_key, command) => await request(command),
      subscribe: (listener) => {
        publish = listener;
        return () => undefined;
      },
      setActionError,
    }));

    await waitFor(() => expect(hook.result.current.gitStatus?.branch).toBe("main"));
    setActionError.mockClear();
    act(() => publish({
      type: "workspace.git.invalidated",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: project.id,
      conversationId: conversation.id,
    }));
    await waitFor(() => expect(rejectBranches).toBeTypeOf("function"));
    await act(async () => {
      rejectBranches(error);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.result.current.loadError).toBeNull();
    if (promoted) {
      expect(setActionError).toHaveBeenCalledWith(error.message);
    } else {
      expect(setActionError).not.toHaveBeenCalled();
    }
  });

  it("publishes the final projection after two timeouts and socket loss", async () => {
    const getRuntimeConnection = vi.fn(async () => ({
      websocketUrl: "ws://127.0.0.1:12345/runtime/test",
    }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { getRuntimeConnection },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const hook = renderHook(() => useConnectionGitProjection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const firstSocket = FakeWebSocket.instances[0]!;
    const runtimeGeneration = "runtime-durable-git";
    const initialSync = { runtimeGeneration, latestSequence: 0 };

    act(() => {
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "server.welcome",
          protocolVersion: 1,
          snapshot: {
            projects: [],
            conversations: [],
            runs: [],
            providers: [],
            settings: defaultSettings,
            activeProjectId: null,
            activeConversationId: null,
            sync: initialSync,
          },
          sync: initialSync,
        }),
      }));
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.sync.completed",
          sync: initialSync,
        }),
      }));
    });
    await waitFor(() => expect(sentCommands(firstSocket).filter(
      ({ type }) => type === "git.refresh",
    )).toHaveLength(1), { timeout: 5_000 });
    const initialRefresh = sentCommands(firstSocket).find(
      ({ type }) => type === "git.refresh",
    )!;
    act(() => {
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify(gitStatusResult(initialRefresh.requestId, "main")),
      }));
    });
    await waitFor(() => expect(hook.result.current.git.gitStatus?.branch)
      .toBe("main"));

    vi.useFakeTimers();
    const firstMutationId = "77777777-7777-4777-8777-777777777777";
    let firstTimeout: unknown;
    void hook.result.current.connection.sendCommand(clientCommandSchema.parse({
      type: "git.branch.switch",
      requestId: firstMutationId,
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        name: "feature/first",
      },
    })).catch((error: unknown) => {
      firstTimeout = error;
    });
    await vi.advanceTimersByTimeAsync(GIT_MUTATION_REQUEST_TIMEOUT_MS);
    expect(runtimeCommandDelivery(firstTimeout)).toBe("ambiguous");

    const secondMutationId = "88888888-8888-4888-8888-888888888888";
    let secondTimeout: unknown;
    void hook.result.current.connection.sendCommand(clientCommandSchema.parse({
      type: "git.branch.switch",
      requestId: secondMutationId,
      payload: {
        projectId: project.id,
        conversationId: conversation.id,
        name: "feature/final",
      },
    })).catch((error: unknown) => {
      secondTimeout = error;
    });
    await vi.advanceTimersByTimeAsync(GIT_MUTATION_REQUEST_TIMEOUT_MS);
    expect(runtimeCommandDelivery(secondTimeout)).toBe("ambiguous");

    act(() => {
      firstSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "request.result",
          requestId: firstMutationId,
          result: {
            kind: "git.action",
            message: "Switched to feature/first.",
          },
        }),
      }));
    });
    expect(firstSocket.close).not.toHaveBeenCalled();
    expect(sentCommands(firstSocket).filter(({ type }) => type === "git.refresh"))
      .toHaveLength(1);

    act(() => firstSocket.close());
    expect(hook.result.current.connection.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const secondSocket = FakeWebSocket.instances[1]!;
    expect(secondSocket.url).toContain("runtimeGeneration=runtime-durable-git");

    await act(async () => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.resumed",
          protocolVersion: 1,
          sync: initialSync,
        }),
      }));
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.sync.completed",
          sync: initialSync,
        }),
      }));
      await Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(0);
    const reconnectRefreshes = () => sentCommands(secondSocket).filter(
      ({ type }) => type === "git.refresh",
    );
    expect(reconnectRefreshes()).toHaveLength(1);
    await act(async () => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify(gitStatusResult(
          reconnectRefreshes()[0]!.requestId,
          "feature/first",
        )),
      }));
      await Promise.resolve();
    });
    expect(hook.result.current.git.gitStatus?.branch).toBe("feature/first");

    await act(async () => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime.event",
          sync: { runtimeGeneration, latestSequence: 1 },
          scope: { kind: "shell" },
          event: {
            type: "workspace.git.invalidated",
            requestId: secondMutationId,
            projectId: project.id,
            conversationId: conversation.id,
          },
        }),
      }));
      await Promise.resolve();
    });
    expect(reconnectRefreshes()).toHaveLength(2);
    await act(async () => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify(gitStatusResult(
          reconnectRefreshes()[1]!.requestId,
          "feature/final",
        )),
      }));
      await Promise.resolve();
    });

    expect(hook.result.current.git.gitStatus?.branch).toBe("feature/final");
    const branchRequest = sentCommands(secondSocket).findLast(
      ({ type }) => type === "git.branches",
    );
    expect(branchRequest?.type).toBe("git.branches");
    await act(async () => {
      secondSocket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({
          type: "request.result",
          requestId: branchRequest!.requestId,
          result: {
            kind: "git.branches",
            branches: [{
              name: "feature/final",
              current: true,
              remote: false,
              worktreePath: null,
            }],
          },
        }),
      }));
      await Promise.resolve();
    });
    expect(hook.result.current.git.branches).toEqual([
      expect.objectContaining({ name: "feature/final", current: true }),
    ]);
    expect(reconnectRefreshes()).toHaveLength(2);
    expect(secondSocket.close).not.toHaveBeenCalled();
  });
});
