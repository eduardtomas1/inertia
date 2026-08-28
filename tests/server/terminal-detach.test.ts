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
});
