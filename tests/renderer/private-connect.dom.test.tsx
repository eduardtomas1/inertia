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
});
