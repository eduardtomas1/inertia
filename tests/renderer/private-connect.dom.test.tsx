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
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockImplementation((request) => socket.request(request) as ReturnType<typeof apiRequest>);
  vi.mocked(connectPrivateConnectSocket).mockReset();
  vi.mocked(connectPrivateConnectSocket).mockImplementation(async () => socket as never);
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
    await waitFor(() => expect(screen.getByRole("button", { name: /^Refresh$/i })).toBeInTheDocument());
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;
    const baseApiImpl = vi.mocked(apiRequest).getMockImplementation()!;
    let rejectedStateFallback = false;
    vi.mocked(apiRequest).mockImplementation((req, csrf) => {
      if (!rejectedStateFallback && (req as { type?: string }).type === "state.get") {
        rejectedStateFallback = true;
        return Promise.reject(new TypeError("HTTP transport unavailable")) as ReturnType<typeof apiRequest>;
      }
      return baseApiImpl(req, csrf);
    });

    vi.useFakeTimers();
    await act(async () => {
      notifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(rejectedStateFallback).toBe(true);
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

  it("S52: reloads scheduled tasks on ordinary socket reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
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
  });

  it("S65/S71: stale HTTP request rejected after replacement socket connects with no cached shell stays online", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    vi.mocked(connectPrivateConnectSocket).mockRejectedValueOnce(Object.assign(
      new Error("Private Connect could not open a live connection."),
      { privateConnectTransport: "private-connect-websocket" },
    ));
    let rejectStaleHttp!: (err: unknown) => void;
    const staleHttpPromise = new Promise((_, reject) => { rejectStaleHttp = reject; });
    vi.mocked(apiRequest).mockImplementation((req) => {
      if ((req as { type?: string }).type === "state.get") {
        return staleHttpPromise as ReturnType<typeof apiRequest>;
      }
      return Promise.resolve({ type: "response", requestId: (req as { requestId: string }).requestId, ok: true, result: { kind: "scheduled-tasks", tasks: [] } }) as ReturnType<typeof apiRequest>;
    });

    const replacementCloseListeners = new Set<(code: number) => void>();
    const replacementSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => {
        if (req.type === "state.get") return new Promise<unknown>(() => undefined) as ReturnType<typeof socket.request>;
        return Promise.resolve({ type: "response", requestId: req.requestId ?? "r1", ok: true, result: { kind: "scheduled-tasks", tasks: [] } });
      }),
      onClose: vi.fn((listener: (code: number) => void) => {
        replacementCloseListeners.add(listener);
        return () => replacementCloseListeners.delete(listener);
      }),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket).mockResolvedValueOnce(replacementSocket as never);

    vi.useFakeTimers();
    render(<App initialPairingFragment={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Confirm we started with NO cached shell (no projects/conversations rendered) and HTTP state.get is in flight.
    expect(screen.queryByRole("button", { name: /Conversation/u })).not.toBeInTheDocument();
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(expect.objectContaining({ type: "state.get" }), "csrf-token");

    // Advance retry timer -> distinct replacement socket connects while shell is still null (NO scheduled-tasks.list issued!).
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(replacementSocket.request).toHaveBeenCalledWith(expect.objectContaining({ type: "state.get" }));
    expect(replacementSocket.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "scheduled-tasks.list" }));

    // Reject the superseded HTTP state.get -> transportGenerationRef guard must prevent offline state!
    await act(async () => {
      rejectStaleHttp(new TypeError("Old HTTP transport failed before any replacement list"));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
  });

  it("S66/S72: authorityChanged discards a still-current scheduled-tasks.list resolved before any new list starts", async () => {
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
    const baseSocketImpl = socket.request.getMockImplementation()!;
    let resolveInFlightList!: (value: unknown) => void;
    let deferNextList = false;
    const authCloseListeners = new Set<(code: number) => void>();
    let authNotifyClose: ((code: number) => void) | null = null;
    const authSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => {
        if (req.type === "scheduled-tasks.list") {
          if (deferNextList) {
            return new Promise<unknown>((resolve) => { resolveInFlightList = resolve; });
          }
          return Promise.resolve({ type: "response", requestId: req.requestId ?? "init", ok: true, result: { kind: "scheduled-tasks", tasks: [] } });
        }
        return baseSocketImpl(req);
      }),
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
    const postAuthSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => {
        if (req.type === "scheduled-tasks.list") {
          // Keep the post-reconnect list pending so stale tasks would stay visible if authority invalidation failed!
          return new Promise<unknown>(() => undefined);
        }
        return baseSocketImpl(req);
      }),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket)
      .mockResolvedValueOnce(authSocket as never)
      .mockResolvedValueOnce(postAuthSocket as never);

    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(authSocket.request).toHaveBeenCalledWith(expect.objectContaining({ type: "scheduled-tasks.list" })));

    // Start a deferred Refresh list so it is the ONLY current list request when authorityChanged arrives.
    vi.useFakeTimers();
    deferNextList = true;
    const listCallsBefore = authSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    expect(authSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length).toBe(listCallsBefore + 1);

    // Close with authorityChanged -> clears workspace and bumps authority generation; NO new list has started yet!
    act(() => authNotifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.authorityChanged));
    expect(postAuthSocket.request).not.toHaveBeenCalled();

    // Resolve the old list BEFORE any reconnect / new list starts.
    await act(async () => {
      resolveInFlightList({
        type: "response",
        requestId: "stale-auth",
        ok: true,
        result: { kind: "scheduled-tasks", tasks: [staleTask] },
      });
      await Promise.resolve();
    });

    // Reconnect with postAuthSocket (whose own list stays pending) -> shell renders, staleTask must NEVER appear!
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Stale task")).not.toBeInTheDocument();
  });

  it("S70: HTTP Run now resolves its follow-up scheduled-tasks.list on a newly connected replacement socket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    const task = {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Project",
      title: "Nightly check",
      scheduleLabel: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2030-01-01T00:30:00.000Z",
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      consecutiveFailures: 0,
      boundConversationId: null,
    };
    const promptCapableState = (requestId = "state-1") => ({
      type: "response",
      requestId,
      ok: true,
      result: {
        kind: "state",
        validator: STATE_VALIDATOR,
        state: {
          generatedAt: "2030-01-01T00:00:00.000Z",
          projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Project" }],
          conversations: [{ id: "33333333-3333-4333-8333-333333333333", projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }],
          capabilities: { scopes: ["private:read", "private:prompt"], preset: "collaborate", expiresAt: "2030-02-01T00:00:00.000Z" },
        },
      },
    });
    const firstCloseListeners = new Set<(code: number) => void>();
    let firstNotifyClose: ((code: number) => void) | null = null;
    const firstSocket = {
      request: vi.fn(async (req: { type: string; requestId?: string }) => {
        if (req.type === "state.get") return promptCapableState(req.requestId);
        if (req.type === "scheduled-tasks.list") {
          return { type: "response", requestId: req.requestId ?? "l1", ok: true, result: { kind: "scheduled-tasks", tasks: [task] } };
        }
        return { type: "response", requestId: req.requestId ?? "o1", ok: true, result: { kind: "not-modified", validator: STATE_VALIDATOR } };
      }),
      onClose: vi.fn((listener: (code: number) => void) => {
        firstCloseListeners.add(listener);
        firstNotifyClose = (code: number) => {
          const snapshot = [...firstCloseListeners];
          firstCloseListeners.clear();
          for (const fn of snapshot) fn(code);
        };
        return () => firstCloseListeners.delete(listener);
      }),
      close: vi.fn(),
    };
    const replacementSocket = {
      request: vi.fn(async (req: { type: string; requestId?: string }) => {
        if (req.type === "state.get") return promptCapableState(req.requestId);
        if (req.type === "scheduled-tasks.list") {
          return { type: "response", requestId: req.requestId ?? "l2", ok: true, result: { kind: "scheduled-tasks", tasks: [task] } };
        }
        return { type: "response", requestId: req.requestId ?? "o2", ok: true, result: { kind: "not-modified", validator: STATE_VALIDATOR } };
      }),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket)
      .mockResolvedValueOnce(firstSocket as never)
      .mockResolvedValueOnce(replacementSocket as never);

    let resolveRunNow!: (value: unknown) => void;
    vi.mocked(apiRequest).mockImplementation((req) => {
      const typed = req as { type?: string; requestId?: string };
      if (typed.type === "scheduled-task.run-now") {
        return new Promise<unknown>((resolve) => { resolveRunNow = resolve; }) as ReturnType<typeof apiRequest>;
      }
      if (typed.type === "scheduled-tasks.list") {
        return Promise.reject(new TypeError("Old HTTP list transport is down")) as ReturnType<typeof apiRequest>;
      }
      return Promise.resolve(promptCapableState(typed.requestId)) as ReturnType<typeof apiRequest>;
    });

    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByText("Nightly check")).toBeInTheDocument());

    // Disconnect socket -> click Run now over HTTP.
    vi.useFakeTimers();
    act(() => firstNotifyClose?.(PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable));
    fireEvent.click(screen.getByRole("button", { name: /Run Nightly check now/i }));
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(expect.objectContaining({ type: "scheduled-task.run-now", taskId: task.id }), "csrf-token");

    // Replacement socket connects while HTTP Run now is still in flight.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    const replacementListBefore = replacementSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;
    const httpListBefore = vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;

    // Resolve HTTP Run now -> follow-up list MUST use replacementSocket, NOT failing HTTP!
    await act(async () => {
      resolveRunNow({ type: "response", requestId: "rn-1", ok: true, result: { kind: "scheduled-task-run" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replacementSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length).toBeGreaterThan(replacementListBefore);
    expect(vi.mocked(apiRequest).mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length).toBe(httpListBefore);
    expect(screen.queryByText(/Offline — showing only data/iu)).not.toBeInTheDocument();
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

  it("R1-B1..R1-B5: failed remote delete surfaces per-row error, preserves focus on cancel, formats one-shot locally, omits role=alert on stored error, and refreshes on live poll", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    const onceTask = {
      id: "77777777-7777-4777-8777-777777777777",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Project",
      title: "Release cutover",
      scheduleLabel: "Once at 2030-11-27T09:00:00.000Z",
      enabled: true,
      nextRunAt: "2030-11-27T09:00:00.000Z",
      lastRunAt: "2030-11-26T09:00:00.000Z",
      lastRunStatus: "failed" as "failed" | "completed",
      lastError: "Stored remote error" as string | null,
      consecutiveFailures: 1,
      boundConversationId: null,
    };
    const promptState = (requestId = "st-b") => ({
      type: "response",
      requestId,
      ok: true,
      result: {
        kind: "state",
        validator: STATE_VALIDATOR,
        state: {
          generatedAt: "2030-01-01T00:00:00.000Z",
          projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Project" }],
          conversations: [{ id: "33333333-3333-4333-8333-333333333333", projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }],
          capabilities: { scopes: ["private:read", "private:prompt"], preset: "collaborate", expiresAt: "2030-02-01T00:00:00.000Z" },
        },
      },
    });
    let listResponses = [onceTask];
    const liveSocket = {
      request: vi.fn(async (req: { type: string; requestId?: string }) => {
        if (req.type === "state.get") return promptState(req.requestId);
        if (req.type === "scheduled-tasks.list") {
          return { type: "response", requestId: req.requestId ?? "lb", ok: true, result: { kind: "scheduled-tasks", tasks: listResponses } };
        }
        if (req.type === "scheduled-task.delete") {
          return { type: "response", requestId: req.requestId ?? "db", ok: false, code: "not-found", message: "That scheduled task was not found." };
        }
        return { type: "response", requestId: req.requestId ?? "ob", ok: true, result: { kind: "not-modified", validator: STATE_VALIDATOR } };
      }),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket).mockResolvedValueOnce(liveSocket as never);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByText("Release cutover")).toBeInTheDocument());

    expect(screen.queryByText(/2030-11-27T09:00:00\.000Z/u)).not.toBeInTheDocument();
    expect(screen.getByText(/^Once · /u)).toBeInTheDocument();

    expect(screen.getByText("Stored remote error")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Delete Release cutover/i }));
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancelBtn);
    fireEvent.click(cancelBtn);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Delete Release cutover/i }));

    const listBeforeDelete = liveSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length;
    fireEvent.click(screen.getByRole("button", { name: /Delete Release cutover/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm delete Release cutover/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That scheduled task was not found."));
    expect(screen.getByRole("button", { name: /Confirm delete Release cutover/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(liveSocket.request.mock.calls.filter(([req]) => (req as { type?: string }).type === "scheduled-tasks.list").length)
        .toBeGreaterThan(listBeforeDelete);
    });

    listResponses = [{ ...onceTask, enabled: false, lastRunStatus: "completed", lastError: null }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("R2-B1: silent 5s poll superseding an in-flight manual Refresh still clears loading state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    const pendingLists: Array<(value: unknown) => void> = [];
    const baseImpl = socket.request.getMockImplementation()!;
    const pollSocket = {
      request: vi.fn((req: { type: string; requestId?: string }) => {
        if (req.type === "scheduled-tasks.list") {
          return new Promise<unknown>((resolve) => { pendingLists.push(resolve); });
        }
        return baseImpl(req);
      }),
      onClose: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    vi.mocked(connectPrivateConnectSocket).mockResolvedValueOnce(pollSocket as never);

    vi.useFakeTimers();
    render(<App initialPairingFragment={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pendingLists.length).toBeGreaterThanOrEqual(1);
    const firstResolve = pendingLists[pendingLists.length - 1]!;
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(pendingLists.length).toBeGreaterThanOrEqual(2);
    const silentResolve = pendingLists[pendingLists.length - 1]!;

    await act(async () => {
      firstResolve({ type: "response", requestId: "r-first", ok: true, result: { kind: "scheduled-tasks", tasks: [] } });
      silentResolve({ type: "response", requestId: "r-silent", ok: true, result: { kind: "scheduled-tasks", tasks: [] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    const refreshBtn = screen.getByRole("button", { name: "Refresh" });
    expect(refreshBtn).toBeEnabled();
  });
});
