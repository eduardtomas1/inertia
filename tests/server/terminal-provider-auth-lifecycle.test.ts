// @inertia-test-suite portable
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IPty } from "node-pty";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { TerminalManager, type TerminalManagerOptions } from "../../src/server/terminal";
import { RuntimeOwnedProcessJournal, spawnRuntimeOwnedPidProcess } from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

function authTerminal(spawnOwnedTerminalProcess?: TerminalManagerOptions["spawnOwnedTerminalProcess"]) {
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
  const confirmStopped = vi.fn(() => stopped);
  const requestGuardianStop = vi.fn(() => false);
  const terminateProcessTree = vi.fn(async () => stopped);
  const release = vi.fn(() => true);
  const quarantine = vi.fn(() => true);
  const onExit = vi.fn();
  const recovery = vi.fn();
  const owner = { readyState: 1, bufferedAmount: 0,
    send: vi.fn((_data: string, callback?: (error?: Error) => void) => callback?.()),
  };
  const manager = new TerminalManager({
    shutdownTimeoutMs: 50,
    closeTimeoutMs: 100,
    spawnTerminal: () => pty,
    spawnOwnedTerminalProcess: spawnOwnedTerminalProcess ?? ((spawnProcess) => ({
      process: spawnProcess(),
      confirmStopped,
      releaseIfGroupExited: () => undefined,
      requestGuardianStop,
      waitForGuardianStop: async () => false,
    })),
    terminateProcessTree,
    onOwnedProcessCleanupUnconfirmed: recovery,
  });
  const terminalId = manager.createProcess(
    owner as unknown as WebSocket, process.cwd(), "fixture-kimi", ["login"], {}, 80, 24,
    onExit, undefined,
    { accept: () => ({ release, quarantine }), abandonBeforeSpawn: () => false },
  );
  return { manager, owner, terminalId, emitExit, release, quarantine, onExit, recovery,
    confirmStopped, requestGuardianStop, terminateProcessTree,
    setStopped: (value: boolean) => { stopped = value; } };
}

