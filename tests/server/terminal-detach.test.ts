import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(pid: number): IPty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: {
    exitCode: number;
    signal?: number;
  }) => void>();
  return {
    pid,
    onData: vi.fn((listener: (data: string) => void) => {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    }),
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
}

describe("TerminalManager detached scoped ownership", () => {
  it("releases the socket cap while preserving exact bounded reattachment", () => {
    const terminals = Array.from({ length: 5 }, (_, index) => (
      fakeTerminal(4_000 + index)
    ));
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      reattachTimeoutMs: 1_000,
      spawnTerminal: vi.fn(() => terminals.shift()!),
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => true,
        releaseIfGroupExited: vi.fn(),
        requestGuardianStop: () => false,
        waitForGuardianStop: async () => true,
      }),
    });
    const projectId = "11111111-1111-4111-8111-111111111111";
    const ids = Array.from({ length: 4 }, (_, index) => {
      const terminalId = manager.create(
        owner,
        process.cwd(),
        80,
        24,
        undefined,
        undefined,
        {
          projectId,
          conversationId: `22222222-2222-4222-8222-22222222222${index}`,
        },
      );
      manager.detach(owner, terminalId);
      return terminalId;
    });

    expect(() => manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      {
        projectId,
        conversationId: "33333333-3333-4333-8333-333333333333",
      },
    )).not.toThrow();

    const scope = {
      projectId,
      conversationId: "22222222-2222-4222-8222-222222222220",
    };
    expect(manager.attach(
      owner,
      ids[0]!,
      process.cwd(),
      scope,
      91,
      31,
    )).toEqual({ terminalId: ids[0] });
    expect(() => manager.input(owner, ids[0]!, "echo retained\n"))
      .not.toThrow();
  });

  it("keeps a terminal handed back in the background past the reattach timeout without resizing it", async () => {
    vi.useFakeTimers();
    try {
      const pty = fakeTerminal(5_000);
      const socket = (): WebSocket => ({
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket);
      const popup = socket();
      const main = socket();
      const manager = new TerminalManager({
        platform: "linux",
        reattachTimeoutMs: 30_000,
        spawnTerminal: vi.fn(() => pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => true,
          releaseIfGroupExited: vi.fn(),
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => true,
        }),
      });
      const scope = {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
      };
      const terminalId = manager.create(popup, process.cwd(), 120, 40, undefined, undefined, scope);
      manager.disposeOwner(popup);
      vi.mocked(pty.resize).mockClear();

      expect(manager.attach(main, terminalId, process.cwd(), scope, 80, 24, undefined, true))
        .toEqual({ terminalId });
      expect(pty.resize).not.toHaveBeenCalled();
      expect(vi.mocked(main.send)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(() => manager.input(main, terminalId, "still here\n")).not.toThrow();

      expect(manager.attach(main, terminalId, process.cwd(), scope, 100, 30)).toEqual({ terminalId });
      expect(pty.resize).toHaveBeenCalledWith(100, 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still disposes a terminal nobody takes back after the reattach timeout", async () => {
    vi.useFakeTimers();
    try {
      const pty = fakeTerminal(5_001);
      const popup = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "linux",
        reattachTimeoutMs: 30_000,
        spawnTerminal: vi.fn(() => pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => true,
          releaseIfGroupExited: vi.fn(),
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => true,
        }),
      });
      const scope = {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
      };
      const terminalId = manager.create(popup, process.cwd(), 120, 40, undefined, undefined, scope);
      manager.disposeOwner(popup);
      await vi.advanceTimersByTimeAsync(31_000);
      const main = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
      expect(() => manager.attach(main, terminalId, process.cwd(), scope, 80, 24, undefined, true))
        .toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
