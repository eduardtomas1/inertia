import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAppRuntimeActions } from "../../src/renderer/src/hooks/useAppRuntimeActions";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";

const command: CommandWithoutId = {
  type: "git.branch.switch",
  payload: {
    projectId: "11111111-1111-4111-8111-111111111111", name: "topic",
    repositoryPath: ".", authorityRef: "22222222-2222-4222-8222-222222222222",
  },
};

it.each([true, false])("retains busy cleanup and propagates failure with global error reporting=%s", async (reportError) => {
  const error = new Error("Commit or stash local changes first.");
  const setActionError = vi.fn();
  const setBusyAction = vi.fn();
  const { result } = renderHook(() => useAppRuntimeActions({
    sendCommand: vi.fn().mockRejectedValue(error), refreshDetail: vi.fn(), setActionError, setBusyAction,
  }));
  await act(async () => {
    await expect(result.current.run(command.type, command, reportError ? undefined : { reportError }))
      .rejects.toBe(error);
  });
  expect(setActionError.mock.calls).toEqual(reportError ? [[null], [error.message]] : [[null]]);
  expect(setBusyAction).toHaveBeenCalledWith(command.type);
  const clear = setBusyAction.mock.lastCall![0] as (current: string | null) => string | null;
  expect(clear(command.type)).toBeNull();
  expect(clear("other operation")).toBe("other operation");
});

it("runs a passive command without clearing the visible error or toggling busy state", async () => {
  const setActionError = vi.fn();
  const setBusyAction = vi.fn();
  const refreshDetail = vi.fn();
  const event = {
    type: "request.result" as const,
    requestId: "request",
    result: {
      kind: "git.workspace.diff" as const,
      diff: { repositoryPath: ".", reviewMetadataChanged: true, patch: "", truncated: false, files: [] },
    },
  };
  const { result } = renderHook(() => useAppRuntimeActions({
    sendCommand: vi.fn().mockResolvedValue(event), refreshDetail, setActionError, setBusyAction,
  }));
  const diffCommand: CommandWithoutId = {
    type: "git.workspace.diff",
    payload: {
      projectId: "11111111-1111-4111-8111-111111111111", repositoryPath: ".",
      authorityRef: "22222222-2222-4222-8222-222222222222",
    },
  };
  await act(async () => {
    await expect(result.current.run(diffCommand.type, diffCommand, { passive: true })).resolves.toBe(event);
  });
  expect(setActionError).not.toHaveBeenCalled();
  expect(setBusyAction).not.toHaveBeenCalled();
  expect(refreshDetail).toHaveBeenCalledOnce();
});

it.each([
  ["ambiguous", true],
  ["rejected", false],
] as const)("reports %s message delivery without inviting a blind retry", async (delivery, unconfirmed) => {
  const error = new RuntimeCommandError("The follow-up was accepted as its turn ended.", delivery);
  const setActionError = vi.fn();
  const { result } = renderHook(() => useAppRuntimeActions({
    sendCommand: async (command) => {
      if (command.type === "worktree.setup.wait") return { type: "request.result", requestId: command.requestId, result: { kind: "worktree.setup", summary: null, output: "" } };
      throw error;
    }, refreshDetail: vi.fn(), setActionError, setBusyAction: vi.fn(),
  }));
  await act(async () => {
    await expect(result.current.sendMessageToConversation("33333333-3333-4333-8333-333333333333", "Follow up", []))
      .rejects.toBe(error);
  });
  const reported = String(setActionError.mock.lastCall?.[0]);
  expect(reported.startsWith("Delivery could not be confirmed.")).toBe(unconfirmed);
  expect(reported).toContain(error.message);
});

it("keeps setup connection failures unambiguously unsent", async () => {
  const sendCommand = vi.fn().mockRejectedValue(new RuntimeCommandError("Setup connection lost", "ambiguous"));
  const { result } = renderHook(() => useAppRuntimeActions({ sendCommand, refreshDetail: vi.fn(), setActionError: vi.fn(), setBusyAction: vi.fn() }));
  await act(async () => {
    await expect(result.current.sendMessageToConversation("33333333-3333-4333-8333-333333333333", "First prompt", []))
      .rejects.toMatchObject({ delivery: "not-sent", message: "Setup connection lost" });
  });
  expect(sendCommand).toHaveBeenCalledTimes(1);
  expect(sendCommand.mock.calls[0]?.[0].type).toBe("worktree.setup.wait");
});

it("waits for setup before sending and preserves a failed setup as an unsent prompt", async () => {
  let release!: (value: import("../../src/shared/contracts").ServerEvent) => void;
  const pending = new Promise<import("../../src/shared/contracts").ServerEvent>((resolve) => { release = resolve; });
  const sendCommand = vi.fn(async () => pending);
  const { result } = renderHook(() => useAppRuntimeActions({ sendCommand, refreshDetail: vi.fn(), setActionError: vi.fn(), setBusyAction: vi.fn() }));
  let sending!: Promise<unknown>;
  act(() => { sending = result.current.sendMessageToConversation("33333333-3333-4333-8333-333333333333", "First prompt", []); });
  expect(sendCommand).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({ type: "request.result", requestId: "setup", result: { kind: "worktree.setup", output: "", summary: {
      actionName: "Install", status: "failed", attempt: 1, detail: "Failed", startedAt: null, finishedAt: null,
    } } });
    await expect(sending).rejects.toMatchObject({ delivery: "not-sent" });
  });
  expect(sendCommand).toHaveBeenCalledTimes(1);
  expect(result.current.sendingConversationIds.size).toBe(0);
});