describe("provider sign-in terminal settlement", () => {
  it("composes deferred Darwin admission and durable claim release with provider terminal completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-auth-retirement-"));
    const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
    const identity = {
      platform: "darwin" as const,
      pid: 42,
      parentPid: process.pid,
      processGroupId: 42,
      sessionId: 42,
      startTimeSeconds: "1756100000",
      startTimeMicroseconds: 123_456,
    };
    let settleReady!: (value: typeof identity) => void;
    const ready = new Promise<typeof identity>((resolve) => { settleReady = resolve; });
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      "test:10000000-0000-4000-8000-000000000001",
      {
        platform: "darwin",
        darwinGuardianPath: join(directory, "synthetic-guardian"),
        readDarwinGuardianReadyAsync: async () => await ready,
        readDarwinIdentity: () => identity,
        readDarwinIdentityAsync: async () => identity,
      },
    );
    try {
      // Only native identity observation and signals are synthetic: admission,
      // the private durable journal, and TerminalManager are production code.
      const terminal = authTerminal(spawnRuntimeOwnedPidProcess);
      const journal = new RuntimeOwnedProcessJournal(directory);
      const completionProofs: Array<{ claimCount: number | null; installationReleased: boolean }> = [];
      terminal.onExit.mockImplementation(() => {
        completionProofs.push({
          claimCount: journal.records(runtimeGenerationId)?.length ?? null,
          installationReleased: terminal.release.mock.calls.length === 1,
        });
      });
      terminal.emitExit(0, 0);
      expect(journal.records(runtimeGenerationId)).toMatchObject([{ state: "pending" }]);
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.owner.send).not.toHaveBeenCalled();
      expect(terminal.release).not.toHaveBeenCalled();

      settleReady(identity);
      await vi.waitFor(() => expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(0));
      expect(completionProofs).toEqual([{ claimCount: 0, installationReleased: true }]);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(processKill).toHaveBeenCalledExactlyOnceWith(42, "SIGUSR1");
      expect(terminal.recovery).not.toHaveBeenCalled();
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.release).toHaveBeenCalledOnce();
      expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
      await terminal.manager.disposeAll();
    } finally {
      deactivate?.();
      processKill.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, undefined])("waits for the exact natural-exit claim with signal %s to retire before releasing the installation or refreshing", async (signal) => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    try {
      terminal.emitExit(0, signal);
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.release).not.toHaveBeenCalled();
      expect(terminal.owner.send).not.toHaveBeenCalled();
      expect(terminal.onExit).not.toHaveBeenCalled();
      expect(terminal.manager.hasUpdateBlockingActivity()).toBe(true);
      expect(terminal.manager.ownedResourceCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(30);
      terminal.setStopped(true);
      await vi.advanceTimersByTimeAsync(10);

      expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
      expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(0);
      expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: "terminal.exit", terminalId: terminal.terminalId, exitCode: 0,
      }), expect.any(Function));
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.recovery).not.toHaveBeenCalled();
      expect(terminal.requestGuardianStop).not.toHaveBeenCalled();
      expect(terminal.terminateProcessTree).not.toHaveBeenCalled();
      expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
      expect(terminal.manager.ownedResourceCount()).toBe(0);
      await terminal.manager.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [0, undefined, 0],
    [0, 0, 0],
    [7, 0, 7],
    [0, 15, 143],
    [9, 15, 9],
  ])("reports exit %s / signal %s as %s only after releasing installation authority", async (code, signal, expected) => {
    const terminal = authTerminal();
    terminal.emitExit(code!, signal);
    expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      type: "terminal.exit", terminalId: terminal.terminalId, exitCode: expected,
    }), expect.any(Function));
    expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(expected);
    expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
    expect(terminal.release.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.onExit.mock.invocationCallOrder[0]!,
    );
    expect(terminal.quarantine).not.toHaveBeenCalled();
    expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
    terminal.emitExit(0);
    expect(terminal.onExit).toHaveBeenCalledOnce();
    await terminal.manager.disposeAll();
  });

  it("quarantines at the existing close deadline and cannot revive success after late proof", async () => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    try {
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(99);
      expect(terminal.quarantine).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(terminal.quarantine).toHaveBeenCalledExactlyOnceWith(
        "terminal-provider-natural-exit-cleanup-unconfirmed",
      );
      expect(terminal.recovery).toHaveBeenCalledOnce();
      terminal.setStopped(true);
      terminal.emitExit(0, 0);
      await expect(terminal.manager.disposeAll()).rejects.toThrow("could not be retired");
      expect(terminal.owner.send).not.toHaveBeenCalled();
      expect(terminal.onExit).not.toHaveBeenCalled();
      expect(terminal.release).not.toHaveBeenCalled();
      expect(terminal.manager.ownedResourceCount()).toBe(1);
      expect(terminal.requestGuardianStop).not.toHaveBeenCalled();
      expect(terminal.terminateProcessTree).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks a rejected retirement proof without publishing success or signalling an exited PID", async () => {
    const terminal = authTerminal();
    terminal.confirmStopped.mockReturnValueOnce(false).mockImplementation(() => {
      throw new Error("Synthetic ownership reader failed");
    });
    terminal.emitExit(0, 0);
    await expect(terminal.manager.disposeAll()).rejects.toThrow("could not be retired");
    expect(terminal.quarantine).toHaveBeenCalledExactlyOnceWith(
      "terminal-provider-natural-exit-cleanup-unconfirmed",
    );
    expect(terminal.recovery).toHaveBeenCalledOnce();
    expect(terminal.owner.send).not.toHaveBeenCalled();
    expect(terminal.onExit).not.toHaveBeenCalled();
    expect(terminal.release).not.toHaveBeenCalled();
    expect(terminal.requestGuardianStop).not.toHaveBeenCalled();
    expect(terminal.terminateProcessTree).not.toHaveBeenCalled();
  });

  it("lets runtime shutdown tighten a pending natural retirement without granting a fresh deadline", async () => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    try {
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(30);
      const shutdown = terminal.manager.disposeAll(Date.now() + 20);
      const rejected = expect(shutdown).rejects.toThrow("could not be retired");
      await vi.advanceTimersByTimeAsync(19);
      expect(terminal.recovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(terminal.recovery).toHaveBeenCalledOnce();
      expect(terminal.release).not.toHaveBeenCalled();
      expect(terminal.onExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first nonzero result when duplicate exits arrive during asynchronous retirement", async () => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    try {
      terminal.emitExit(7, 0);
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(20);
      terminal.setStopped(true);
      await vi.advanceTimersByTimeAsync(10);
      terminal.emitExit(0, 0);
      expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(7);
      expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: "terminal.exit", terminalId: terminal.terminalId, exitCode: 7,
      }), expect.any(Function));
      expect(terminal.release).toHaveBeenCalledOnce();
      await terminal.manager.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["close", "shutdown"] as const)("publishes cancellation once when %s races pending natural retirement", async (action) => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    try {
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(20);
      const closing = action === "close"
        ? terminal.manager.close(terminal.owner as unknown as WebSocket, terminal.terminalId)
        : terminal.manager.disposeAll();
      terminal.emitExit(0, 0);
      expect(terminal.owner.send).not.toHaveBeenCalled();
      terminal.setStopped(true);
      await vi.advanceTimersByTimeAsync(10);
      await closing;
      expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(130);
      expect(terminal.owner.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        type: "terminal.exit", terminalId: terminal.terminalId, exitCode: 130,
      }), expect.any(Function));
      expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.requestGuardianStop).not.toHaveBeenCalled();
      expect(terminal.terminateProcessTree).not.toHaveBeenCalled();
      expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
      await terminal.manager.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds completion when installation retirement refuses after delayed process proof", async () => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    terminal.release.mockReturnValue(false);
    try {
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(20);
      terminal.setStopped(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
      expect(terminal.recovery).toHaveBeenCalledOnce();
      expect(terminal.onExit).not.toHaveBeenCalled();
      expect(terminal.owner.send).not.toHaveBeenCalled();
      await expect(terminal.manager.disposeAll()).rejects.toThrow("could not be retired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a disconnected recipient or throwing refresh into a cleanup failure after proof", async () => {
    vi.useFakeTimers();
    const terminal = authTerminal();
    terminal.setStopped(false);
    terminal.owner.send.mockImplementation(() => { throw new Error("Disconnected"); });
    terminal.onExit.mockImplementation(() => { throw new Error("Refresh failed"); });
    try {
      terminal.emitExit(0, 0);
      await vi.advanceTimersByTimeAsync(20);
      terminal.setStopped(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
      expect(terminal.onExit).toHaveBeenCalledExactlyOnceWith(0);
      expect(terminal.recovery).not.toHaveBeenCalled();
      expect(terminal.quarantine).not.toHaveBeenCalled();
      expect(terminal.manager.hasUpdateBlockingActivity()).toBe(false);
      await terminal.manager.disposeAll();
    } finally {
      vi.useRealTimers();
    }
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
    }), expect.any(Function));
    expect(terminal.release).toHaveBeenCalledExactlyOnceWith({ cleanupConfirmed: true });
    await terminal.manager.disposeAll();
  });
});
