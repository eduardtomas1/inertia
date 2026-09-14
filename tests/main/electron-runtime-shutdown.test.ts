import type { ElectronApplication } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { finishElectronPreparedQuit } from "../e2e/support/electron-runtime-shutdown";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(windows: unknown[], writeFails = false) {
  const write = vi.fn(() => {
    if (writeFails) throw new Error("private writer error");
    return 0;
  });
  const closeInspector = vi.fn();
  vi.spyOn(process, "getBuiltinModule").mockImplementation((name) =>
    name === "node:inspector" ? { close: closeInspector } : { writeSync: write });
  const exitFailure = new Error("test exit sentinel");
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw exitFailure; });
  const finish = vi.fn(() => ({
    phase: "exit-requested", runtimePid: 434343, cleanupConfirmed: true, errorMessage: null,
  }));
  vi.stubGlobal("__inertiaTestRuntime", { finishPreparedQuit: finish });
  const current = {
    evaluate: async (operation: (electron: unknown) => unknown) =>
      operation({ BrowserWindow: { getAllWindows: () => windows } }),
  } as unknown as ElectronApplication;
  return { write, closeInspector, exit, exitFailure, finish, current };
}

it.each([false, true])("forwards prepared exit and sole-window destruction unchanged (writer fails: %s)", async (writeFails) => {
  const destroy = vi.fn(function (this: unknown) { return this; });
  const window = { destroy };
  const f = fixture([window], writeFails);
  await expect(finishElectronPreparedQuit(f.current)).resolves.toBe(434343);
  expect(f.finish).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.closeInspector).not.toHaveBeenCalled();
  expect(window.destroy()).toBe(window);
  expect(destroy).toHaveBeenCalledOnce();
  expect(() => process.exit(7)).toThrow(f.exitFailure);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(7);
  expect(f.closeInspector).toHaveBeenCalledOnce();
  expect(f.closeInspector.mock.invocationCallOrder[0]).toBeLessThan(f.exit.mock.invocationCallOrder[0]!);
  expect(f.write.mock.calls).toEqual([
    [2, "[Inertia test exit: window-destroy-entered]\n"],
    [2, "[Inertia test exit: window-destroy-returned]\n"],
    [2, "[Inertia test exit: process-exit-called]\n"],
  ]);
});

it("does not invent a returned destroy or an exit after native destruction throws", async () => {
  const failure = new Error("native destroy failure");
  const window = { destroy: vi.fn(() => { throw failure; }) };
  const f = fixture([window]);
  await finishElectronPreparedQuit(f.current);
  expect(() => window.destroy()).toThrow(failure);
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.closeInspector).not.toHaveBeenCalled();
  expect(f.write.mock.calls).toEqual([[2, "[Inertia test exit: window-destroy-entered]\n"]]);
});

it("does not close the inspector when privileged cleanup rejects the prepared quit", async () => {
  const f = fixture([]);
  f.finish.mockImplementation(() => { throw new Error("cleanup unconfirmed"); });
  await expect(finishElectronPreparedQuit(f.current)).rejects.toThrow("cleanup unconfirmed");
  expect(f.closeInspector).not.toHaveBeenCalled();
  expect(f.exit).not.toHaveBeenCalled();
});

it("does not report a completed process exit if closing the inspector fails", async () => {
  const f = fixture([]);
  f.closeInspector.mockImplementation(() => { throw new Error("inspector close failed"); });
  await finishElectronPreparedQuit(f.current);
  expect(() => process.exit(0)).toThrow("inspector close failed");
  expect(f.exit).not.toHaveBeenCalled();
});

it("reports ambiguous window identity without intercepting another window", async () => {
  const destroy = vi.fn();
  const windows = [{ destroy }, { destroy }];
  const f = fixture(windows);
  await finishElectronPreparedQuit(f.current);
  expect(windows[0]!.destroy).toBe(destroy);
  expect(windows[1]!.destroy).toBe(destroy);
  expect(f.write.mock.calls).toEqual([[2, "[Inertia test exit: window-identity-unavailable]\n"]]);
});

it("does not let unavailable instrumentation prevent the prepared quit", async () => {
  const destroy = vi.fn();
  const window = Object.defineProperty({ destroy }, "destroy", { value: destroy, writable: false });
  const f = fixture([window]);
  await expect(finishElectronPreparedQuit(f.current)).resolves.toBe(434343);
  expect(window.destroy).toBe(destroy);
  expect(f.finish).toHaveBeenCalledOnce();
  expect(f.write.mock.calls).toEqual([[2, "[Inertia test exit: window-observer-unavailable]\n"]]);
});
