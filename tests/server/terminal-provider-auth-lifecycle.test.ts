// @inertia-test-suite portable
import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../src/server/terminal";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

function authTerminal() {
  const listeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const pty = {
    pid: 42,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  } as unknown as IPty;
  const emitExit = (exitCode: number, signal?: number) => {
    for (const listener of listeners) listener({ exitCode, signal });
  };
  let stopped = true;
  const release = vi.fn(() => true);
  const quarantine = vi.fn(() => true);
  const onExit = vi.fn();
  const recovery = vi.fn();
  const owner = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
  const manager = new TerminalManager({
    spawnTerminal: () => pty,
    spawnOwnedTerminalProcess: (spawnProcess) => ({
      process: spawnProcess(),
      confirmStopped: () => stopped,
      releaseIfGroupExited: () => undefined,
      requestGuardianStop: () => false,
      waitForGuardianStop: async () => false,
    }),
    terminateProcessTree: async () => stopped,
    onOwnedProcessCleanupUnconfirmed: recovery,
  });
  const terminalId = manager.createProcess(
    owner as unknown as WebSocket, process.cwd(), "fixture-kimi", ["login"], {}, 80, 24,
    onExit, undefined,
    { accept: () => ({ release, quarantine }), abandonBeforeSpawn: () => false },
  );
  return { manager, owner, terminalId, emitExit, release, quarantine, onExit, recovery,
    setStopped: (value: boolean) => { stopped = value; } };
}

describe("provider sign-in terminal settlement", () => {
  it.each([
    [0, undefined, 0],
    [0, 0, 0],
    [7, 0, 7],
    [0, 15, 143],
    [9, 15, 9],
  ])("reports exit %s / signal %s as %s only after releasing installation authority", async (code, signal, expected) => {
    const terminal = authTerminal();
    terminal.onExit.mockImplementation(() => {
      expect(terminal.release).toHaveBeenCalledWith({ cleanupConfirmed: true });
    });
    terminal.emitExit(code!, signal);
    expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      type: "terminal.exit", terminalId: terminal.terminalId, exitCode: expected,
    }));
    expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(expected);
    expect(terminal.quarantine).not.toHaveBeenCalled();
    expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
    terminal.emitExit(0);
    expect(terminal.onExit).toHaveBeenCalledOnce();
    await terminal.manager.disposeAll();
  });

  it("does not report success or trigger refresh when a zero exit lacks complete tree proof", async () => {
    const terminal = authTerminal();
    terminal.setStopped(false);
    terminal.emitExit(0, 0);
    expect(terminal.owner.send).not.toHaveBeenCalled();
    expect(terminal.onExit).not.toHaveBeenCalled();
    expect(terminal.release).not.toHaveBeenCalled();
    expect(terminal.quarantine).toHaveBeenCalledExactlyOnceWith(
      "terminal-provider-natural-exit-cleanup-unconfirmed",
    );
    expect(terminal.recovery).toHaveBeenCalledOnce();
    await expect(terminal.manager.disposeAll()).rejects.toThrow("could not be retired");
  });

  it("withholds terminal completion when installation retirement itself refuses", async () => {
    const terminal = authTerminal();
    terminal.release.mockReturnValue(false);
    terminal.emitExit(0, 0);
    expect(terminal.owner.send).not.toHaveBeenCalled();
    expect(terminal.onExit).not.toHaveBeenCalled();
    expect(terminal.recovery).toHaveBeenCalledOnce();
    await expect(terminal.manager.disposeAll()).rejects.toThrow("could not be retired");
  });

  it("reports an explicitly closed login as cancelled, even if its PTY then exits zero", async () => {
    const terminal = authTerminal();
    const closing = terminal.manager.close(terminal.owner as unknown as WebSocket, terminal.terminalId);
    terminal.emitExit(0, 0);
    await closing;
    expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(130);
    expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      type: "terminal.exit", terminalId: terminal.terminalId, exitCode: 130,
    }));
    expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
    await terminal.manager.disposeAll();
  });
});
