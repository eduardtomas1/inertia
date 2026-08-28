import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(pid: number): {
  emitExit: (event: { exitCode: number; signal: number }) => void;
  pty: IPty;
} {
  const exitListeners = new Set<(
    event: { exitCode: number; signal?: number },
  ) => void>();
  const pty = {
    pid,
    onData: vi.fn((): IDisposable => ({ dispose: vi.fn() })),
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
    emitExit: (event) => {
      for (const listener of exitListeners) listener(event);
    },
    pty,
  };
}

describe("TerminalManager cleanup recovery", () => {
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
});
