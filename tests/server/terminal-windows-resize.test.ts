import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(): {
  emitData: (data: string) => void;
  emitExit: (event: { exitCode: number }) => void;
  pty: IPty;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const pty = {
    pid: 42,
    onData: vi.fn((callback: (data: string) => void): IDisposable => {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void): IDisposable => {
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

function createWindowsShell(): {
  manager: TerminalManager;
  owner: WebSocket;
  terminal: ReturnType<typeof fakeTerminal>;
  terminalId: string;
} {
  const terminal = fakeTerminal();
  const owner = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
  } as unknown as WebSocket;
  const manager = new TerminalManager({
    spawnTerminal: () => terminal.pty,
    platform: "win32",
  });
  const terminalId = manager.createProcess(
    owner, process.cwd(), "test-shell", [], {}, 80, 24,
  );
  return { manager, owner, terminal, terminalId };
}

describe("TerminalManager Windows resize", () => {
  it("holds a Windows resize until output proves the PTY is ready", async () => {
    const { manager, owner, terminal, terminalId } = createWindowsShell();

    manager.resize(owner, terminalId, 100, 40);
    manager.resize(owner, terminalId, 120, 50);
    expect(terminal.pty.resize).not.toHaveBeenCalled();

    terminal.emitData("ready");
    expect(terminal.pty.resize).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminal.pty.resize).toHaveBeenCalledTimes(1);
    expect(terminal.pty.resize).toHaveBeenLastCalledWith(120, 50);

    manager.resize(owner, terminalId, 80, 24);
    expect(terminal.pty.resize).toHaveBeenLastCalledWith(80, 24);
  });

  it("drops a held Windows resize when the PTY exits before any output", async () => {
    const { manager, owner, terminal, terminalId } = createWindowsShell();
    manager.resize(owner, terminalId, 100, 40);
    (terminal.pty.resize as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Cannot resize a pty that has already exited");
    });

    terminal.emitExit({ exitCode: 0 });
    terminal.emitData("late output after exit");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminal.pty.resize).not.toHaveBeenCalled();
    expect(() => manager.resize(owner, terminalId, 80, 24)).toThrow(
      "Terminal not found",
    );
  });
});
