import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(): {
  emitExit: () => void;
  pty: IPty;
} {
  const exitListeners = new Set<() => void>();
  const disposable = (callback: () => void): IDisposable => ({
    dispose: () => exitListeners.delete(callback),
  });
  const pty = {
    pid: 42,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: () => void) => {
      exitListeners.add(callback);
      return disposable(callback);
    }),
    kill: vi.fn(),
    write: vi.fn(),
  } as unknown as IPty;
  return {
    emitExit: () => {
      for (const listener of exitListeners) listener();
    },
    pty,
  };
}

describe("TerminalManager", () => {
  it("awaits a terminal already closing after its owner disconnects", async () => {
    const terminal = fakeTerminal();
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
      shutdownTimeoutMs: 100,
    });
    const owner = {} as WebSocket;
    manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    );

    manager.disposeOwner(owner);
    let shutdownFinished = false;
    const shutdown = manager.disposeAll().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();

    expect(terminal.pty.kill).toHaveBeenCalledOnce();
    expect(shutdownFinished).toBe(false);

    terminal.emitExit();
    await shutdown;

    expect(shutdownFinished).toBe(true);
  });

  it("reports a bounded timeout for a disconnected terminal that never exits", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
      });
      const owner = {} as WebSocket;
      manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      manager.disposeOwner(owner);
      const shutdown = manager.disposeAll();
      const rejected = expect(shutdown).rejects.toThrow(
        "A terminal process did not exit during runtime shutdown.",
      );
      await vi.advanceTimersByTimeAsync(20);

      await rejected;
      expect(terminal.pty.kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
