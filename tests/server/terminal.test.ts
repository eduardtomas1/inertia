import { spawnSync } from "node:child_process";

import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";
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
  it.skipIf(process.platform === "win32")(
    "uses the node-pty root process group on POSIX",
    async () => {
      const terminal = spawnPty("/bin/sh", [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
      const exited = new Promise<void>((resolveExit) => {
        terminal.onExit(() => resolveExit());
      });
      try {
        const group = spawnSync(
          "/bin/ps",
          ["-o", "pgid=", "-p", String(terminal.pid)],
          {
            encoding: "utf8",
            shell: false,
            timeout: 1_000,
          },
        );
        expect(group.status).toBe(0);
        expect(Number(group.stdout.trim())).toBe(terminal.pid);
      } finally {
        terminal.kill("SIGKILL");
        await new Promise<void>((resolveExit, reject) => {
          const timer = setTimeout(
            () => reject(new Error("The node-pty root did not exit.")),
            2_000,
          );
          void exited.then(() => {
            clearTimeout(timer);
            resolveExit();
          });
        });
      }
    },
  );

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
      const terminateProcessTree = vi.fn(async () => false);
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        terminateProcessTree,
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
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );
      await vi.advanceTimersByTimeAsync(20);

      await rejected;
      expect(terminal.pty.kill).toHaveBeenCalledTimes(2);
      expect(terminateProcessTree).toHaveBeenCalledWith(
        42,
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a confirmed terminal-tree escalation before runtime shutdown completes", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const terminateProcessTree = vi.fn(async (
        _pid: number,
        waitForExit: (waitMs: number) => Promise<boolean>,
      ) => {
        terminal.emitExit();
        return await waitForExit(10);
      });
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        terminateProcessTree,
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

      const shutdown = manager.disposeAll();
      await vi.advanceTimersByTimeAsync(20);

      await expect(shutdown).resolves.toBeUndefined();
      expect(terminal.pty.kill).toHaveBeenCalledTimes(2);
      expect(terminateProcessTree).toHaveBeenCalledWith(
        42,
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
