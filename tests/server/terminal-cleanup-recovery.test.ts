import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(pid: number): {
  emitData: (data: string) => void;
  emitExit: (event: { exitCode: number; signal?: number }) => void;
  pty: IPty;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(
    event: { exitCode: number; signal?: number },
  ) => void>();
  const pty = {
    pid,
    onData: vi.fn((callback: (data: string) => void): IDisposable => {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    }),
    onExit: vi.fn((callback: (
      event: { exitCode: number; signal?: number },
    ) => void): IDisposable => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
  return {
    emitData: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    emitExit: (event) => {
      for (const listener of exitListeners) listener(event);
    },
    pty,
  };
}

describe("TerminalManager cleanup recovery", () => {
  it.each([
    { confirmed: false, exitTiming: "during stop" },
    { confirmed: false, exitTiming: "after failed stop" },
    { confirmed: true, exitTiming: "during stop" },
  ])("retires a Windows claim only after full-tree proof ($confirmed, $exitTiming)", async ({
    confirmed, exitTiming,
  }) => {
    const terminal = fakeTerminal(42);
    let claimRetained = true;
    const releaseIfGroupExited = vi.fn(() => { claimRetained = false; });
    const confirmStopped = vi.fn(() => { claimRetained = false; return true; });
    let settleTermination!: (confirmed: boolean) => void;
    const terminationResult = new Promise<boolean>((resolve) => { settleTermination = resolve; });
    let observeTerminationStarted!: () => void;
    const terminationStarted = new Promise<void>((resolve) => { observeTerminationStarted = resolve; });
    const terminateProcessTree = vi.fn(() => {
      observeTerminationStarted();
      return terminationResult;
    });
    const createProcessTreeTermination = vi.fn(() => terminateProcessTree);
    const manager = new TerminalManager({
      platform: "win32",
      spawnTerminal: vi.fn(() => terminal.pty),
      createProcessTreeTermination,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped,
        releaseIfGroupExited,
        requestGuardianStop: () => false,
        waitForGuardianStop: async () => false,
      }),
    });
    const owner = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
    const onExit = vi.fn();
    const terminalId = manager.createProcess(
      owner, process.cwd(), "test-shell", [], {}, 80, 24, onExit,
    );

    const closing = manager.closeManaged(terminalId).catch((error: unknown) => error);
    await terminationStarted;
    if (exitTiming === "during stop") terminal.emitExit({ exitCode: 0 });
    const retainedBeforeProof = claimRetained;
    const confirmationsBeforeProof = confirmStopped.mock.calls.length;
    settleTermination(confirmed);
    const outcome = await closing;
    if (exitTiming === "after failed stop") terminal.emitExit({ exitCode: 0 });

    expect(retainedBeforeProof).toBe(true);
    expect(confirmationsBeforeProof).toBe(0);
    expect(releaseIfGroupExited).not.toHaveBeenCalled();
    expect(createProcessTreeTermination).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminal.pty.kill).not.toHaveBeenCalled();
    expect(() => manager.input(owner, terminalId, "unsafe input")).toThrow("Terminal not found.");
    if (confirmed) {
      expect(outcome).toBe(true);
      expect(claimRetained).toBe(false);
      expect(confirmStopped).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledExactlyOnceWith(130);
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );
      expect(claimRetained).toBe(true);
      expect(confirmStopped).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    }
  });

  it("requests runtime recovery without signaling an exited guardian PID", async () => {
    const terminal = fakeTerminal(42);
    const releaseIfGroupExited = vi.fn();
    const requestGuardianStop = vi.fn(() => true);
    const onOwnedProcessCleanupUnconfirmed = vi.fn();
    const spawnTerminal = vi.fn(() => terminal.pty);
    const manager = new TerminalManager({
      spawnTerminal,
      onOwnedProcessCleanupUnconfirmed,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => false,
        releaseIfGroupExited,
        requestGuardianStop,
        waitForGuardianStop: async () => true,
      }),
    });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const createProcess = (): void => {
      manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );
    };
    createProcess();

    terminal.emitExit({ exitCode: 0, signal: 31 });

    expect(releaseIfGroupExited).toHaveBeenCalledWith(31);
    expect(onOwnedProcessCleanupUnconfirmed).toHaveBeenCalledOnce();
    expect(createProcess).toThrow(
      "A previous terminal process could not be confirmed stopped.",
    );
    await expect(manager.disposeAll()).rejects.toThrow(
      "A terminal process ownership claim could not be retired during runtime shutdown.",
    );
    expect(requestGuardianStop).not.toHaveBeenCalled();
    expect(spawnTerminal).toHaveBeenCalledOnce();
  });

  it.each([
    { outputBeforeStop: false, rejected: false },
    { outputBeforeStop: true, rejected: false },
    { outputBeforeStop: false, rejected: true },
  ])("retains only safe Windows stop observations ($outputBeforeStop, $rejected)", async ({
    outputBeforeStop, rejected,
  }) => {
    const terminal = fakeTerminal(42);
    const terminateProcessTree = vi.fn(async () => {
      terminal.emitData("private output after stop");
      terminal.emitExit({ exitCode: 7 });
      if (rejected) throw new Error("private termination failure");
      return false;
    });
    const manager = new TerminalManager({
      platform: "win32",
      spawnTerminal: vi.fn(() => terminal.pty),
      terminateProcessTree,
    });
    const owner = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
    const onExit = vi.fn();
    const terminalId = manager.createProcess(
      owner, process.cwd(), "private-shell", ["private-argument"], {}, 80, 24, onExit,
    );
    if (outputBeforeStop) terminal.emitData("private output before stop");

    const error = await manager.closeManaged(terminalId).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "A terminal process tree could not be confirmed stopped during runtime shutdown.",
    );
    expect((error as Error).cause).toMatchObject({
      windowsTerminalCleanup: {
        atStop: { outputObserved: outputBeforeStop, exitObserved: false, exitCode: null, naturalExitCode: null },
        atFailure: { outputObserved: true, exitObserved: true, exitCode: 7, naturalExitCode: null },
      },
    });
    expect(JSON.stringify((error as Error).cause)).not.toMatch(/private|"pid":|"cwd":|"args":/u);
    expect(onExit).not.toHaveBeenCalled();
    expect(() => manager.input(owner, terminalId, "unsafe input")).toThrow("Terminal not found.");
  });
});
