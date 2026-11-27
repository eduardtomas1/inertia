import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRIVATE_CONNECT_SOCKET_CLOSE } from "../../src/shared/private-connect/protocol";

const STATE_VALIDATOR = "A".repeat(43);
const CONVERSATION_VALIDATOR = "B".repeat(43);

const closeListeners = new Set<(code: number) => void>();
let notifyClose: ((code: number) => void) | null = null;
let validStateProjection = true;
let projectedConversationId = "33333333-3333-4333-8333-333333333333";
const socket = {
  request: vi.fn(async (request: { type: string; requestId?: string }) => request.type === "state.get"
    ? { type: "response", requestId: request.requestId ?? "11111111-1111-4111-8111-111111111111", ok: true, result: { kind: "state", validator: STATE_VALIDATOR, state: validStateProjection ? { generatedAt: "2030-01-01T00:00:00.000Z", projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Project" }], conversations: [{ id: "33333333-3333-4333-8333-333333333333", projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }], capabilities: { scopes: ["private:read"], preset: "monitor", expiresAt: "2030-02-01T00:00:00.000Z" } } : {} } }
    : { type: "response", requestId: request.requestId ?? "44444444-4444-4444-8444-444444444444", ok: true, result: { kind: "conversation", validator: CONVERSATION_VALIDATOR, detail: { generatedAt: "2030-01-01T00:00:00.000Z", conversation: { id: projectedConversationId, projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }, messages: [], questions: [], waitingForLocalAction: false } } }),
  onClose: vi.fn((listener: (code: number) => void) => { notifyClose = listener; closeListeners.add(listener); return () => closeListeners.delete(listener); }),
  close: vi.fn(),
};

vi.mock("../../src/renderer/private-connect/src/connection", () => ({
  apiRequest: vi.fn(async (request: { type: string }) => socket.request(request)),
  browserDeviceId: () => "55555555-5555-4555-8555-555555555555",
  connectPrivateConnectSocket: vi.fn(async () => socket),
  jsonRequest: vi.fn(),
  parsePairingFragment: () => null,
}));

import App from "../../src/renderer/private-connect/src/App";
import {
  apiRequest,
  connectPrivateConnectSocket,
} from "../../src/renderer/private-connect/src/connection";

afterEach(() => {
  closeListeners.clear();
  notifyClose = null;
  validStateProjection = true;
  projectedConversationId = "33333333-3333-4333-8333-333333333333";
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Private Connect browser lifecycle", () => {
  it("shows an explicit shell-only offline state without claiming transcript persistence", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network unavailable");
    }));
    render(<App initialPairingFragment={null} />);

    expect(screen.getByRole("heading", { name: "Your Inertia computer is offline" })).toBeInTheDocument();
    expect(screen.getByText(/Conversations and API responses are never stored/iu)).toBeInTheDocument();
  });

  it("opens an authorized conversation from a content-free deep link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(
      <App
        initialPairingFragment={null}
        initialConversationId="33333333-3333-4333-8333-333333333333"
      />,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument());
  });

  it("surfaces a successful response with a malformed projection", async () => {
    validStateProjection = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);

    await waitFor(() => expect(screen.getByText("Private Connect returned an invalid state projection.")).toBeInTheDocument());
  });

  it("uses the HTTP projection path when only the live socket cannot open", async () => {
    vi.mocked(connectPrivateConnectSocket).mockRejectedValueOnce(Object.assign(
      new Error("Private Connect could not open a live connection."),
      { privateConnectTransport: "private-connect-websocket" },
    ));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));

    render(<App initialPairingFragment={null} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state.get" }),
      "csrf-token",
    ));
    expect(screen.getByRole("heading", { name: "Your workspace" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
  });

  it("rejects conversation detail outside the requested conversation scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
    projectedConversationId = "99999999-9999-4999-8999-999999999999";
    fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));

    await waitFor(() => expect(screen.getByText("Private Connect returned a conversation outside the requested scope.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Conversation" })).not.toBeInTheDocument();
  });

  it("clears cached workspace data when access is revoked over the live connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.accessRevoked);
    await waitFor(() => expect(screen.getByText("This browser no longer has access. Pair it again from the desktop.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Your workspace" })).not.toBeInTheDocument();
  });

  it("keeps cached workspace data and retries after a temporary host pause", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;
    const initialApiCalls = vi.mocked(apiRequest).mock.calls.length;
    vi.useFakeTimers();
    act(() => notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable));
    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument();
    expect(screen.queryByText(/pair it again/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.mocked(apiRequest).mock.calls.length).toBeGreaterThan(initialApiCalls);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(vi.mocked(connectPrivateConnectSocket)).toHaveBeenCalledTimes(initialConnectCalls + 1);
  });

  it("marks the host unavailable only when the HTTP fallback also fails, then recovers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;
    vi.mocked(apiRequest).mockRejectedValueOnce(new TypeError("HTTP transport unavailable"));

    vi.useFakeTimers();
    await act(async () => {
      notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(/Offline — showing only data/iu)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(vi.mocked(connectPrivateConnectSocket)).toHaveBeenCalledTimes(initialConnectCalls + 1);
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
  });

  it("demotes an unresponsive live socket and starts the reconnect cycle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;
    socket.close.mockClear();
    socket.request.mockRejectedValueOnce(Object.assign(
      new Error("The Private Connect live request timed out."),
      { privateConnectTransport: "private-connect-websocket" },
    ));
    socket.close.mockImplementationOnce(() => {
      notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(socket.close).toHaveBeenCalled();
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(vi.mocked(connectPrivateConnectSocket)).toHaveBeenCalledTimes(initialConnectCalls + 1);
  });

  it("purges stale authority and reconnects without requiring another pairing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;

    vi.useFakeTimers();
    act(() => notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.authorityChanged));

    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.queryByText(/pair it again/iu)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(vi.mocked(connectPrivateConnectSocket)).toHaveBeenCalledTimes(initialConnectCalls + 1);
  });

  it("reuses validators so unchanged polling does not replace cached projections", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument());

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(socket.request).toHaveBeenCalledWith(expect.objectContaining({
      type: "state.get",
      ifNoneMatch: STATE_VALIDATOR,
    }));
    expect(socket.request).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation.get",
      ifNoneMatch: CONVERSATION_VALIDATOR,
    }));
  });

  it("S52 + S58 + S59: reloads on socket reconnect and ignores stale HTTP failure/response after authority reset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    const staleTask = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "proj-1",
      projectName: "Repo",
      title: "Stale task",
      scheduleLabel: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2030-01-01T00:30:00.000Z",
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      consecutiveFailures: 0,
      boundConversationId: null,
    };
    const countListCalls = (): number =>
      socket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length
      + vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;

    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(countListCalls()).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    const beforeReconnect = countListCalls();

    // 1. Ordinary socket reconnect keeps same CSRF, shell, and online state -> reloads scheduled tasks.
    vi.useFakeTimers();
    await act(async () => {
      notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(countListCalls()).toBeGreaterThan(beforeReconnect);

    // 2. S58 + S65: Disconnect socket so Refresh uses HTTP apiRequest; accept a DISTINCT replacement socket
    // while state.get is still pending (before the replacement list starts!), then reject the old HTTP list -> workspace stays online!
    let rejectStaleHttp!: (err: unknown) => void;
    const staleHttpRejectPromise = new Promise((_, reject) => { rejectStaleHttp = reject; });
    vi.mocked(apiRequest).mockImplementation((req) => {
      if ((req as { type?: string }).type === "scheduled-tasks.list") {
        return staleHttpRejectPromise as ReturnType<typeof apiRequest>;
      }
      return Promise.resolve({ type: "response", requestId: (req as { requestId: string }).requestId, ok: true, result: { kind: "not-modified" } }) as ReturnType<typeof apiRequest>;
    });
    const httpCallsBefore = vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;
    act(() => notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length).toBe(httpCallsBefore + 1);

    // Distinct replacement socket with one-shot close listener & pending state.get (so replacement list has NOT started yet).
    const replacementCloseListeners = new Set<(code: number) => void>();
    let replacementNotifyClose: ((code: number) => void) | null = null;
    const baseSocketImpl = socket.request.getMockImplementation()!;
    const replacementSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => {
        if (req.type === "state.get") return new Promise<unknown>(() => undefined) as ReturnType<typeof socket.request>;
        return baseSocketImpl(req);
      }),
      onClose: vi.fn((listener: (code: number) => void) => {
        replacementCloseListeners.add(listener);
        replacementNotifyClose = (code: number) => {
          const snapshot = [...replacementCloseListeners];
          replacementCloseListeners.clear();
          for (const fn of snapshot) fn(code);
        };
        return () => replacementCloseListeners.delete(listener);
      }),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket).mockResolvedValueOnce(replacementSocket as never);
    // Clear workspace via authorityChanged on next socket ONLY AFTER verifying S65 while shell is empty:
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    // Now reject the old HTTP request BEFORE replacement list starts -> transportGeneration guard keeps workspace online!
    await act(async () => {
      rejectStaleHttp(new TypeError("Old HTTP transport failed before replacement list"));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();

    // 3. S59 + S66: Start a deferred HTTP list while disconnected, establish a distinct replacement socket with one-shot close,
    // close THAT replacement socket with authorityChanged while HTTP response is pending, then resolve stale HTTP -> discarded!
    let resolveStaleAuth!: (value: unknown) => void;
    const staleAuthPromise = new Promise((resolve) => { resolveStaleAuth = resolve; });
    vi.mocked(apiRequest).mockImplementation((req) => {
      if ((req as { type?: string }).type === "scheduled-tasks.list") {
        return staleAuthPromise as ReturnType<typeof apiRequest>;
      }
      return Promise.resolve({ type: "response", requestId: (req as { requestId: string }).requestId, ok: true, result: { kind: "not-modified" } }) as ReturnType<typeof apiRequest>;
    });
    act(() => replacementNotifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable));
    const authHttpBefore = vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length).toBe(authHttpBefore + 1);
    const authCloseListeners = new Set<(code: number) => void>();
    let authNotifyClose: ((code: number) => void) | null = null;
    const authSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => baseSocketImpl(req)),
      onClose: vi.fn((listener: (code: number) => void) => {
        authCloseListeners.add(listener);
        authNotifyClose = (code: number) => {
          const snapshot = [...authCloseListeners];
          authCloseListeners.clear();
          for (const fn of snapshot) fn(code);
        };
        return () => authCloseListeners.delete(listener);
      }),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket).mockResolvedValueOnce(authSocket as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    act(() => authNotifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.authorityChanged));
    await act(async () => {
      resolveStaleAuth({
        type: "response",
        requestId: "stale-auth",
        ok: true,
        result: { kind: "scheduled-tasks", tasks: [staleTask] },
      });
      await Promise.resolve();
    });
    expect(screen.queryByText("Stale task")).not.toBeInTheDocument();
  });

  it("S59: discards out-of-order scheduled-tasks.list responses when a newer request completes first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    const makeTask = (id: string, title: string) => ({
      id,
      projectId: "proj-1",
      projectName: "Repo",
      title,
      scheduleLabel: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2030-01-01T00:30:00.000Z",
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      consecutiveFailures: 0,
      boundConversationId: null,
    });
    const firstTask = makeTask("22222222-2222-4222-8222-222222222222", "First slow task");
    const newerTask = makeTask("33333333-3333-4333-8333-333333333333", "Newer fast task");

    const baseImpl = socket.request.getMockImplementation()!;
    const pendingLists: Array<(value: unknown) => void> = [];
    socket.request.mockImplementation((req: { type: string; requestId?: string }) => {
      if (req.type === "scheduled-tasks.list") {
        return new Promise<unknown>((resolve) => { pendingLists.push(resolve); }) as ReturnType<typeof socket.request>;
      }
      return baseImpl(req);
    });
    vi.mocked(apiRequest).mockImplementation((req: { type: string; requestId?: string }) => {
      if (req.type === "scheduled-tasks.list") {
        return new Promise<unknown>((resolve) => { pendingLists.push(resolve); }) as ReturnType<typeof apiRequest>;
      }
      return baseImpl(req) as ReturnType<typeof apiRequest>;
    });

    try {
      render(<App initialPairingFragment={null} />);
      await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
      await waitFor(() => expect(pendingLists.length).toBeGreaterThanOrEqual(1));
      await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
      const firstIndex = pendingLists.length - 1;

      // Reconnect while request #1 is still in flight -> starts request #2 concurrently.
      vi.useFakeTimers();
      await act(async () => {
        notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(pendingLists.length).toBeGreaterThan(firstIndex + 1);
      const firstResolve = pendingLists[firstIndex]!;
      const secondResolve = pendingLists[pendingLists.length - 1]!;

      // Newer request #2 completes first.
      await act(async () => {
        secondResolve({ type: "response", requestId: "req-2", ok: true, result: { kind: "scheduled-tasks", tasks: [newerTask] } });
        await Promise.resolve();
      });
      expect(screen.getByText("Newer fast task")).toBeInTheDocument();

      // Older request #1 completes later -> sequence guard must discard it!
      await act(async () => {
        firstResolve({ type: "response", requestId: "req-1", ok: true, result: { kind: "scheduled-tasks", tasks: [firstTask] } });
        await Promise.resolve();
      });
      expect(screen.getByText("Newer fast task")).toBeInTheDocument();
      expect(screen.queryByText("First slow task")).not.toBeInTheDocument();
    } finally {
      socket.request.mockImplementation(baseImpl);
    }
  });
});
