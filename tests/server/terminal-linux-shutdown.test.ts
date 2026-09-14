import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(): {
  emitExit: (event: { exitCode: number; signal: number }) => void;
  pty: IPty;
} {
  const listeners = new Set<(event: { exitCode: number; signal: number }) => void>();
  const pty = {
    pid: 42,
    onData: vi.fn((): IDisposable => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void): IDisposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
  return { pty, emitExit: (event) => { for (const listener of listeners) listener(event); } };
}

function createTestShell(manager: TerminalManager, owner: WebSocket): string {
  return manager.createProcess(owner, process.cwd(), "test-shell", [], {}, 80, 24);
}

describe("TerminalManager Linux shutdown", () => {
  it("lets a detached Linux guardian exit within the existing close envelope", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let ownershipStopped = false;
      const cleanupUnconfirmed = vi.fn();
      const manager = new TerminalManager({
        platform: "linux",
        reattachTimeoutMs: 50,
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => true,
        }),
        onOwnedProcessCleanupUnconfirmed: cleanupUnconfirmed,
      });
      const owner = {} as WebSocket;
      manager.create(owner, process.cwd(), 80, 24, undefined, undefined, {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: null,
      });

      manager.disposeOwner(owner);
      await vi.advanceTimersByTimeAsync(50 + 1_200);
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();
      terminal.emitExit({ exitCode: 143, signal: 0 });
      await vi.advanceTimersByTimeAsync(10);
      expect(manager.ownedResourceCount()).toBe(1);
      ownershipStopped = true;
      await vi.advanceTimersByTimeAsync(10);

      expect(manager.ownedResourceCount()).toBe(0);
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("retains an unproven Linux guardian at the unchanged deadline (runtime shutdown: %s)", async (runtimeShutdown) => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const confirmStopped = vi.fn(() => false);
      const releaseIfGroupExited = vi.fn();
      const cleanupUnconfirmed = vi.fn();
      const manager = new TerminalManager({
        platform: "linux",
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped,
          releaseIfGroupExited,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => true,
        }),
        onOwnedProcessCleanupUnconfirmed: cleanupUnconfirmed,
      });
      const terminalId = createTestShell(manager, {} as WebSocket);
      const closing = manager.closeManaged(terminalId).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_200);
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();
      const shuttingDown = runtimeShutdown
        ? manager.disposeAll(Date.now() + 50).catch((error: unknown) => error)
        : null;
      await vi.advanceTimersByTimeAsync(runtimeShutdown ? 49 : 8_299);
      expect(cleanupUnconfirmed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await closing).toBeInstanceOf(Error);
      if (shuttingDown) expect(await shuttingDown).toBeInstanceOf(Error);
      expect(cleanupUnconfirmed).toHaveBeenCalledOnce();
      expect(manager.ownedResourceCount()).toBe(1);
      expect(confirmStopped).not.toHaveBeenCalled();
      expect(releaseIfGroupExited).not.toHaveBeenCalled();
      expect(terminal.pty.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      const sessions = (manager as unknown as {
        sessions: Map<string, { exitWaiters: Set<unknown> }>;
      }).sessions;
      expect(sessions.get(terminalId)?.exitWaiters.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
