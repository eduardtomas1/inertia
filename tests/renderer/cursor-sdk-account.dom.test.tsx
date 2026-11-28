import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { CursorSdkContext, type CursorSdkTransport } from "../../src/renderer/src/components/cursor-sdk/CursorSdkContext";
import { CursorSdkEntry } from "../../src/renderer/src/components/cursor-sdk/CursorSdkEntry";
import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";

function fixture() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const emit = (event: ServerEvent) => act(() => listeners.forEach((listener) => listener(event)));
  const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
    if (command.type === "provider.cursor-sdk.status") return {
      type: "request.result", requestId: command.requestId,
      result: { kind: "provider.cursor-sdk.status", available: true, hasCredential: true, sdkVersion: "1.0.38" },
    };
    if (command.type === "provider.cursor-sdk.models") return {
      type: "request.result", requestId: command.requestId,
      result: { kind: "provider.cursor-sdk.models", models: [] },
    };
    if (command.type === "provider.cursor-sdk.login") {
      listeners.forEach((listener) => listener({
        type: "provider.cursor-sdk.login.updated", loginRequestId: command.requestId,
        status: "waiting", loginUrl: "https://cursor.com/loginDeepControl?challenge=synthetic-fixture&uuid=synthetic-fixture&mode=login&redirectTarget=sdk",
      }));
    }
    return { type: "request.ok", requestId: command.requestId };
  });
  const transport: CursorSdkTransport = {
    status: "online", sendCommand,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { transport, emit, sendCommand };
}

async function openAndStart() {
  fireEvent.click(screen.getByRole("button", { name: "Cursor SDK" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check Cursor SDK" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Cursor SDK" })).toBeEnabled());
  expect(screen.getByText(/remote validity has not been checked/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Cursor SDK" }));
  await screen.findByRole("button", { name: "Open Cursor sign-in" });
}

function renderEntry(transport: CursorSdkTransport) {
  return render(<CursorSdkContext.Provider value={transport}><CursorSdkEntry /></CursorSdkContext.Provider>);
}

function attemptId(sendCommand: ReturnType<typeof fixture>["sendCommand"]) {
  return sendCommand.mock.calls.find(([command]) => command.type === "provider.cursor-sdk.login")![0].requestId;
}

describe("Cursor SDK account", () => {
  it("subscribes before the command and opens only the validated link through the privileged API", async () => {
    const f = fixture();
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "inertia", { configurable: true, value: { openExternal } });
    renderEntry(f.transport);
    expect(f.sendCommand).not.toHaveBeenCalled();
    await openAndStart();
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: "foreign", status: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Open Cursor sign-in" }));
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("https://cursor.com/loginDeepControl"));
    expect(f.sendCommand.mock.calls.some(([command]) => command.type === "provider.auth.start")).toBe(false);
  });

  it("retains cancellation until terminal progress and ignores late events", async () => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    const loginRequestId = attemptId(f.sendCommand);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(screen.getByText("Cancelling sign-in…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with Cursor SDK" })).toBeNull();
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId, status: "cancelled" });
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId, status: "authenticated", expiresAt: 123456 });
    expect(screen.getByText("Sign-in cancelled.")).toBeInTheDocument();
  });

  it.each(["failed", "expired"] as const)("offers an explicit retry after %s", async (status) => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: attemptId(f.sendCommand), status });
    expect(screen.getByText(`Sign-in ${status}. Check availability to try again.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Cursor SDK" })).toBeEnabled();
  });

  it("checks evidence again on completion", async () => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: attemptId(f.sendCommand), status: "authenticated", expiresAt: 123456 });
    await screen.findByText("Cursor SDK is available.");
    expect(f.sendCommand.mock.calls.filter(([command]) => command.type === "provider.cursor-sdk.status")).toHaveLength(2);
  });

  it("cancels on close and restores focus", async () => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    fireEvent.click(screen.getByRole("button", { name: "Close SDK settings" }));
    expect(screen.getByRole("button", { name: "Cursor SDK" })).toHaveFocus();
    expect(f.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "provider.cursor-sdk.login.cancel", payload: { loginRequestId: attemptId(f.sendCommand) } }));
  });

  it("invalidates on disconnect and never restarts on reconnect", async () => {
    const f = fixture();
    const view = renderEntry(f.transport);
    await openAndStart();
    view.rerender(<CursorSdkContext.Provider value={{ ...f.transport, status: "offline" }}><CursorSdkEntry /></CursorSdkContext.Provider>);
    expect(screen.getByRole("button", { name: "Check Cursor SDK" })).toBeDisabled();
    view.rerender(<CursorSdkContext.Provider value={f.transport}><CursorSdkEntry /></CursorSdkContext.Provider>);
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: attemptId(f.sendCommand), status: "authenticated", expiresAt: 123456 });
    expect(screen.getByRole("button", { name: "Sign in with Cursor SDK" })).toBeDisabled();
    expect(f.sendCommand.mock.calls.filter(([command]) => command.type === "provider.cursor-sdk.login")).toHaveLength(1);
  });

  it("accepts completion before acknowledgement without reviving the attempt", async () => {
    const f = fixture();
    const original = f.sendCommand.getMockImplementation()!;
    let acknowledge!: (event: ServerEvent) => void;
    f.sendCommand.mockImplementation((command) => command.type === "provider.cursor-sdk.login"
      ? new Promise((resolve) => { acknowledge = resolve; })
      : original(command));
    renderEntry(f.transport);
    fireEvent.click(screen.getByRole("button", { name: "Cursor SDK" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check Cursor SDK" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in with Cursor SDK" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Cursor SDK" }));
    const loginRequestId = attemptId(f.sendCommand);
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId, status: "authenticated", expiresAt: 123456 });
    await screen.findByText("Cursor SDK is available.");
    await act(async () => acknowledge({ type: "request.ok", requestId: loginRequestId }));
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
    expect(f.sendCommand.mock.calls.filter(([command]) => command.type === "provider.cursor-sdk.models")).toHaveLength(1);
  });

  it("cancels unsafe links and never passes them to the browser", async () => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: attemptId(f.sendCommand), status: "waiting", loginUrl: "https://synthetic.example.test/login" });
    expect(screen.queryByRole("button", { name: "Open Cursor sign-in" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("invalid sign-in link");
    expect(f.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "provider.cursor-sdk.login.cancel" }));
  });

  it("ignores waiting progress after cancellation starts", async () => {
    const f = fixture();
    renderEntry(f.transport);
    await openAndStart();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    f.emit({ type: "provider.cursor-sdk.login.updated", loginRequestId: attemptId(f.sendCommand), status: "waiting", loginUrl: "https://cursor.com/loginDeepControl?challenge=synthetic" });
    expect(screen.getByText("Cancelling sign-in…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Cursor sign-in" })).toBeNull();
  });

  it("exposes a separate entry in real account settings without starting CLI auth", async () => {
    const f = fixture();
    const onConnectProvider = vi.fn();
    const unused = vi.fn(async (): Promise<never> => { throw new Error("Unexpected fixture call"); });
    render(<CursorSdkContext.Provider value={f.transport}><ModelBackendsSettings
      profiles={[]} providers={[]} disabled={false} onConnectProvider={onConnectProvider}
      onRefreshProvider={vi.fn()} onLoadDetail={unused} onCreate={unused} onUpdate={unused}
      onSetCredential={unused} onClearCredential={unused} onProbe={unused} onDiscoverModels={unused} onDelete={unused}
    /></CursorSdkContext.Provider>);
    await openAndStart();
    expect(onConnectProvider).not.toHaveBeenCalled();
  });
});
