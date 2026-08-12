import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  providerMaintenanceEnvironment,
  runProviderMaintenanceAction,
} from "../../src/server/provider/maintenance-runner";
import type { ProviderMaintenanceUpdateAction } from "../../src/server/provider/maintenance-capabilities";

function action(
  input: Partial<ProviderMaintenanceUpdateAction> = {},
): ProviderMaintenanceUpdateAction {
  return {
    executable: "/tools/claude",
    args: ["update"],
    lockKey: "provider-managed:claude",
    installMethod: "provider-managed",
    label: "Update Claude",
    ...input,
  };
}

function fakeChild(
  onKill?: (signal: NodeJS.Signals, child: ChildProcessWithoutNullStreams) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid: 4_242,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      onKill?.(signal, child);
      return true;
    }),
  });
  return child;
}

function fakeTaskkill() {
  const taskkill = new EventEmitter() as EventEmitter & {
    unref: ReturnType<typeof vi.fn>;
  };
  taskkill.unref = vi.fn();
  return taskkill;
}

describe("provider maintenance runner", () => {
  it("uses argv spawning, a secret-free environment and sanitized bounded progress", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: SpawnOptionsWithoutStdio;
    }> = [];
    const progress: Array<string | null> = [];
    const terminateProcessTree = vi.fn(async () => true);
    const spawn = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        (child.stdout as PassThrough).write("api_key=super-secret-value\n");
        (child.stderr as PassThrough).write("updated from /Users/ada/project\n");
        child.emit("close", 0, null);
      });
      return child;
    });
    const result = await runProviderMaintenanceAction(action(), {
      environment: {
        PATH: "/tools",
        HOME: "/Users/ada",
        OPENAI_API_KEY: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
      },
      signal: new AbortController().signal,
      spawn,
      terminateProcessTree,
      onProgress: (value) => progress.push(value.output),
    });

    expect(result.status).toBe("succeeded");
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.output).toContain("[redacted]");
    expect(result.output).not.toContain("api_key");
    expect(result.output).not.toContain("super-secret-value");
    expect(result.output).not.toContain("/Users/ada");
    expect(progress.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/tools/claude",
      args: ["update"],
      options: { shell: false, windowsHide: true },
    });
    expect(calls[0]?.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(calls[0]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("routes Windows npm.cmd through a quoted cmd.exe invocation without generic shell mode", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: SpawnOptionsWithoutStdio;
    }> = [];
    const spawn = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    const result = await runProviderMaintenanceAction(action({
      executable: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\npm.cmd",
      args: ["install", "-g", "@openai/codex@latest"],
      lockKey: "package-manager:npm-global",
      installMethod: "npm-global",
    }), {
      platform: "win32",
      environment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Tools",
        PATHEXT: ".EXE;.CMD",
      },
      signal: new AbortController().signal,
      spawn,
    });

    expect(result.status).toBe("succeeded");
    expect(calls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
    ]);
    expect(calls[0]?.args[4]).toContain("@openai/codex@latest");
    expect(calls[0]?.options).toMatchObject({
      detached: false,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("cancels the owned process and reports cancellation", async () => {
    const abort = new AbortController();
    const child = fakeChild((signal, active) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => active.emit("close", null, "SIGTERM"));
      }
    });
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      spawn: () => child,
      terminateProcessTree: async () => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      },
    });
    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL and settles when a child ignores cancellation", async () => {
    const abort = new AbortController();
    const child = fakeChild();
    const terminateProcessTree = vi.fn(async (
      _ownedChild,
      force: boolean,
    ) => {
      if (!force) return false;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      killGraceMs: 100,
      spawn: () => child,
      terminateProcessTree,
    });
    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGKILL",
    });
    expect(terminateProcessTree.mock.calls.map(([, force]) => force)).toEqual([
      false,
      true,
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not publish cancellation before the owned cleanup barrier settles", async () => {
    const abort = new AbortController();
    const child = fakeChild();
    let confirmTermination!: (confirmed: boolean) => void;
    const termination = new Promise<boolean>((resolve) => {
      confirmTermination = resolve;
    });
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      spawn: () => child,
      terminateProcessTree: async () => await termination,
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    abort.abort();
    child.emit("close", null, "SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    confirmTermination(true);
    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
    });
  });

  it("reports unconfirmed owned cleanup as a failed maintenance result", async () => {
    const abort = new AbortController();
    const terminateProcessTree = vi.fn(async (
      _child: unknown,
      _force: boolean,
    ) => false);
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      spawn: () => fakeChild(),
      terminateProcessTree,
    });

    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "failed",
      exitCode: null,
      signal: null,
      message: "Provider update process tree could not be confirmed stopped.",
      cleanupConfirmed: false,
    });
    expect(terminateProcessTree.mock.calls.map(([, force]) => force)).toEqual([
      false,
      true,
    ]);
  });

  it("cancels a Windows batch updater by terminating the cmd.exe process tree", async () => {
    const abort = new AbortController();
    const child = fakeChild();
    const updateSpawn = vi.fn(() => child);
    const taskkillSpawn = vi.fn(() => {
      const taskkill = fakeTaskkill();
      queueMicrotask(() => {
        taskkill.emit("close", 0);
        child.emit("close", null, "SIGTERM");
      });
      return taskkill;
    });
    const promise = runProviderMaintenanceAction(action({
      executable: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\npm.cmd",
      args: ["install", "-g", "@openai/codex@latest"],
      lockKey: "package-manager:npm-global",
      installMethod: "npm-global",
    }), {
      platform: "win32",
      environment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Tools",
        PATHEXT: ".EXE;.CMD",
      },
      signal: abort.signal,
      spawn: updateSpawn,
      processLifecycle: {
        platform: "win32",
        spawnProcess: taskkillSpawn as never,
      },
    });

    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
    });
    expect(updateSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      expect.any(Array),
      expect.objectContaining({
        detached: false,
        shell: false,
        windowsVerbatimArguments: true,
      }),
    );
    expect(taskkillSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "4242", "/t"],
      {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-terminates Windows batch descendants after an update timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const taskkillSpawn = vi.fn(() => {
        const taskkill = fakeTaskkill();
        const attempt = taskkillSpawn.mock.calls.length;
        queueMicrotask(() => {
          taskkill.emit("close", 0);
          if (attempt === 2) child.emit("close", null, "SIGKILL");
        });
        return taskkill;
      });
      const promise = runProviderMaintenanceAction(action({
        executable: "C:\\Tools\\update-provider.bat",
      }), {
        platform: "win32",
        environment: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          SystemRoot: "C:\\Windows",
          PATH: "C:\\Tools",
          PATHEXT: ".EXE;.CMD;.BAT",
        },
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        killGraceMs: 100,
        spawn: () => child,
        processLifecycle: {
          platform: "win32",
          spawnProcess: taskkillSpawn as never,
        },
      });

      await vi.advanceTimersByTimeAsync(1_300);

      await expect(promise).resolves.toMatchObject({
        status: "timed-out",
        signal: "SIGKILL",
      });
      expect(taskkillSpawn).toHaveBeenNthCalledWith(
        1,
        "C:\\Windows\\System32\\taskkill.exe",
        ["/pid", "4242", "/t"],
        expect.objectContaining({ shell: false }),
      );
      expect(taskkillSpawn).toHaveBeenNthCalledWith(
        2,
        "C:\\Windows\\System32\\taskkill.exe",
        ["/pid", "4242", "/t", "/f"],
        expect.objectContaining({ shell: false }),
      );
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the environment required for the supervised updater", () => {
    expect(providerMaintenanceEnvironment({
      PATH: "/tools",
      HOME: "/home/ada",
      CURSOR_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      HTTPS_PROXY: "https://proxy.example",
    })).toEqual({
      CI: "1",
      NO_COLOR: "1",
      HOME: "/home/ada",
      PATH: "/tools",
    });
  });
});
