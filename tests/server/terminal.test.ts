import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../../src/server/terminal";

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakeTerminal(): {
  emitData: (data: string) => void;
  emitExit: () => void;
  pty: IPty;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const disposable = (
    callback: (event: { exitCode: number }) => void,
  ): IDisposable => ({
    dispose: () => exitListeners.delete(callback),
  });
  const pty = {
    pid: 42,
    onData: vi.fn((callback: (data: string) => void) => {
      dataListeners.add(callback);
      return {
        dispose: () => dataListeners.delete(callback),
      };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitListeners.add(callback);
      return disposable(callback);
    }),
    kill: vi.fn(),
    write: vi.fn(),
  } as unknown as IPty;
  return {
    emitData: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    emitExit: () => {
      for (const listener of exitListeners) listener({ exitCode: 0 });
    },
    pty,
  };
}

describe("TerminalManager", () => {
  it("coalesces rapid PTY output without reordering it", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const frames: string[] = [];
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload: string) => frames.push(payload),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        outputFlushMs: 8,
        terminateProcessTree: async () => true,
      });
      const terminalId = manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      for (let index = 0; index < 100; index += 1) {
        terminal.emitData(String(index % 10));
      }
      expect(frames).toEqual([]);

      await vi.advanceTimersByTimeAsync(7);
      expect(frames).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0]!)).toEqual({
        type: "terminal.output",
        terminalId,
        data: Array.from({ length: 100 }, (_, index) => String(index % 10)).join(""),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds every output payload while preserving a large burst exactly", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const frames: string[] = [];
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload: string) => frames.push(payload),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        outputFlushMs: 8,
      });
      manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );
      const output = `${"\0".repeat(16 * 1_024)}${"b".repeat(16 * 1_024)}tail`;

      terminal.emitData(output);
      await vi.advanceTimersByTimeAsync(8);

      const payloads = frames.map((frame) => JSON.parse(frame) as { data: string });
      expect(payloads.map(({ data }) => data.length)).toEqual([
        16 * 1_024,
        16 * 1_024,
        4,
      ]);
      expect(payloads.every(({ data }) => data.length <= 16 * 1_024)).toBe(true);
      expect(frames.every((frame) => Buffer.byteLength(frame) < 100 * 1_024)).toBe(true);
      expect(payloads.map(({ data }) => data).join("")).toBe(output);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending terminal output before the exit event without a later timer send", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const frames: string[] = [];
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload: string) => frames.push(payload),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        outputFlushMs: 8,
      });
      const terminalId = manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      terminal.emitData("final output");
      terminal.emitExit();

      expect(frames.map((frame) => JSON.parse(frame))).toEqual([
        { type: "terminal.output", terminalId, data: "final output" },
        { type: "terminal.exit", terminalId, exitCode: 0 },
      ]);
      await vi.advanceTimersByTimeAsync(8);
      expect(frames).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending output on managed close and never sends after disposal", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const frames: string[] = [];
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload: string) => frames.push(payload),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        outputFlushMs: 8,
        terminateProcessTree: async () => true,
      });
      const terminalId = manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      terminal.emitData("close flush");
      await expect(manager.closeManaged(terminalId)).resolves.toBe(true);
      expect(frames.map((frame) => JSON.parse(frame))).toEqual([
        { type: "terminal.output", terminalId, data: "close flush" },
      ]);

      terminal.emitData("after disposal");
      await vi.advanceTimersByTimeAsync(100);
      expect(frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a slow WebSocket and drops its remaining terminal burst", () => {
    const terminal = fakeTerminal();
    const frames: string[] = [];
    let bufferedAmount = 0;
    let readyState = 1;
    const terminate = vi.fn(() => {
      readyState = 3;
    });
    const owner = {
      get readyState() { return readyState; },
      get bufferedAmount() { return bufferedAmount; },
      send: (payload: string) => {
        frames.push(payload);
        bufferedAmount = 2 * 1_024 * 1_024;
      },
      terminate,
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
    });
    manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    );

    terminal.emitData("x".repeat(48 * 1_024));
    terminal.emitData("discarded");

    expect(frames).toHaveLength(1);
    expect((JSON.parse(frames[0]!) as { data: string }).data).toHaveLength(16 * 1_024);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("contains WebSocket send errors and does not retry buffered output", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let readyState = 1;
      const send = vi.fn(() => {
        throw new Error("socket failed");
      });
      const terminate = vi.fn(() => {
        readyState = 3;
      });
      const owner = {
        get readyState() { return readyState; },
        bufferedAmount: 0,
        send,
        terminate,
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        outputFlushMs: 8,
      });
      manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      terminal.emitData("first");
      await vi.advanceTimersByTimeAsync(8);
      terminal.emitData("second");
      await vi.advanceTimersByTimeAsync(100);

      expect(send).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it.skipIf(process.platform === "win32")(
    "removes a detached child even when the PTY root exits promptly",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-tree-"));
      const pidPath = join(directory, "child.pid");
      let childPid = 0;
      try {
        const manager = new TerminalManager();
        const owner = {} as WebSocket;
        const script = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(${JSON.stringify(process.execPath)},`,
          "  ['-e', 'setInterval(() => undefined, 1000)'],",
          "  { detached: true, stdio: 'ignore' });",
          "child.unref();",
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
          "process.stdin.resume();",
          "setInterval(() => undefined, 1000);",
        ].join("\n");
        manager.createProcess(
          owner,
          process.cwd(),
          process.execPath,
          ["-e", script],
          process.env,
          80,
          24,
        );
        await waitFor("the detached terminal child PID", () =>
          existsSync(pidPath));
        childPid = Number(readFileSync(pidPath, "utf8"));
        expect(childPid).toBeGreaterThan(1);
        expect(processExists(childPid)).toBe(true);

        await manager.disposeAll();
        await waitFor("the detached terminal child to stop", () =>
          !processExists(childPid));

        expect(processExists(childPid)).toBe(false);
      } finally {
        if (childPid > 1) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // The process-tree cleanup under test already removed it.
          }
        }
        rmSync(directory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  it("awaits a terminal already closing after its owner disconnects", async () => {
    const terminal = fakeTerminal();
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
      shutdownTimeoutMs: 100,
      terminateProcessTree: async (_pid, waitForExit) =>
        await waitForExit(100),
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

    expect(terminal.pty.kill).not.toHaveBeenCalled();
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

      await rejected;
      expect(terminal.pty.kill).not.toHaveBeenCalled();
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

      await expect(shutdown).resolves.toBeUndefined();
      expect(terminal.pty.kill).not.toHaveBeenCalled();
      expect(terminateProcessTree).toHaveBeenCalledWith(
        42,
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a prompt PTY-root exit before tree cleanup is confirmed", async () => {
    const terminal = fakeTerminal();
    let confirmTree!: (confirmed: boolean) => void;
    const terminateProcessTree = vi.fn(() =>
      new Promise<boolean>((resolveTree) => {
        confirmTree = resolveTree;
      }));
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
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

    let shutdownFinished = false;
    const shutdown = manager.disposeAll().then(() => {
      shutdownFinished = true;
    });
    terminal.emitExit();
    await Promise.resolve();

    expect(terminateProcessTree).toHaveBeenCalledWith(
      42,
      expect.any(Function),
    );
    expect(shutdownFinished).toBe(false);

    confirmTree(true);
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it("only acknowledges a managed close after tree cleanup is confirmed", async () => {
    const terminal = fakeTerminal();
    let confirmTree!: (confirmed: boolean) => void;
    const terminateProcessTree = vi.fn(() =>
      new Promise<boolean>((resolveTree) => {
        confirmTree = resolveTree;
      }));
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
      terminateProcessTree,
    });
    const owner = {} as WebSocket;
    const onExit = vi.fn();
    const terminalId = manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
      onExit,
    );

    let acknowledged = false;
    const closing = manager.closeManaged(terminalId).then((closed) => {
      acknowledged = closed;
      return closed;
    });
    terminal.emitExit();
    await Promise.resolve();

    expect(terminateProcessTree).toHaveBeenCalledWith(
      42,
      expect.any(Function),
    );
    expect(acknowledged).toBe(false);
    expect(onExit).not.toHaveBeenCalled();

    confirmTree(true);
    await expect(closing).resolves.toBe(true);
    expect(acknowledged).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(130);
  });

  it("retains managed shutdown control after confirmation failure and permits retry", async () => {
    const terminal = fakeTerminal();
    const terminateProcessTree = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const createProcessTreeTermination = vi.fn(() => terminateProcessTree);
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
      createProcessTreeTermination,
    });
    const owner = {} as WebSocket;
    const onExit = vi.fn();
    const terminalId = manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
      onExit,
    );

    await expect(manager.closeManaged(terminalId)).rejects.toThrow(
      "A terminal process tree could not be confirmed stopped during runtime shutdown.",
    );
    terminal.emitExit();
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
    expect(() => manager.input(owner, terminalId, "echo unsafe")).toThrow(
      "Terminal not found.",
    );

    await expect(manager.closeManaged(terminalId)).resolves.toBe(true);
    expect(createProcessTreeTermination).toHaveBeenCalledOnce();
    expect(createProcessTreeTermination).toHaveBeenCalledWith(
      42,
      expect.any(Function),
    );
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(130);
    await expect(manager.closeManaged(terminalId)).resolves.toBe(false);
    await expect(manager.disposeAll()).resolves.toBeUndefined();
  });
});
