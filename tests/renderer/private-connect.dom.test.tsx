import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const closeListeners = new Set<(code: number) => void>();
let notifyClose: ((code: number) => void) | null = null;
const socket = {
  request: vi.fn(async (request: { type: string }) => request.type === "state.get"
    ? { type: "response", requestId: "11111111-1111-4111-8111-111111111111", ok: true, result: { kind: "state", state: { generatedAt: "2030-01-01T00:00:00.000Z", projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Project" }], conversations: [{ id: "33333333-3333-4333-8333-333333333333", projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }], capabilities: { scopes: ["private:read"], preset: "monitor", expiresAt: "2030-02-01T00:00:00.000Z" } } } }
    : { type: "response", requestId: "44444444-4444-4444-8444-444444444444", ok: true, result: { kind: "conversation", detail: { generatedAt: "2030-01-01T00:00:00.000Z", conversation: { id: "33333333-3333-4333-8333-333333333333", projectId: "22222222-2222-4222-8222-222222222222", title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, pendingLocalAction: false, updatedAt: "2030-01-01T00:00:00.000Z" }, messages: [], questions: [], waitingForLocalAction: false } } }),
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
import { connectPrivateConnectSocket } from "../../src/renderer/private-connect/src/connection";

afterEach(() => {
  closeListeners.clear();
  notifyClose = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Private Connect browser lifecycle", () => {
  it("clears cached workspace data when access is revoked over the live connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    notifyClose?.(1008);
    await waitFor(() => expect(screen.getByText("This browser no longer has access. Pair it again from the desktop.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Your workspace" })).not.toBeInTheDocument();
  });

  it("keeps cached workspace data and retries after a temporary host pause", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
    render(<App initialPairingFragment={null} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument());
    await waitFor(() => expect(notifyClose).toEqual(expect.any(Function)));
    const initialConnectCalls = vi.mocked(connectPrivateConnectSocket).mock.calls.length;
    vi.useFakeTimers();
    act(() => notifyClose?.(1012));
    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument();
    expect(screen.queryByText(/pair it again/iu)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(vi.mocked(connectPrivateConnectSocket)).toHaveBeenCalledTimes(initialConnectCalls + 1);
  });
});
