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

function fakeTerminal(pid = 42): {
  emitData: (data: string) => void;
  emitExit: (event?: { exitCode?: number; signal?: number }) => void;
  pty: IPty;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(
    event: { exitCode: number; signal?: number },
  ) => void>();
  const disposable = (
    callback: (event: { exitCode: number; signal?: number }) => void,
  ): IDisposable => ({
    dispose: () => exitListeners.delete(callback),
  });
  const pty = {
    pid,
    onData: vi.fn((callback: (data: string) => void) => {
      dataListeners.add(callback);
      return {
        dispose: () => dataListeners.delete(callback),
      };
    }),
    onExit: vi.fn((callback: (
      event: { exitCode: number; signal?: number },
    ) => void) => {
      exitListeners.add(callback);
      return disposable(callback);
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
  return {
    emitData: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    emitExit: (event = {}) => {
      for (const listener of exitListeners) listener({
        exitCode: event.exitCode ?? 0,
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      });
    },
    pty,
  };
}

describe("TerminalManager", () => {
  it("preserves a pre-escaped Windows PTY command line verbatim", () => {
    const terminal = fakeTerminal();
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const spawnTerminal = vi.fn(() => terminal.pty);
    const manager = new TerminalManager({ spawnTerminal });
    const commandLine = '/d /s /v:off /c "C:\\Tools\\agent.cmd ^"hello world^""';

    manager.createProcess(
      owner,
      process.cwd(),
      "C:\\Windows\\System32\\cmd.exe",
      commandLine,
      {},
      80,
      24,
    );

    expect(spawnTerminal).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      commandLine,
      expect.any(Object),
    );
  });

  it("atomically blocks PTY creation during update preparation", () => {
    const terminal = fakeTerminal();
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const spawnTerminal = vi.fn(() => terminal.pty);
    const manager = new TerminalManager({ spawnTerminal });

    manager.holdForUpdatePreparation();
    expect(manager.hasUpdateBlockingActivity()).toBe(false);
    expect(() => manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    )).toThrow("terminal service is stopping");
    expect(spawnTerminal).not.toHaveBeenCalled();

    manager.releaseUpdatePreparation();
    manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    );
    expect(manager.hasUpdateBlockingActivity()).toBe(true);
    expect(spawnTerminal).toHaveBeenCalledOnce();
  });

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

  it("reattaches the exact scoped PTY with bounded replay and transfers stale ownership", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const firstOwner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const replacementFrames: string[] = [];
      const replacementOwner = {
        readyState: 1,
        bufferedAmount: 0,
        send: (payload: string) => replacementFrames.push(payload),
      } as unknown as WebSocket;
      const terminateProcessTree = vi.fn(async () => true);
      const manager = new TerminalManager({
        platform: "linux",
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => true,
          releaseIfGroupExited: vi.fn(),
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => true,
        }),
        terminateProcessTree,
        reattachTimeoutMs: 50,
      });
      const scope = {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: "22222222-2222-4222-8222-222222222222",
      };
      const terminalId = manager.create(
        firstOwner,
        process.cwd(),
        80,
        24,
        undefined,
        undefined,
        scope,
      );
      const retained = `${"x".repeat(300_000)}tail`;
      terminal.emitData(retained);

      const attachment = manager.attach(
        replacementOwner,
        terminalId,
        process.cwd(),
        scope,
        91,
        31,
      );

      expect(attachment).toEqual({ terminalId });
      expect(terminal.pty.resize).toHaveBeenCalledWith(91, 31);
      expect(() => manager.input(firstOwner, terminalId, "stale")).toThrow(
        "Terminal not found",
      );
      manager.disposeOwner(firstOwner);
      manager.input(replacementOwner, terminalId, "current");
      expect(terminal.pty.write).toHaveBeenCalledWith("current");
      const replay = replacementFrames.map((frame) => (
        JSON.parse(frame) as { data: string }
      ).data).join("");
      expect(replay).toContain("Earlier terminal output was truncated");
      expect(replay.endsWith(`${"x".repeat(256 * 1_024 - 4)}tail`)).toBe(true);
      expect(replacementFrames.every((frame) => (
        (JSON.parse(frame) as { data: string }).data.length <= 16 * 1_024
      ))).toBe(true);
      expect(terminateProcessTree).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the prior owner when a reattach replay cannot be delivered", () => {
    const terminal = fakeTerminal();
    const firstOwner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const disconnectedOwner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(() => { throw new Error("closed"); }),
      terminate: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
    });
    const scope = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: null,
    };
    const terminalId = manager.create(
      firstOwner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    );
    terminal.emitData("retained");

    expect(() => manager.attach(
      disconnectedOwner,
      terminalId,
      process.cwd(),
      scope,
      91,
      31,
    )).toThrow("terminal client disconnected");
    manager.input(firstOwner, terminalId, "still-owned");
    expect(terminal.pty.write).toHaveBeenCalledWith("still-owned");
  });

  it("enforces the per-window capacity when scoped terminals transfer", () => {
    const terminals = Array.from({ length: 5 }, (_, index) => fakeTerminal(50 + index));
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminals.shift()!.pty),
    });
    const target = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const sources = Array.from({ length: 5 }, () => ({
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket));
    const scopes = sources.map((_, index) => ({
      projectId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      conversationId: null,
    }));
    const ids = sources.map((owner, index) => manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scopes[index],
    ));

    for (let index = 0; index < 4; index += 1) {
      manager.attach(target, ids[index], process.cwd(), scopes[index], 80, 24);
    }
    expect(() => manager.attach(
      target,
      ids[4],
      process.cwd(),
      scopes[4],
      80,
      24,
    )).toThrow("maximum number of terminals");
    manager.input(sources[4], ids[4], "still-owned");
  });

  it("keeps a detached scoped terminal alive only for its exact bounded lease", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const terminateProcessTree = vi.fn(async () => true);
      const manager = new TerminalManager({
        platform: "linux",
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => true,
          releaseIfGroupExited: vi.fn(),
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => true,
        }),
        terminateProcessTree,
        reattachTimeoutMs: 50,
      });
      const scope = {
        projectId: "11111111-1111-4111-8111-111111111111",
        conversationId: null,
      };
      const terminalId = manager.create(
        owner,
        process.cwd(),
        80,
        24,
        undefined,
        undefined,
        scope,
      );

      manager.disposeOwner(owner);
      await vi.advanceTimersByTimeAsync(49);
      expect(terminateProcessTree).not.toHaveBeenCalled();
      expect(manager.hasUpdateBlockingActivity()).toBe(true);
      expect(() => manager.attach(
        owner,
        terminalId,
        process.cwd(),
        { ...scope, projectId: "33333333-3333-4333-8333-333333333333" },
        80,
        24,
      )).toThrow("Terminal not found");

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(terminateProcessTree).toHaveBeenCalledOnce();
      expect(manager.hasUpdateBlockingActivity()).toBe(false);
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

  it("publishes a client-close exit only after the process tree is confirmed stopped", async () => {
    const terminal = fakeTerminal();
    const frames: string[] = [];
    let confirmStopped!: (confirmed: boolean) => void;
    const stopped = new Promise<boolean>((resolve) => {
      confirmStopped = resolve;
    });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: string) => frames.push(payload),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
      terminateProcessTree: async () => await stopped,
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

    const closing = manager.close(owner, terminalId);
    expect(frames).toEqual([]);

    confirmStopped(true);
    await expect(closing).resolves.toBeUndefined();
    await waitFor("confirmed client-close exit", () => frames.length === 1);
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "terminal.exit", terminalId, exitCode: 130 },
    ]);
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
        terminateProcessTree: vi.fn(async () => true),
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
      expect(manager.hasUpdateBlockingActivity()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves authoritative provider ownership when a replacement reattaches", async () => {
    const terminals = [fakeTerminal(101), fakeTerminal(102)];
    const spawnTerminal = vi.fn(() => (
      terminals[spawnTerminal.mock.calls.length - 1]!.pty
    ));
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const nextOwner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => true,
        releaseIfGroupExited: vi.fn(),
        requestGuardianStop: () => false,
        waitForGuardianStop: async () => true,
      }),
      terminateProcessTree: vi.fn(async () => true),
    });
    const scope = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
    };
    const originalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    );
    const providerResume = {
      descriptor: {
        providerId: "codex" as const,
        providerLabel: "Codex",
        sessionId: "33333333-3333-4333-8333-333333333333",
      },
      conversationId: "44444444-4444-4444-8444-444444444444",
    };

    const replacementId = await manager.replaceProcess(
      owner,
      originalId,
      process.cwd(),
      "provider-shell",
      [],
      {},
      80,
      24,
      undefined,
      undefined,
      providerResume,
    );

    expect(manager.attach(
      nextOwner,
      replacementId,
      process.cwd(),
      scope,
      91,
      31,
    )).toEqual({
      terminalId: replacementId,
      providerResume: providerResume.descriptor,
      providerResumeConversationId: providerResume.conversationId,
    });
  });

  it("replaces an owned shell at capacity without changing its public identity", async () => {
    const terminals = Array.from({ length: 5 }, (_, index) =>
      fakeTerminal(100 + index));
    const spawnTerminal = vi.fn(() => terminals[spawnTerminal.mock.calls.length - 1]!.pty);
    let confirmOldStopped!: (confirmed: boolean) => void;
    const oldStopped = new Promise<boolean>((resolve) => {
      confirmOldStopped = resolve;
    });
    const terminateProcessTree = vi.fn(async (pid: number) =>
      pid === 100 ? await oldStopped : true);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
      terminateProcessTree,
    });
    const ids = Array.from({ length: 4 }, () => manager.create(
      owner,
      process.cwd(),
      80,
      24,
    ));
    expect(() => manager.createProcess(
      owner,
      process.cwd(),
      "fifth-shell",
      [],
      {},
      80,
      24,
    )).toThrow("maximum number of terminals");

    const replacement = manager.replace(
      owner,
      ids[0]!,
      process.cwd(),
      80,
      24,
    );

    expect(spawnTerminal).toHaveBeenCalledTimes(4);
    expect(() => manager.createProcess(
      owner,
      process.cwd(),
      "slot-stealer",
      [],
      {},
      80,
      24,
    )).toThrow("maximum number of terminals");
    for (const id of ids.slice(1)) manager.input(owner, id, "unrelated");
    expect(terminals.slice(1, 4).every(({ pty }) =>
      vi.mocked(pty.write).mock.calls.some(([data]) => data === "unrelated")))
      .toBe(true);

    confirmOldStopped(true);
    const replacementId = await replacement;

    expect(spawnTerminal).toHaveBeenCalledTimes(5);
    expect(terminateProcessTree).toHaveBeenCalledWith(100, expect.any(Function));
    expect(replacementId).toBe(ids[0]);
    manager.input(owner, replacementId, "new");
    expect(terminals[4]!.pty.write).toHaveBeenCalledWith("new");
    expect(owner.send).not.toHaveBeenCalled();
  });

  it("preserves a Darwin local shell visibly when starting its replacement", async () => {
    const replacedTerminal = fakeTerminal(100);
    const replacementTerminal = fakeTerminal(101);
    const requestPayloadExit = vi.fn(() => false);
    const requestGuardianStop = vi.fn(() => true);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "darwin",
      shutdownTimeoutMs: 100,
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => false,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit,
        requestGuardianStop,
        waitForGuardianStop: async () => true,
      }),
    });
    const terminalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
    );

    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );

    const replacementId = await replacement;

    expect(replacementId).not.toBe(terminalId);
    expect(requestPayloadExit).not.toHaveBeenCalled();
    expect(requestGuardianStop).not.toHaveBeenCalled();
    expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
    manager.input(owner, terminalId, "old-shell");
    manager.input(owner, replacementId, "new-process");
    expect(replacedTerminal.pty.write).toHaveBeenCalledWith("old-shell");
    expect(replacementTerminal.pty.write).toHaveBeenCalledWith("new-process");
    expect(owner.send).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguously delivered Darwin replacement without hiding its shell", async () => {
    const replacedTerminal = fakeTerminal(100);
    const replacementTerminal = fakeTerminal(101);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const scope = { projectId: crypto.randomUUID(), conversationId: crypto.randomUUID() };
    const manager = new TerminalManager({
      platform: "darwin",
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => false,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop: () => true,
        waitForGuardianStop: async () => true,
      }),
    });
    const terminalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    );
    const replacementId = await manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
      undefined,
      undefined,
      null,
      false,
      "77777777-7777-4777-8777-777777777777",
    );

    expect(() => manager.attach(
      owner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
      "88888888-8888-4888-8888-888888888888",
    )).toThrow("Terminal replacement not found");
    manager.input(owner, replacementId, "provider");
    manager.input(owner, terminalId, "shell");
    expect(replacementTerminal.pty.write).toHaveBeenCalledWith("provider");
    expect(replacedTerminal.pty.write).toHaveBeenCalledWith("shell");
    replacedTerminal.emitExit({ exitCode: 0, signal: 0 });
    expect(manager.attach(
      owner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
      "77777777-7777-4777-8777-777777777777",
    ).terminalId).toBe(replacementId);
    expect(manager.attach(
      owner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
      "77777777-7777-4777-8777-777777777777",
    ).terminalId).toBe(replacementId);
  });

  it("keeps a Darwin local shell healthy when its separate replacement cannot spawn", async () => {
    const replacedTerminal = fakeTerminal(100);
    const requestGuardianStop = vi.fn(() => true);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockImplementationOnce(() => {
        throw new Error("spawn failed");
      });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "darwin",
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => false,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop,
        waitForGuardianStop: async () => true,
      }),
    });
    const terminalId = manager.create(owner, process.cwd(), 80, 24);

    await expect(manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    )).rejects.toThrow("Unable to start a terminal for this project");

    expect(requestGuardianStop).not.toHaveBeenCalled();
    manager.input(owner, terminalId, "still-healthy");
    expect(replacedTerminal.pty.write).toHaveBeenCalledWith("still-healthy");
  });

  it("does not grant a capacity allowance to a preserved Darwin shell", async () => {
    const terminals = Array.from({ length: 4 }, (_, index) => fakeTerminal(100 + index));
    const spawnTerminal = vi.fn()
      .mockImplementation(() => terminals[spawnTerminal.mock.calls.length - 1]!.pty);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "darwin",
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => false,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop: () => true,
        waitForGuardianStop: async () => true,
      }),
    });
    const terminalIds = terminals.map(() =>
      manager.create(owner, process.cwd(), 80, 24));

    await expect(manager.replaceProcess(
      owner,
      terminalIds[0]!,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    )).rejects.toThrow("maximum number of terminals");

    expect(spawnTerminal).toHaveBeenCalledTimes(4);
    manager.input(owner, terminalIds[0]!, "still-owned");
    expect(terminals[0]!.pty.write).toHaveBeenCalledWith("still-owned");
  });

  it.each([
    "client close",
    "owner disconnect",
    "detached reattach expiry",
    "runtime shutdown",
  ] as const)("uses strict guardian retirement for Darwin %s", async (action) => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal(100);
      let ownershipStopped = false;
      const requestPayloadExit = vi.fn(() => true);
      const requestGuardianStop = vi.fn(() => true);
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        shutdownTimeoutMs: 20,
        reattachTimeoutMs: 5,
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: (signal) => {
            if (signal === 0) ownershipStopped = true;
          },
          requestPayloadExit,
          requestGuardianStop,
          waitForGuardianStop: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 15));
            return true;
          },
        }),
      });
      const terminalId = manager.create(
        owner,
        process.cwd(),
        80,
        24,
        undefined,
        undefined,
        action === "detached reattach expiry"
          ? { projectId: "project-1", conversationId: "conversation-1" }
          : null,
      );

      let completion: Promise<void>;
      if (action === "client close") {
        completion = manager.close(owner, terminalId);
      } else if (action === "owner disconnect") {
        manager.disposeOwner(owner);
        completion = manager.disposeAll(Date.now() + 100);
      } else if (action === "detached reattach expiry") {
        manager.disposeOwner(owner);
        await vi.advanceTimersByTimeAsync(5);
        completion = manager.disposeAll(Date.now() + 100);
      } else {
        completion = manager.disposeAll(Date.now() + 100);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(requestGuardianStop).toHaveBeenCalledOnce();
      expect(requestPayloadExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(14);
      expect(terminal.pty.write).not.toHaveBeenCalled();
      expect(requestPayloadExit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(requestGuardianStop).toHaveBeenCalledOnce();
      expect(requestPayloadExit).not.toHaveBeenCalled();
      expect(terminal.pty.write).not.toHaveBeenCalled();
      terminal.emitExit({ exitCode: 0, signal: 0 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(completion).resolves.toBeUndefined();

      if (action === "client close") {
        expect(owner.send).toHaveBeenCalledWith(JSON.stringify({
          type: "terminal.exit",
          terminalId,
          exitCode: 130,
        }));
      } else {
        expect(owner.send).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Darwin replacement blocked when graceful shell exit is unproved", async () => {
    vi.useFakeTimers();
    try {
      const replacedTerminal = fakeTerminal(100);
      const replacementTerminal = fakeTerminal(101);
      const requestPayloadExit = vi.fn(() => true);
      const requestGuardianStop = vi.fn(() => true);
      const spawnTerminal = vi.fn()
        .mockReturnValueOnce(replacedTerminal.pty)
        .mockReturnValueOnce(replacementTerminal.pty);
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        shutdownTimeoutMs: 20,
        spawnTerminal,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => false,
          releaseIfGroupExited: () => undefined,
          requestPayloadExit,
          requestGuardianStop,
          waitForGuardianStop: async () => true,
        }),
      });
      const terminalId = manager.create(
        owner,
        process.cwd(),
        80,
        24,
      );

      const replacement = manager.replaceProcess(
        owner,
        terminalId,
        process.cwd(),
        "provider-cli",
        ["resume", "session-id"],
        {},
        80,
        24,
      );
      const rejected = expect(replacement).rejects.toThrow(
        "A terminal process ownership claim could not be retired during runtime shutdown.",
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(requestPayloadExit).toHaveBeenCalledOnce();
      expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(requestGuardianStop).toHaveBeenCalledOnce();
      replacedTerminal.emitExit({ exitCode: 0, signal: 31 });
      await vi.advanceTimersByTimeAsync(20);

      await rejected;
      expect(spawnTerminal).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the full Darwin guardian fallback budget after graceful exit", async () => {
    vi.useFakeTimers();
    try {
      const replacedTerminal = fakeTerminal(100);
      const replacementTerminal = fakeTerminal(101);
      let ownershipStopped = false;
      let replacementSettled = false;
      const requestPayloadExit = vi.fn(() => true);
      const requestGuardianStop = vi.fn(() => true);
      const spawnTerminal = vi.fn()
        .mockReturnValueOnce(replacedTerminal.pty)
        .mockReturnValueOnce(replacementTerminal.pty);
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        shutdownTimeoutMs: 20,
        spawnTerminal,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestPayloadExit,
          requestGuardianStop,
          waitForGuardianStop: async () => true,
        }),
      });
      const terminalId = manager.create(owner, process.cwd(), 80, 24);

      const replacement = manager.replaceProcess(
        owner,
        terminalId,
        process.cwd(),
        "provider-cli",
        ["resume", "session-id"],
        {},
        80,
        24,
      ).finally(() => {
        replacementSettled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(requestPayloadExit).toHaveBeenCalledOnce();
      expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(requestGuardianStop).toHaveBeenCalledOnce();

      // This is beyond the original graceful-plus-fallback deadline. The strict
      // guardian path must still own its complete configured 20 ms budget.
      await vi.advanceTimersByTimeAsync(19);
      expect(replacementSettled).toBe(false);
      ownershipStopped = true;
      replacedTerminal.emitExit({ exitCode: 0, signal: 0 });
      await vi.advanceTimersByTimeAsync(1);

      await expect(replacement).resolves.toEqual(expect.any(String));
      expect(spawnTerminal).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets runtime shutdown tighten an active Darwin fallback deadline", async () => {
    vi.useFakeTimers();
    try {
      const replacedTerminal = fakeTerminal(100);
      const replacementTerminal = fakeTerminal(101);
      let settleGuardianStop!: (confirmed: boolean) => void;
      const guardianStop = new Promise<boolean>((resolve) => {
        settleGuardianStop = resolve;
      });
      const requestGuardianStop = vi.fn(() => true);
      const spawnTerminal = vi.fn()
        .mockReturnValueOnce(replacedTerminal.pty)
        .mockReturnValueOnce(replacementTerminal.pty);
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        shutdownTimeoutMs: 20,
        spawnTerminal,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => false,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop,
          waitForGuardianStop: async () => await guardianStop,
        }),
      });
      const terminalId = manager.create(owner, process.cwd(), 80, 24);

      const replacement = manager.replaceProcess(
        owner,
        terminalId,
        process.cwd(),
        "provider-cli",
        ["resume", "session-id"],
        {},
        80,
        24,
      );
      const replacementRejected = expect(replacement).rejects.toThrow(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(requestGuardianStop).toHaveBeenCalledOnce();

      const shutdown = manager.disposeAll(Date.now() + 5);
      const shutdownRejected = expect(shutdown).rejects.toThrow(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );
      await vi.advanceTimersByTimeAsync(5);

      await replacementRejected;
      await shutdownRejected;
      expect(spawnTerminal).toHaveBeenCalledOnce();
      settleGuardianStop(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the authoritative runtime deadline for non-graceful claim retirement", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal(100);
      let ownershipStopped = false;
      let shutdownSettled = false;
      const manager = new TerminalManager({
        shutdownTimeoutMs: 20,
        spawnTerminal: vi.fn(() => terminal.pty),
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => true,
        }),
      });
      const owner = {} as WebSocket;
      manager.createProcess(
        owner,
        process.cwd(),
        "provider-cli",
        [],
        {},
        80,
        24,
      );

      const shutdown = manager.disposeAll(Date.now() + 100).finally(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();
      terminal.emitExit({ exitCode: 0, signal: 0 });
      await vi.advanceTimersByTimeAsync(20);

      expect(shutdownSettled).toBe(false);
      ownershipStopped = true;
      await vi.advanceTimersByTimeAsync(10);

      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses graceful payload retirement only while replacing a Darwin shell", async () => {
    vi.useFakeTimers();
    try {
      const replacedTerminal = fakeTerminal(100);
      const replacementTerminal = fakeTerminal(101);
      let ownershipStopped = false;
      const requestPayloadExit = vi.fn(() => true);
      const requestGuardianStop = vi.fn(() => true);
      const spawnTerminal = vi.fn()
        .mockReturnValueOnce(replacedTerminal.pty)
        .mockReturnValueOnce(replacementTerminal.pty);
      const owner = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
      } as unknown as WebSocket;
      const manager = new TerminalManager({
        platform: "darwin",
        preserveDarwinShellOnReplacement: false,
        shutdownTimeoutMs: 100,
        spawnTerminal,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestPayloadExit,
          requestGuardianStop,
          waitForGuardianStop: async () => true,
        }),
      });
      const terminalId = manager.create(owner, process.cwd(), 80, 24);

      const replacement = manager.replaceProcess(
        owner,
        terminalId,
        process.cwd(),
        "provider-cli",
        ["resume", "session-id"],
        {},
        80,
        24,
      );
      await Promise.resolve();
      replacedTerminal.emitExit({ exitCode: 0, signal: 0 });
      await vi.advanceTimersByTimeAsync(20);

      expect(requestPayloadExit).toHaveBeenCalledOnce();
      expect(requestGuardianStop).not.toHaveBeenCalled();
      expect(spawnTerminal).toHaveBeenCalledOnce();

      ownershipStopped = true;
      await vi.advanceTimersByTimeAsync(10);
      await expect(replacement).resolves.toEqual(expect.any(String));
      expect(requestGuardianStop).not.toHaveBeenCalled();
      expect(spawnTerminal).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never requests graceful replacement exit for non-Darwin local shells", async () => {
    const replacedTerminal = fakeTerminal(100);
    const replacementTerminal = fakeTerminal(101);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
      terminateProcessTree: async () => true,
    });
    const terminalId = manager.create(owner, process.cwd(), 80, 24);

    await manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );

    expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
  });

  it("shares graceful replacement teardown with concurrent runtime shutdown", async () => {
    const replacedTerminal = fakeTerminal(100);
    const replacementTerminal = fakeTerminal(101);
    let ownershipStopped = false;
    const onExit = vi.fn();
    const requestPayloadExit = vi.fn(() => true);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "darwin",
      preserveDarwinShellOnReplacement: false,
      shutdownTimeoutMs: 100,
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => ownershipStopped,
        releaseIfGroupExited: (signal) => {
          if (signal === 0) ownershipStopped = true;
        },
        requestPayloadExit,
        requestGuardianStop: () => true,
        waitForGuardianStop: async () => true,
      }),
    });
    const terminalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
      onExit,
    );

    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );
    const shutdown = manager.disposeAll(Date.now() + 50);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestPayloadExit).toHaveBeenCalledOnce();
    expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
    replacedTerminal.emitExit({ exitCode: 0, signal: 0 });

    await expect(shutdown).resolves.toBeUndefined();
    await expect(replacement).rejects.toThrow("terminal service is stopping");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(spawnTerminal).toHaveBeenCalledOnce();
    expect(owner.send).not.toHaveBeenCalled();
  });

  it("preserves the stable terminal identity when its replacement cannot spawn", async () => {
    const terminal = fakeTerminal();
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(terminal.pty)
      .mockImplementationOnce(() => {
        throw new Error("spawn failed");
      });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
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

    await expect(manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    )).rejects.toThrow("Unable to start a terminal");
    expect(() => manager.input(owner, terminalId, "closed")).toThrow(
      "Terminal not found",
    );
    expect(owner.send).not.toHaveBeenCalled();
  });

  it("blocks a scoped replacement shell until failed cleanup is retried successfully", async () => {
    const first = fakeTerminal(101);
    const second = fakeTerminal(102);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    let ownershipStopped = false;
    const terminateProcessTree = vi.fn(async () => true);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(first.pty)
      .mockReturnValueOnce(second.pty);
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
      terminateProcessTree,
      shutdownTimeoutMs: 5,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => ownershipStopped,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop: () => false,
        waitForGuardianStop: async () => true,
      }),
    });
    const scope = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
    };
    const terminalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    );

    await expect(manager.replace(
      owner,
      terminalId,
      process.cwd(),
      80,
      24,
    )).rejects.toThrow("ownership claim could not be retired");
    expect(() => manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    )).toThrow("Retry closing it");
    expect(spawnTerminal).toHaveBeenCalledOnce();

    manager.disposeOwner(owner);
    const reconnectedOwner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    expect(() => manager.attach(
      reconnectedOwner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
    )).toThrow(/(?:could not be retired|has not been confirmed stopped)/u);

    ownershipStopped = true;
    await expect(manager.close(reconnectedOwner, terminalId)).resolves.toBeUndefined();
    expect(manager.create(
      reconnectedOwner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    )).toBeTruthy();
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
  });

  it("does not transfer cleanup ownership during a healthy replacement", async () => {
    const first = fakeTerminal(111);
    const second = fakeTerminal(112);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(first.pty)
      .mockReturnValueOnce(second.pty);
    let settleTermination!: (confirmed: boolean) => void;
    const termination = new Promise<boolean>((resolve) => {
      settleTermination = resolve;
    });
    const terminateProcessTree = vi.fn(async () => await termination);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const reconnectingOwner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "linux",
      spawnTerminal,
      terminateProcessTree,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => true,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop: () => false,
        waitForGuardianStop: async () => true,
      }),
    });
    const scope = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
    };
    const terminalId = manager.create(
      owner,
      process.cwd(),
      80,
      24,
      undefined,
      undefined,
      scope,
    );
    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      [],
      {},
      80,
      24,
    );
    await vi.waitFor(() => expect(terminateProcessTree).toHaveBeenCalledOnce());

    expect(() => manager.attach(
      reconnectingOwner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
    )).toThrow("still stopping");
    await expect(manager.close(reconnectingOwner, terminalId)).rejects.toThrow(
      "Terminal not found",
    );

    settleTermination(true);
    await expect(replacement).resolves.toBe(terminalId);
    expect(manager.attach(
      reconnectingOwner,
      terminalId,
      process.cwd(),
      scope,
      80,
      24,
    )).toEqual({ terminalId });
    expect(() => manager.input(owner, terminalId, "stale")).toThrow(
      "Terminal not found",
    );
    expect(() => manager.input(reconnectingOwner, terminalId, "live"))
      .not.toThrow();
  });

  it("does not spawn a replacement after runtime terminal shutdown begins", async () => {
    const terminals = [fakeTerminal(200), fakeTerminal(201)];
    const spawnTerminal = vi.fn(() =>
      terminals[spawnTerminal.mock.calls.length - 1]!.pty);
    let confirmStopped!: (confirmed: boolean) => void;
    const stopped = new Promise<boolean>((resolve) => {
      confirmStopped = resolve;
    });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      spawnTerminal,
      terminateProcessTree: async () => await stopped,
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
    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );
    const shutdown = manager.disposeAll();

    expect(spawnTerminal).toHaveBeenCalledOnce();
    confirmStopped(true);

    await expect(replacement).rejects.toThrow("terminal service is stopping");
    await expect(shutdown).resolves.toBeUndefined();
    expect(spawnTerminal).toHaveBeenCalledOnce();
  });

  it("does not replace a terminal from another project workspace", async () => {
    const terminal = fakeTerminal();
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => terminal.pty),
    });
    const owner = {} as WebSocket;
    const terminalId = manager.createProcess(
      owner,
      "/workspace/primary",
      "test-shell",
      [],
      {},
      80,
      24,
    );

    await expect(manager.replaceProcess(
      owner,
      terminalId,
      "/workspace/secondary",
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    )).rejects.toThrow("does not belong to this project workspace");
    expect(terminal.pty.write).not.toHaveBeenCalled();
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
        await waitFor("the detached terminal child PID", () => {
          if (!existsSync(pidPath)) return false;
          const observedPid = Number(readFileSync(pidPath, "utf8"));
          if (!Number.isInteger(observedPid) || observedPid <= 1) return false;
          childPid = observedPid;
          return true;
        });
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

  it("starts the guarded exit deadline after pending admission consumes stop", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let settleGuardianStop!: (confirmed: boolean) => void;
      const guardianStop = new Promise<boolean>((resolve) => {
        settleGuardianStop = resolve;
      });
      let ownershipStopped = false;
      const requestGuardianStop = vi.fn(() => true);
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop,
          waitForGuardianStop: async () => await guardianStop,
        }),
      });
      const owner = {} as WebSocket;
      const terminalId = manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      let closeSettled = false;
      const closing = manager.closeManaged(terminalId).finally(() => {
        closeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(requestGuardianStop).toHaveBeenCalledOnce();
      expect(closeSettled).toBe(false);

      ownershipStopped = true;
      terminal.emitExit();
      settleGuardianStop(true);
      await expect(closing).resolves.toBe(true);
      await expect(manager.disposeAll()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks replacement when a closed guardian retains uncertain ownership", async () => {
    const replacedTerminal = fakeTerminal(42);
    const replacementTerminal = fakeTerminal(43);
    const releaseIfGroupExited = vi.fn();
    const confirmStopped = vi.fn(() => false);
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const manager = new TerminalManager({
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => {
        const process = spawnProcess();
        if (process.pid === replacedTerminal.pty.pid) {
          return {
            process,
            confirmStopped,
            releaseIfGroupExited,
            requestGuardianStop: () => true,
            waitForGuardianStop: async () => true,
          };
        }
        return {
          process,
          confirmStopped: () => true,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => false,
        };
      },
      terminateProcessTree: async () => true,
    });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const terminalId = manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    );

    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );
    replacedTerminal.emitExit({ exitCode: 0, signal: 31 });

    await expect(replacement).rejects.toThrow(
      "A terminal process ownership claim could not be retired during runtime shutdown.",
    );
    expect(spawnTerminal).toHaveBeenCalledOnce();
    expect(releaseIfGroupExited).toHaveBeenCalledWith(31);
    expect(confirmStopped).toHaveBeenCalled();
    expect(replacedTerminal.pty.write).not.toHaveBeenCalled();
  });

  it("replaces a normally closed guardian after its durable claim retires", async () => {
    const replacedTerminal = fakeTerminal(42);
    const replacementTerminal = fakeTerminal(43);
    let ownershipStopped = false;
    const spawnTerminal = vi.fn()
      .mockReturnValueOnce(replacedTerminal.pty)
      .mockReturnValueOnce(replacementTerminal.pty);
    const manager = new TerminalManager({
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => {
        const process = spawnProcess();
        if (process.pid === replacedTerminal.pty.pid) {
          return {
            process,
            confirmStopped: () => ownershipStopped,
            releaseIfGroupExited: (signal) => {
              if (signal === 0) ownershipStopped = true;
            },
            requestGuardianStop: () => true,
            waitForGuardianStop: async () => true,
          };
        }
        return {
          process,
          confirmStopped: () => true,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => false,
          waitForGuardianStop: async () => false,
        };
      },
    });
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const terminalId = manager.createProcess(
      owner,
      process.cwd(),
      "test-shell",
      [],
      {},
      80,
      24,
    );

    const replacement = manager.replaceProcess(
      owner,
      terminalId,
      process.cwd(),
      "provider-cli",
      ["resume", "session-id"],
      {},
      80,
      24,
    );
    replacedTerminal.emitExit({ exitCode: 0, signal: 0 });

    await expect(replacement).resolves.toEqual(expect.any(String));
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
  });

  it("tightens an already-closing guardian admission to the runtime deadline", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      const guardianStop = new Promise<boolean>(() => undefined);
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => false,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => await guardianStop,
        }),
      });
      const owner = {} as WebSocket;
      const terminalId = manager.createProcess(
        owner,
        process.cwd(),
        "test-shell",
        [],
        {},
        80,
        24,
      );

      const earlyClose = manager.closeManaged(terminalId);
      const rejectedEarlyClose = expect(earlyClose).rejects.toThrow(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );
      await Promise.resolve();
      const shutdown = manager.disposeAll(Date.now() + 50);
      const rejectedShutdown = expect(shutdown).rejects.toThrow(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );

      await vi.advanceTimersByTimeAsync(49);
      await vi.advanceTimersByTimeAsync(1);
      await rejectedShutdown;
      await rejectedEarlyClose;
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows delayed admission when stop, exit, and retirement fit the runtime budget", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let settleGuardianStop!: (confirmed: boolean) => void;
      const guardianStop = new Promise<boolean>((resolve) => {
        settleGuardianStop = resolve;
      });
      let ownershipStopped = false;
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => await guardianStop,
        }),
      });
      const owner = {} as WebSocket;
      manager.createProcess(owner, process.cwd(), "test-shell", [], {}, 80, 24);

      const shutdown = manager.disposeAll(Date.now() + 100);
      await vi.advanceTimersByTimeAsync(30);
      ownershipStopped = true;
      terminal.emitExit();
      settleGuardianStop(true);

      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a fresh exit timeout after admission consumes the runtime budget", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let settleGuardianStop!: (confirmed: boolean) => void;
      const guardianStop = new Promise<boolean>((resolve) => {
        settleGuardianStop = resolve;
      });
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => false,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop: () => true,
          waitForGuardianStop: async () => await guardianStop,
        }),
      });
      const owner = {} as WebSocket;
      manager.createProcess(owner, process.cwd(), "test-shell", [], {}, 80, 24);

      const shutdown = manager.disposeAll(Date.now() + 50);
      const rejected = expect(shutdown).rejects.toThrow(
        "A terminal process tree could not be confirmed stopped during runtime shutdown.",
      );
      await vi.advanceTimersByTimeAsync(45);
      settleGuardianStop(true);
      await vi.advanceTimersByTimeAsync(4);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts already-settled guardian work after a delayed event-loop turn", async () => {
    vi.useFakeTimers();
    try {
      const terminal = fakeTerminal();
      let ownershipStopped = false;
      const requestGuardianStop = vi.fn(() => true);
      const waitForGuardianStop = vi.fn(async () => true);
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => terminal.pty),
        shutdownTimeoutMs: 20,
        spawnOwnedTerminalProcess: (spawnProcess) => ({
          process: spawnProcess(),
          confirmStopped: () => ownershipStopped,
          releaseIfGroupExited: () => undefined,
          requestGuardianStop,
          waitForGuardianStop,
        }),
      });
      const owner = {} as WebSocket;
      manager.createProcess(owner, process.cwd(), "test-shell", [], {}, 80, 24);

      const shutdown = manager.disposeAll(Date.now() + 10);
      ownershipStopped = true;
      terminal.emitExit();
      vi.setSystemTime(Date.now() + 100);
      await vi.advanceTimersByTimeAsync(0);

      await expect(shutdown).resolves.toBeUndefined();
      expect(requestGuardianStop).toHaveBeenCalledOnce();
      expect(waitForGuardianStop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
