import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(): {
  readonly emitExit: () => void;
  readonly pty: IPty;
} {
  const exitListeners = new Set<(event: {
    exitCode: number;
    signal?: number;
  }) => void>();
  const pty = {
    pid: 100,
    onData: vi.fn((): IDisposable => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: {
      exitCode: number;
      signal?: number;
    }) => void): IDisposable => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
  return {
    emitExit: () => {
      for (const listener of exitListeners) listener({ exitCode: 0, signal: 0 });
    },
    pty,
  };
}

describe("TerminalManager macOS shutdown", () => {
  it("lets the bounded guardian drain complete beyond the generic POSIX budget", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let ownershipStopped = false;
      const cleanupUnconfirmed = vi.fn();
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestPayloadExit: () => false,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 1_750));
            return true;
          },
        }),
        onOwnedProcessCleanupUnconfirmed: cleanupUnconfirmed,
      });
      const terminalId = manager.create(owner, process.cwd(), 80, 24);

      const closing = manager.close(owner, terminalId);
      await vi.advanceTimersByTimeAsync(1_749);
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();

      ownershipStopped = true;
      terminal.emitExit();
      await vi.advanceTimersByTimeAsync(1);

      await expect(closing).resolves.toBeUndefined();
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();
      expect(owner.send).toHaveBeenCalledWith(JSON.stringify({
        type: "terminal.exit",
        terminalId,
        exitCode: 130,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
