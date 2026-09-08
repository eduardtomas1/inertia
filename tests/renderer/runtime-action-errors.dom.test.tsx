import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAppRuntimeActions } from "../../src/renderer/src/hooks/useAppRuntimeActions";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

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
